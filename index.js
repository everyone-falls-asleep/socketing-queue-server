import Fastify from "fastify";
import fastifyEnv from "@fastify/env";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyRedis from "@fastify/redis";
import fastifyPostgres from "@fastify/postgres";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import jwt from "jsonwebtoken";
import { instrument } from "@socket.io/admin-ui";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const schema = {
  type: "object",
  required: [
    "PORT",
    "JWT_SECRET",
    "JWT_SECRET_FOR_ENTRANCE",
    "CACHE_HOST",
    "CACHE_PORT",
    "DB_URL",
  ],
  properties: {
    PORT: {
      type: "integer",
    },
    JWT_SECRET: {
      type: "string",
    },
    JWT_SECRET_FOR_ENTRANCE: {
      type: "string",
    },
    CACHE_HOST: {
      type: "string",
    },
    CACHE_PORT: {
      type: "integer",
    },
    DB_URL: {
      type: "string",
    },
  },
};

const fastify = Fastify({
  trustProxy: true,
  logger: true,
});

await fastify.register(fastifyEnv, {
  schema,
  dotenv: true,
});

await fastify.register(cors, {
  origin: "*",
});

await fastify.register(fastifyRedis, {
  host: fastify.config.CACHE_HOST,
  port: fastify.config.CACHE_PORT,
  family: 4,
});

await fastify.register(fastifyPostgres, {
  connectionString: fastify.config.DB_URL,
});

await fastify.register(fastifyStatic, {
  root: join(__dirname, "dist"),
  prefix: "/admin",
  redirect: true,
});

fastify.get("/liveness", (request, reply) => {
  reply.send({ status: "ok", message: "The server is alive." });
});

fastify.get("/readiness", async (request, reply) => {
  try {
    let redisStatus = { status: "disconnected", message: "" };
    let dbStatus = { status: "disconnected", message: "" };

    // Redis 상태 확인
    try {
      const pingResult = await fastify.redis.ping();
      if (pingResult === "PONG") {
        redisStatus = { status: "connected", message: "Redis is available." };
      } else {
        redisStatus.message = "Redis responded, but not with 'PONG'.";
      }
    } catch (error) {
      redisStatus.message = `Redis connection failed: ${error.message}`;
    }

    // PostgreSQL 상태 확인
    try {
      const client = await fastify.pg.connect();
      if (client) {
        dbStatus = {
          status: "connected",
          message: "PostgreSQL is connected and responsive.",
        };
        client.release(); // 연결 반환
      }
    } catch (error) {
      dbStatus.message = `PostgreSQL connection failed: ${error.message}`;
    }

    // 모든 상태가 정상일 때
    if (redisStatus.status === "connected" && dbStatus.status === "connected") {
      reply.send({
        status: "ok",
        message: "The server is ready.",
        redis: redisStatus,
        database: dbStatus,
      });
    } else {
      // 하나라도 비정상일 때
      reply.status(500).send({
        status: "error",
        message: "The server is not fully ready. See details below.",
        redis: redisStatus,
        database: dbStatus,
      });
    }
  } catch (unexpectedError) {
    // 예기치 못한 오류 처리
    fastify.log.error(
      "Readiness check encountered an unexpected error:",
      unexpectedError
    );
    reply.status(500).send({
      status: "error",
      message: "Unexpected error occurred during readiness check.",
      error: unexpectedError.message,
    });
  }
});

// const pubClient = new Redis();

const pubClient = new Redis({
  host: fastify.config.CACHE_HOST,
  port: fastify.config.CACHE_PORT,
});
const subClient = pubClient.duplicate();

const io = new Server(fastify.server, {
  cors: {
    origin: "*",
    methods: "*",
    credentials: true,
  },
  transports: ["websocket"],
});

io.adapter(createAdapter(pubClient, subClient));

instrument(io, {
  auth: {
    type: "basic",
    username: "admin",
    password: "$2a$10$QWUn5UhhE3eSAu2a95fVn.PRVaamlJlJBMeT7viIrvgvfCOeUIV2W",
  },
  mode: "development",
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("Authentication error"));
  }

  try {
    const decoded = jwt.verify(token, fastify.config.JWT_SECRET);
    socket.data.user = decoded;
    next();
  } catch (err) {
    return next(new Error("Authentication error"));
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scanForKeys(pattern) {
  let cursor = "0";
  const keys = [];
  do {
    const [newCursor, foundKeys] = await fastify.redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100
    );
    cursor = newCursor;
    keys.push(...foundKeys);
  } while (cursor !== "0");
  return keys;
}

async function addClientToQueue(queueName, socketId) {
  await fastify.redis.rpush(queueName, socketId);
}

async function removeClientFromQueue(queueName, socketId) {
  await fastify.redis.lrem(queueName, 0, socketId);
  const queueLength = await fastify.redis.llen(queueName);
  if (queueLength === 0) {
    await fastify.redis.del(queueName); // 큐가 비어 있으면 삭제
  }
}

async function getQueue(queueName) {
  return await fastify.redis.lrange(queueName, 0, -1);
}

async function broadcastQueueUpdate(queueName) {
  const queue = await getQueue(queueName);
  queue.forEach((socketId, index) => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit("updateQueue", {
        yourPosition: index + 1,
        totalWaiting: queue.length,
      });
    }
  });
}

io.on("connection", (socket) => {
  fastify.log.info(`New client connected: ${socket.id}`);

  socket.on("joinQueue", async ({ eventId, eventDateId }) => {
    if (!eventId || !eventDateId) {
      socket.emit("error", { message: "Invalid queue parameters." });
      socket.disconnect(true);
      return;
    }

    const sub = socket.data.user?.sub;
    if (!sub) {
      socket.emit("error", { message: "Invalid user data." });
      socket.disconnect(true);
      return;
    }

    const queueName = `${eventId}_${eventDateId}`;

    // 중복 연결 방지
    const queue = await getQueue(queueName);
    if (queue.includes(socket.id)) {
      socket.emit("error", { message: "Already in the queue." });
      socket.disconnect(true);
      return;
    }

    // 큐에 유저 추가
    await addClientToQueue(queueName, socket.id);
    socket.join(queueName);
    await broadcastQueueUpdate(queueName);

    fastify.log.info(`Client ${socket.id} joined queue: ${queueName}`);

    try {
      await sleep(4000);

      const token = jwt.sign(
        {
          sub,
          eventId,
          eventDateId,
        },
        fastify.config.JWT_SECRET_FOR_ENTRANCE,
        {
          expiresIn: 600,
        }
      );

      socket.emit("tokenIssued", { token });
      fastify.log.info(`Token issued to client ${socket.id}`);

      // 큐에서 제거 및 연결 종료
      await removeClientFromQueue(queueName, socket.id);
      await broadcastQueueUpdate(queueName);

      socket.disconnect(true);
    } catch (err) {
      fastify.log.error(
        `Error processing queue for ${socket.id}: ${err.message}`
      );
      socket.emit("error", { message: "Internal server error." });
      socket.disconnect(true);
    }
  });

  socket.on("disconnect", async () => {
    const keys = await scanForKeys("queue:*");
    for (const queueName of keys) {
      const queue = await getQueue(queueName);
      if (queue.includes(socket.id)) {
        await removeClientFromQueue(queueName, socket.id);
        await broadcastQueueUpdate(queueName);
        break;
      }
    }
  });
});

const startServer = async () => {
  try {
    const address = await fastify.listen({
      port: fastify.config.PORT,
      host: "0.0.0.0",
    });

    fastify.log.info(`Server is now listening on ${address}`);

    if (process.send) {
      process.send("ready");
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

let shutdownInProgress = false; // 중복 호출 방지 플래그

async function gracefulShutdown(signal) {
  if (shutdownInProgress) {
    fastify.log.warn(
      `Shutdown already in progress. Ignoring signal: ${signal}`
    );
    return;
  }
  shutdownInProgress = true; // 중복 호출 방지

  fastify.log.info(`Received signal: ${signal}. Starting graceful shutdown...`);

  try {
    io.sockets.sockets.forEach((socket) => {
      socket.disconnect(true);
    });
    fastify.log.info("All Socket.IO connections have been closed.");

    await fastify.close();
    fastify.log.info("Fastify server has been closed.");

    // 기타 필요한 종료 작업 (예: DB 연결 해제)
    // await database.disconnect();
    fastify.log.info("Additional cleanup tasks completed.");

    fastify.log.info("Graceful shutdown complete. Exiting process...");
    process.exit(0);
  } catch (error) {
    fastify.log.error("Error occurred during graceful shutdown:", error);
    process.exit(1);
  }
}

startServer();

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
