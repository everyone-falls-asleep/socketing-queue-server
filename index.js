import Fastify from "fastify";
import fastifyEnv from "@fastify/env";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyRedis from "@fastify/redis";
import fastifyPostgres from "@fastify/postgres";
import fastifyRabbit from "fastify-rabbitmq";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import jwt from "jsonwebtoken";
import { instrument } from "@socket.io/admin-ui";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_ROOM_CONNECTIONS = 100; // 각 Room의 최대 접속자 수

const schema = {
  type: "object",
  required: [
    "PORT",
    "JWT_SECRET",
    "JWT_SECRET_FOR_ENTRANCE",
    "CACHE_HOST",
    "CACHE_PORT",
    "DB_URL",
    "MQ_URL",
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
    MQ_URL: {
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

await fastify.register(fastifyRabbit, {
  connection: fastify.config.MQ_URL,
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
    let rabbitStatus = { status: "disconnected", message: "" };

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

    // RabbitMQ 상태 확인
    try {
      if (fastify.rabbitmq.ready) {
        rabbitStatus = {
          status: "connected",
          message: "RabbitMQ is connected and operational.",
        };
      } else {
        rabbitStatus.message = "RabbitMQ is not connected.";
      }
    } catch (error) {
      rabbitStatus.message = `RabbitMQ connection check failed: ${error.message}`;
    }

    // 모든 상태가 정상일 때
    if (
      redisStatus.status === "connected" &&
      dbStatus.status === "connected" &&
      rabbitStatus.status === "connected"
    ) {
      reply.send({
        status: "ok",
        message: "The server is ready.",
        redis: redisStatus,
        database: dbStatus,
        rabbitmq: rabbitStatus,
      });
    } else {
      // 하나라도 비정상일 때
      reply.status(500).send({
        status: "error",
        message: "The server is not fully ready. See details below.",
        redis: redisStatus,
        database: dbStatus,
        rabbitmq: rabbitStatus,
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

const pubClient = fastify.redis.duplicate();
const subClient = fastify.redis.duplicate();

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

  const socketsInRoom = await io.in(queueName).fetchSockets();

  socketsInRoom.forEach((socket) => {
    const position = queue.indexOf(socket.id) + 1;
    socket.emit("updateQueue", {
      yourPosition: position,
      totalWaiting: queue.length,
    });
  });
}

async function getRabbitMQQueueLength(queueName) {
  let rabbitMQQueueLength = 0;
  let channel = null;
  try {
    // RabbitMQ 채널 생성
    channel = await fastify.rabbitmq.acquire();

    // 큐 선언 또는 확인 (passive=true 옵션은 생략 가능)
    const queueInfo = await channel.queueDeclare({
      queue: queueName,
      durable: true,
    });

    // 메시지 수 가져오기
    rabbitMQQueueLength = queueInfo.messageCount;
  } catch (err) {
    if (err.replyCode === 404) {
      // 큐가 없으면 메시지 수는 0
      rabbitMQQueueLength = 0;
    } else {
      throw err; // 에러를 상위로 전달하여 호출부에서 처리
    }
  } finally {
    if (channel) {
      // 채널 닫기
      await channel.close();
    }
  }
  return rabbitMQQueueLength;
}

async function waitForMessage(queueName) {
  // RabbitMQ 채널 생성
  const channel = await fastify.rabbitmq.acquire();

  // 큐가 없으면 선언
  await channel.queueDeclare({ queue: queueName, durable: true });

  // 메시지 대기
  return new Promise((resolve, reject) => {
    try {
      channel.basicConsume(
        queueName,
        (msg) => {
          if (msg) {
            channel.basicAck(msg); // 메시지 확인
            const content = msg.body.toString(); // 메시지 내용 파싱
            resolve(content); // 메시지를 반환
          }
        },
        { noAck: false } // noAck=false로 메시지 확인 활성화
      );
    } catch (error) {
      reject(error);
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

    const roomName = `${eventId}_${eventDateId}`;
    const queueName = `queue:${roomName}`;

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
      const room = io.sockets.adapter.rooms.get(roomName);
      const connectedClientsCount = room ? room.size : 0;

      const mqLength = await getRabbitMQQueueLength();

      if (mqLength > 0 || connectedClientsCount >= MAX_ROOM_CONNECTIONS) {
        await waitForMessage(queueName); // 큐에서 대기
      }

      const token = jwt.sign(
        {
          sub,
          eventId,
          eventDateId,
        },
        fastify.config.JWT_SECRET_FOR_ENTRANCE,
        {
          expiresIn: 600, // 10분
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
    const port = Number(fastify.config.PORT);
    const address = await fastify.listen({ port, host: "0.0.0.0" });

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
