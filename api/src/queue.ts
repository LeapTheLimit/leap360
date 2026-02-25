import { Queue } from "bullmq";
import IORedis from "ioredis";
import * as dotenv from "dotenv";

dotenv.config();

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const redisConnection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
});

export const traceQueue = new Queue("trace_events_raw", {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 1000,
        },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
});
