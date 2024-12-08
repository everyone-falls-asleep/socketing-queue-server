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
  adapter: createAdapter(pubClient, subClient),
});

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

async function addClientToQueue(queueName, socketId, userId) {
  const obj = { socketId, userId };
  await fastify.redis.rpush(queueName, JSON.stringify(obj));
}

async function removeClientFromQueue(queueName, socketId, userId) {
  const obj = { socketId, userId };
  return await fastify.redis.lrem(queueName, 0, JSON.stringify(obj)); // 삭제된 요소의 개수 반환
}

async function getQueue(queueName) {
  const rawQueue = await fastify.redis.lrange(queueName, 0, -1);
  return rawQueue
    .map((item) => {
      try {
        return JSON.parse(item);
      } catch (err) {
        console.error(`Failed to parse item in queue "${queueName}":`, err);
        return null; // 파싱 실패 시 null로 반환 (필요에 따라 처리 방식 변경 가능)
      }
    })
    .filter((item) => item !== null); // null 값 제거
}

async function broadcastQueueUpdate(queueName) {
  const queue = await getQueue(queueName);
  const socketsInRoom = await getSocketsInRoom(queueName);
  socketsInRoom.forEach((socket) => {
    const position = queue.findIndex((item) => item.socketId === socket.id) + 1;
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

async function getRoomUserCount(roomName) {
  const sockets = await io.in(roomName).fetchSockets();
  return sockets.length;
}

async function getSocketsInRoom(queueName) {
  return await io.in(queueName).fetchSockets();
}

async function getQueueLength(queueName) {
  try {
    return await fastify.redis.llen(queueName);
  } catch (err) {
    console.error("Redis error:", err);
    return -1;
  }
}

async function findIndexInQueue(queueName, socketId, userId) {
  const obj = { socketId, userId };
  const script = `
    local queue = redis.call('LRANGE', KEYS[1], 0, -1)
    local valueToFind = ARGV[1]

    for i, v in ipairs(queue) do
      if v == valueToFind then
        return i - 1 -- Convert to 0-based index
      end
    end

    return -1 -- Not found
  `;

  try {
    const index = await fastify.redis.eval(
      script,
      1,
      queueName,
      JSON.stringify(obj)
    );
    return index;
  } catch (err) {
    console.error("Redis error:", err);
    return -1;
  }
}

async function getFirstClientOfQueue(queueName) {
  try {
    return await fastify.redis.lindex(queueName, 0);
  } catch (err) {
    console.error("Redis error:", err);
    return null;
  }
}

async function popFirstClientOfQueue(queueName) {
  try {
    const rawItem = await fastify.redis.lpop(queueName);
    if (rawItem) {
      try {
        return JSON.parse(rawItem); // JSON 문자열을 객체로 변환
      } catch (parseError) {
        console.error(
          `Failed to parse item from queue "${queueName}":`,
          parseError
        );
        return null; // 파싱 실패 시 null 반환
      }
    } else {
      return null; // 리스트가 비어 있으면 null 반환
    }
  } catch (err) {
    console.error(`Redis error while popping from queue "${queueName}":`, err);
    return null;
  }
}

async function getAndPopIfNeeded(queueName) {
  const luaScript = `
    local queueName = KEYS[1]

    local queueLength = redis.call('LLEN', queueName)

    if queueLength > 0 then
        local firstClient = redis.call('LPOP', queueName)
        return {queueLength, firstClient}
    else
        return nil
    end
  `;

  try {
    const result = await fastify.redis.eval(luaScript, 1, queueName);

    if (result) {
      const [queueLength, firstClient] = result;
      return {
        queueLength,
        firstClient: firstClient ? JSON.parse(firstClient) : null,
      };
    } else {
      return null; // No client was popped
    }
  } catch (error) {
    throw new Error(`Error in getAndPopIfNeeded: ${error.message}`);
  }
}

async function issueToken(firstClient, roomName) {
  const TOKEN_TTL = 10;

  const token = jwt.sign(
    {
      sub: firstClient.userId,
      eventId,
      eventDateId,
    },
    fastify.config.JWT_SECRET_FOR_ENTRANCE,
    {
      expiresIn: 600, // 10분
    }
  );

  await fastify.redis.sadd(`issued_tokens:${roomName}`, token);
  await fastify.redis.setex(`token:${token}`, TOKEN_TTL, "issued");

  return token;
}

async function cleanupExpiredTokens(roomName) {
  const tokens = await fastify.redis.smembers(`issued_tokens:${roomName}`);
  for (const token of tokens) {
    const ttl = await fastify.redis.ttl(`token:${token}`);
    if (ttl === -2) {
      await fastify.redis.srem(`issued_tokens:${roomName}`, token);
    }
  }
}

const STREAM_KEY = "queue-messages";
const CONSUMER_GROUP = "queue-group";
const CONSUMER_NAME = `consumer-${process.pid}`; // Unique consumer name per instance

// Initialize the consumer group
async function initializeStream() {
  try {
    // Create consumer group if it doesn't exist
    await fastify.redis.xgroup(
      "CREATE",
      STREAM_KEY,
      CONSUMER_GROUP,
      "0",
      "MKSTREAM"
    );
    fastify.log.info(
      `Consumer group '${CONSUMER_GROUP}' created or already exists.`
    );
  } catch (err) {
    if (err.message.includes("BUSYGROUP")) {
      fastify.log.info(`Consumer group '${CONSUMER_GROUP}' already exists.`);
    } else {
      fastify.log.error("Error creating consumer group:", err);
      process.exit(1);
    }
  }
}

// Function to read messages from the stream
async function consumeStream() {
  while (true) {
    try {
      const response = await fastify.redis.xreadgroup(
        "GROUP",
        CONSUMER_GROUP,
        CONSUMER_NAME,
        "COUNT",
        10,
        "BLOCK",
        1000, // 1 seconds
        "STREAMS",
        STREAM_KEY,
        ">"
      );

      if (response) {
        const [stream, messages] = response[0];
        for (const [id, fields] of messages) {
          const eventId = fields[0];
          const eventDateId = fields[1];
          const roomName = `${eventId}_${eventDateId}`;
          const queueName = `queue:${roomName}`;

          await cleanupExpiredTokens(roomName);

          const issuedTokenCount = await fastify.redis.scard(
            `issued_tokens:${roomName}`
          );

          const connectedClientsCount = await getRoomUserCount(roomName);

          if (issuedTokenCount + connectedClientsCount < MAX_ROOM_CONNECTIONS) {
            const result = await getAndPopIfNeeded(queueName);

            if (result) {
              const { queueLength, firstClient } = result;

              fastify.log.info(
                `Notified client ${firstClient.socketId} it's their turn.`
              );

              const token = await issueToken(firstClient, roomName);

              io.to(firstClient.socketId).emit("tokenIssued", { token });
              fastify.log.info(
                `Token issued to client ${firstClient.socketId}`
              );

              io.of("/").adapter.disconnectSockets(
                {
                  rooms: new Set([firstClient.socketId]),
                  except: new Set(),
                }, // 필터링 기준
                true // underlying connection 닫기
              );
              console.log(
                `Socket with ID ${firstClient.socketId} has been disconnected.`
              );

              // Acknowledge the message
              await fastify.redis.xack(STREAM_KEY, CONSUMER_GROUP, id);
            }
          }
          // 업데이트된 큐 및 접속자 수 재확인
          await broadcastQueueUpdate(queueName);
        }
      }
    } catch (err) {
      console.error(err);
      // Optional: Implement retry logic or exit
    }
  }
}

// Start consuming the stream
await initializeStream();
consumeStream(); // Note: Not awaiting to allow it to run concurrently

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
    if ((await findIndexInQueue(queueName, socket.id)) != -1) {
      socket.emit("error", { message: "Already in the queue." });
      socket.disconnect(true);
      return;
    }

    try {
      // 큐에 유저 추가
      await addClientToQueue(queueName, socket.id, sub);
      socket.join(queueName);
      await broadcastQueueUpdate(queueName);

      fastify.log.info(`Client ${socket.id} joined queue: ${queueName}`);

      await fastify.redis.xadd(STREAM_KEY, "*", eventId, eventDateId);
    } catch (err) {
      fastify.log.error(
        `Error processing queue for ${socket.id}: ${err.message}`
      );
      socket.emit("error", { message: "Internal server error." });
      socket.disconnect(true);
    }
  });

  socket.on("disconnect", async () => {
    const sub = socket.data.user?.sub;
    const keys = await scanForKeys("queue:*");
    for (const queueName of keys) {
      if ((await removeClientFromQueue(queueName, socket.id, sub)) > 0) {
        await broadcastQueueUpdate(queueName);
        const [eventId, eventDateId] = queueName.split(":")[1].split("_");
        await fastify.redis.xadd(STREAM_KEY, "*", eventId, eventDateId);
        break;
      }
    }
  });
});

io.on("leave-room", async ({ room, id }) => {
  if (room != id) {
    const [eventId, eventDateId] = room.split("_");
    await fastify.redis.xadd(STREAM_KEY, "*", eventId, eventDateId);
  }
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
