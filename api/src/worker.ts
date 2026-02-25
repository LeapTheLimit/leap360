import { Worker, Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import * as dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

interface TraceJobData {
    project_id: string;
    service_name: string;
    agent_name?: string | null;
    run_id: string;
    provider: string;
    model: string;
    request: Record<string, any>;
    response: Record<string, any>;
    latency_ms: number;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    timestamp: string;
    error?: string | null;
}

const worker = new Worker<TraceJobData>(
    "trace_events_raw",
    async (job: Job<TraceJobData>) => {
        const data = job.data;

        // 1. Upsert service
        const service = await prisma.service.upsert({
            where: {
                projectId_name: {
                    projectId: data.project_id,
                    name: data.service_name,
                },
            },
            update: { lastSeenAt: new Date() },
            create: {
                projectId: data.project_id,
                name: data.service_name,
            },
        });

        // 2. Upsert agent (if provided)
        let agent: { id: string } | null = null;
        if (data.agent_name) {
            agent = await prisma.agent.upsert({
                where: {
                    projectId_serviceId_name: {
                        projectId: data.project_id,
                        serviceId: service.id,
                        name: data.agent_name,
                    },
                },
                update: { lastSeenAt: new Date() },
                create: {
                    projectId: data.project_id,
                    serviceId: service.id,
                    name: data.agent_name,
                },
                select: { id: true },
            });
        }

        // 3. Insert trace event
        await prisma.traceEvent.create({
            data: {
                projectId: data.project_id,
                serviceId: service.id,
                agentId: agent?.id ?? null,
                runId: data.run_id,
                provider: data.provider,
                model: data.model,
                requestJson: data.request,
                responseJson: data.response,
                latencyMs: data.latency_ms,
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
                timestamp: new Date(data.timestamp),
                error: data.error ?? null,
            },
        });

        console.log(`✅ Trace saved: ${data.run_id} | ${data.service_name} | ${data.model}`);
    },
    { connection, concurrency: 5 }
);

worker.on("failed", (job, err) => {
    console.error(`❌ Job ${job?.id} failed:`, err.message);
});

worker.on("completed", (job) => {
    console.log(`✔ Job ${job.id} completed`);
});

console.log("🔄 Leap360 Worker started, listening for trace events...");

// Graceful shutdown
process.on("SIGINT", async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
});
