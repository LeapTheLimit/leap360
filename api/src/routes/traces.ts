import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { authPreHandler, prisma } from "../auth";

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

            const data = parsed.data;

            try {
                // 1. Upsert service
                const service = await prisma.service.upsert({
                    where: {
                        projectId_name: {
                            projectId: project.id,
                            name: data.service_name,
                        },
                    },
                    update: { lastSeenAt: new Date() },
                    create: {
                        projectId: project.id,
                        name: data.service_name,
                    },
                });

                // 2. Upsert agent (if provided)
                let agent: { id: string } | null = null;
                if (data.agent_name) {
                    agent = await prisma.agent.upsert({
                        where: {
                            projectId_serviceId_name: {
                                projectId: project.id,
                                serviceId: service.id,
                                name: data.agent_name,
                            },
                        },
                        update: { lastSeenAt: new Date() },
                        create: {
                            projectId: project.id,
                            serviceId: service.id,
                            name: data.agent_name,
                        },
                        select: { id: true },
                    });
                }

                // 3. Insert trace event
                await prisma.traceEvent.create({
                    data: {
                        projectId: project.id,
                        serviceId: service.id,
                        agentId: agent?.id ?? null,
                        runId: data.run_id,
                        provider: data.provider,
                        model: data.model,
                        requestJson: JSON.stringify(data.request),
                        responseJson: JSON.stringify(data.response),
                        latencyMs: data.latency_ms,
                        promptTokens: data.usage.prompt_tokens,
                        completionTokens: data.usage.completion_tokens,
                        totalTokens: data.usage.total_tokens,
                        timestamp: new Date(data.timestamp),
                        error: data.error ?? null,
                    },
                });

                 return reply.code(200).send({ status: "ok" });
            } catch (error) {
                console.error("Error inserting trace:", error);
                return reply.code(500).send({ error: "Failed to process trace" });
            }
        }
    );

    // Helper to resolve project ID (allows "demo" as alias for the seeded project)
    async function resolveProject(id: string) {
        if (id === 'demo') {
            const p = await prisma.project.findFirst();
            return p?.id || id;
        }
        return id;
    }

    // GET /v1/projects/:id/services
    fastify.get(
        "/v1/projects/:id/services",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const id = await resolveProject(rawId);

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
            const { id: rawId } = request.params as { id: string };
            const id = await resolveProject(rawId);
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

    // GET /v1/projects/:id/stats
    fastify.get(
        "/v1/projects/:id/stats",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const id = await resolveProject(rawId);

            const now = new Date();
            const oneMinuteAgo = new Date(now.getTime() - 60000);
            const thirtySecsAgo = new Date(now.getTime() - 30000);

            const traces = await prisma.traceEvent.findMany({
                where: { projectId: id },
                include: { agent: true }
            });

            const last30s = traces.filter(t => t.timestamp >= thirtySecsAgo);
            const last60s = traces.filter(t => t.timestamp >= oneMinuteAgo);

            const agentNames = [...new Set(traces.map(t => t.agent?.name).filter(Boolean))] as string[];
            const activeAgentNames = [...new Set(last30s.map(t => t.agent?.name).filter(Boolean))] as string[];

            const modelUsage: Record<string, number> = {};
            let totalLatency = 0;
            let totalTokens = 0;
            let errors = 0;

            for (const t of traces) {
                modelUsage[t.model] = (modelUsage[t.model] ?? 0) + 1;
                totalLatency += t.latencyMs;
                totalTokens += t.totalTokens;
                if (t.error) errors++;
            }

            const avgLatency = traces.length ? Math.round(totalLatency / traces.length) : 0;

            // Mock weekly volume for the dashboard chart
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const weeklyVolume = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
                const dayName = days[d.getDay()];
                weeklyVolume.push({ day: dayName, req: 0, viol: 0 });
            }

            // Fill weekly volume from real traces
            for (const t of traces) {
                const diffDays = Math.floor((now.getTime() - t.timestamp.getTime()) / (24 * 60 * 60 * 1000));
                if (diffDays >= 0 && diffDays <= 6) {
                    const idx = 6 - diffDays;
                    weeklyVolume[idx].req++;
                    if (t.error || t.latencyMs > 3000) weeklyVolume[idx].viol++;
                }
            }

            return {
                totalTraces: traces.length,
                totalAgents: agentNames.length,
                activeAgents: activeAgentNames.length,
                reqLastMinute: last60s.length,
                avgLatencyMs: avgLatency,
                totalTokens,
                errors,
                modelUsage,
                agentNames,
                activeAgentNames,
                weeklyVolume,
            };
        }
    );

    // GET /v1/projects/:id/agents
    fastify.get(
        "/v1/projects/:id/agents",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const id = await resolveProject(rawId);

            const now = new Date();
            const agents = await prisma.agent.findMany({
                where: { projectId: id },
                include: {
                    traces: {
                        orderBy: { timestamp: 'desc' }
                    }
                }
            });

            return agents.map(a => {
                const totalLatency = a.traces.reduce((sum, t) => sum + t.latencyMs, 0);
                const errors = a.traces.filter(t => t.error).length;
                const lastSeen = a.traces[0]?.timestamp || a.lastSeenAt;

                return {
                    name: a.name,
                    model: a.traces[0]?.model || 'N/A',
                    calls: a.traces.length,
                    lastSeen: lastSeen.toISOString(),
                    errors,
                    avgLatencyMs: a.traces.length ? Math.round(totalLatency / a.traces.length) : 0,
                    status: (now.getTime() - lastSeen.getTime()) < 30000 ? 'active' : 'idle'
                };
            });
        }
    );

    // GET /v1/projects/:id/violations
    fastify.get(
        "/v1/projects/:id/violations",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const id = await resolveProject(rawId);

            const violations = await prisma.traceEvent.findMany({
                where: {
                    projectId: id,
                    OR: [
                        { error: { not: null } },
                        { latencyMs: { gt: 3000 } }
                    ]
                },
                include: { agent: true, service: true },
                orderBy: { timestamp: 'desc' },
                take: 50
            });

            const data = violations.map((t, i) => {
                const isError = !!t.error;
                const isHighLatency = t.latencyMs > 3000;
                const sev = isError ? 'critical' : isHighLatency ? 'high' : 'medium';
                const desc = isError
                    ? `Error: ${t.error?.substring(0, 120)}`
                    : `High latency detected: ${t.latencyMs}ms (threshold: 3000ms)`;
                
                return {
                    id: `V-${1000 + i}`,
                    sev,
                    agent: t.agent?.name ?? t.service.name,
                    desc,
                    model: t.model,
                    time: t.timestamp.toISOString(),
                    policy: isError ? 'Error Policy' : 'Performance Policy',
                    status: isError ? 'Open' : 'Investigating'
                };
            });

            return {
                violations: data,
                summary: {
                    open: data.filter(v => v.status === 'Open').length,
                    investigating: data.filter(v => v.status === 'Investigating').length,
                    resolved: 0,
                    total30d: data.length
                }
            };
        }
    );

    // GET /v1/projects/:id/models
    fastify.get(
        "/v1/projects/:id/models",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const id = await resolveProject(rawId);

            const traces = await prisma.traceEvent.findMany({
                where: { projectId: id }
            });

            const modelMap = new Map<string, any>();
            const now = new Date();

            for (const t of traces) {
                if (!modelMap.has(t.model)) {
                    modelMap.set(t.model, { 
                        name: t.model, calls: 0, errors: 0, totalLatency: 0, lastSeen: t.timestamp 
                    });
                }
                const m = modelMap.get(t.model);
                m.calls++;
                m.totalLatency += t.latencyMs;
                if (t.error) m.errors++;
                if (t.timestamp > m.lastSeen) m.lastSeen = t.timestamp;
            }

            return [...modelMap.values()].map(m => {
                const avgLatency = m.calls > 0 ? Math.round(m.totalLatency / m.calls) : 0;
                const errorRate = m.calls > 0 ? m.errors / m.calls : 0;
                const score = Math.max(0, Math.round(100 - errorRate * 100 - (avgLatency > 3000 ? 30 : avgLatency > 2000 ? 15 : 0)));
                
                const provider = m.name.toLowerCase().startsWith('gemini') ? 'Google' :
                    m.name.toLowerCase().startsWith('gpt') ? 'OpenAI' : 'Other';

                return {
                    name: m.name,
                    provider,
                    calls: m.calls,
                    errors: m.errors,
                    avgLatencyMs: avgLatency,
                    score,
                    risk: errorRate > 0.1 ? 'High' : avgLatency > 2000 ? 'Medium' : 'Low',
                    status: (now.getTime() - m.lastSeen.getTime()) < 60000 ? 'Active' : 'Idle',
                    lastSeen: m.lastSeen.toISOString()
                };
            });
        }
    );

    // GET /v1/projects/:id/audit
    fastify.get(
        "/v1/projects/:id/audit",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const id = await resolveProject(rawId);

            const traces = await prisma.traceEvent.findMany({
                where: { projectId: id },
                include: { agent: true, service: true },
                orderBy: { timestamp: 'desc' },
                take: 50
            });

            return traces.map(t => {
                const isError = !!t.error;
                const isHighLatency = t.latencyMs > 3000;
                let action = '';
                let type = 'trace';
                
                if (isError) {
                    action = `Error in ${t.agent?.name ?? t.service.name}: ${t.error?.substring(0, 80)}`;
                    type = 'enforcement';
                } else if (isHighLatency) {
                    action = `High-latency trace from ${t.agent?.name ?? t.service.name} (${t.latencyMs}ms)`;
                    type = 'assessment';
                } else {
                    action = `${t.agent?.name ?? t.service.name} completed ${t.model} call in ${t.latencyMs}ms`;
                    type = 'trace';
                }

                return {
                    time: t.timestamp.toISOString(),
                    user: 'SDK',
                    agent: t.agent?.name ?? t.service.name,
                    model: t.model,
                    action,
                    type,
                    latencyMs: t.latencyMs,
                    tokens: t.totalTokens,
                    error: t.error
                };
            });
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
                request: JSON.parse(trace.requestJson),
                response: JSON.parse(trace.responseJson),
                latencyMs: trace.latencyMs,
                promptTokens: trace.promptTokens,
                completionTokens: trace.completionTokens,
                totalTokens: trace.totalTokens,
                timestamp: trace.timestamp,
                error: trace.error ?? null,
            };
        }
    );
}
