import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { authPreHandler, prisma } from "../auth";
import { traceQueue } from "../queue";

const traceBodySchema = z.object({
    project_id: z.string(),
    service_name: z.string(),
    agent_name: z.string().nullable().optional(),
    run_id: z.string(),
    provider: z.string(),
    model: z.string(),
    request: z.record(z.any()),
    response: z.record(z.any()),
    latency_ms: z.number(),
    usage: z.object({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
        total_tokens: z.number(),
    }),
    timestamp: z.string(),
    error: z.string().nullable().optional(),
});

export async function traceRoutes(fastify: FastifyInstance) {
    // POST /v1/traces — ingest a trace
    fastify.post(
        "/v1/traces",
        { preHandler: authPreHandler },
        async (request: FastifyRequest, reply: FastifyReply) => {
            const parsed = traceBodySchema.safeParse(request.body);
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "Invalid payload", details: parsed.error.flatten() });
            }

            const project = (request as any).project as { id: string };

            await traceQueue.add("trace", {
                ...parsed.data,
                project_id: project.id, // always use the verified project from auth
            });

            return reply.code(200).send({ status: "ok" });
        }
    );

    // GET /v1/projects/:id/services
    fastify.get(
        "/v1/projects/:id/services",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id } = request.params as { id: string };

            const services = await prisma.service.findMany({
                where: { projectId: id },
                include: {
                    _count: { select: { traces: true } },
                },
                orderBy: { lastSeenAt: "desc" },
            });

            return services.map((s) => ({
                id: s.id,
                name: s.name,
                firstSeenAt: s.firstSeenAt,
                lastSeenAt: s.lastSeenAt,
                traceCount: s._count.traces,
            }));
        }
    );

    // GET /v1/projects/:id/traces
    fastify.get(
        "/v1/projects/:id/traces",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id } = request.params as { id: string };
            const query = request.query as {
                service?: string;
                agent?: string;
                limit?: string;
                offset?: string;
            };

            const limit = Math.min(parseInt(query.limit || "50", 10), 200);
            const offset = parseInt(query.offset || "0", 10);

            const where: any = { projectId: id };

            if (query.service) {
                const svc = await prisma.service.findFirst({
                    where: { projectId: id, name: query.service },
                    select: { id: true },
                });
                if (svc) where.serviceId = svc.id;
            }

            if (query.agent) {
                const ag = await prisma.agent.findFirst({
                    where: { projectId: id, name: query.agent },
                    select: { id: true },
                });
                if (ag) where.agentId = ag.id;
            }

            const [traces, total] = await Promise.all([
                prisma.traceEvent.findMany({
                    where,
                    include: {
                        service: { select: { name: true } },
                        agent: { select: { name: true } },
                    },
                    orderBy: { timestamp: "desc" },
                    take: limit,
                    skip: offset,
                }),
                prisma.traceEvent.count({ where }),
            ]);

            return {
                total,
                limit,
                offset,
                data: traces.map((t) => ({
                    id: t.id,
                    serviceName: t.service.name,
                    agentName: t.agent?.name ?? null,
                    runId: t.runId,
                    provider: t.provider,
                    model: t.model,
                    latencyMs: t.latencyMs,
                    promptTokens: t.promptTokens,
                    completionTokens: t.completionTokens,
                    totalTokens: t.totalTokens,
                    timestamp: t.timestamp,
                    error: t.error ?? null,
                })),
            };
        }
    );

    // GET /v1/traces/:id
    fastify.get(
        "/v1/traces/:id",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id } = request.params as { id: string };

            const trace = await prisma.traceEvent.findUnique({
                where: { id },
                include: {
                    service: { select: { name: true } },
                    agent: { select: { name: true } },
                },
            });

            if (!trace) {
                return reply.code(404).send({ error: "Trace not found" });
            }

            return {
                id: trace.id,
                projectId: trace.projectId,
                serviceName: trace.service.name,
                agentName: trace.agent?.name ?? null,
                runId: trace.runId,
                provider: trace.provider,
                model: trace.model,
                request: trace.requestJson,
                response: trace.responseJson,
                latencyMs: trace.latencyMs,
                promptTokens: trace.promptTokens,
                completionTokens: trace.completionTokens,
                totalTokens: trace.totalTokens,
                timestamp: trace.timestamp,
                error: trace.error ?? null,
            };
        }
    );

    // GET /v1/projects/:id/agents — helper for dropdown
    fastify.get(
        "/v1/projects/:id/agents",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id } = request.params as { id: string };
            const { service } = request.query as { service?: string };

            const where: any = { projectId: id };
            if (service) {
                const svc = await prisma.service.findFirst({
                    where: { projectId: id, name: service },
                    select: { id: true },
                });
                if (svc) where.serviceId = svc.id;
            }

            const agents = await prisma.agent.findMany({
                where,
                select: { id: true, name: true },
                orderBy: { name: "asc" },
            });

            return agents;
        }
    );
}
