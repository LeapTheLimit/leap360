import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../auth";

export async function killSwitchRoutes(fastify: FastifyInstance) {
    // Helper to resolve project ID alias "demo"
    async function resolveProject(id: string) {
        if (id === "demo") {
            const p = await prisma.project.findFirst();
            return p?.id || id;
        }
        return id;
    }

    // ─── GET /v1/projects/:id/killswitch ─────────────────────────────────────
    // Returns all kill-switch states for a project (global + per-agent)
    fastify.get(
        "/v1/projects/:id/killswitch",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const projectId = await resolveProject(rawId);

            const rows = await prisma.killSwitch.findMany({
                where: { projectId },
                orderBy: { updatedAt: "desc" },
            });

            // Build structured response
            const global = rows.find((r) => !r.agentName || r.agentName === "");
            const agents = rows.filter((r) => r.agentName && r.agentName !== "");

            return {
                global: {
                    status: global?.status ?? "ACTIVE",
                    reason: global?.reason ?? null,
                    updatedAt: global?.updatedAt ?? null,
                },
                agents: agents.map((a) => ({
                    agentName: a.agentName,
                    status: a.status,
                    reason: a.reason ?? null,
                    updatedAt: a.updatedAt,
                })),
            };
        }
    );

    // ─── POST /v1/projects/:id/killswitch ────────────────────────────────────
    // Set global kill-switch: body { status: "ACTIVE" | "SUSPENDED", reason?: string }
    fastify.post(
        "/v1/projects/:id/killswitch",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const projectId = await resolveProject(rawId);
            const { status, reason } = request.body as {
                status: "ACTIVE" | "SUSPENDED";
                reason?: string;
            };

            if (!["ACTIVE", "SUSPENDED"].includes(status)) {
                return reply.code(400).send({ error: "status must be ACTIVE or SUSPENDED" });
            }

            const row = await prisma.killSwitch.upsert({
                where: {
                    projectId_agentName: { projectId, agentName: "" },
                },
                update: { status, reason: reason ?? null, updatedAt: new Date() },
                create: { projectId, agentName: "", status, reason: reason ?? null },
            });

            // Also update the project status field for convenience
            await prisma.project.update({
                where: { id: projectId },
                data: { status },
            });

            console.log(`[KillSwitch] Global → ${status} (project: ${projectId})`);
            return { ok: true, global: { status: row.status, reason: row.reason, updatedAt: row.updatedAt } };
        }
    );

    // ─── POST /v1/projects/:id/killswitch/agents/:agentName ──────────────────
    // Set per-agent kill-switch
    fastify.post(
        "/v1/projects/:id/killswitch/agents/:agentName",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId, agentName } = request.params as {
                id: string;
                agentName: string;
            };
            const projectId = await resolveProject(rawId);
            const { status, reason } = request.body as {
                status: "ACTIVE" | "SUSPENDED";
                reason?: string;
            };

            if (!["ACTIVE", "SUSPENDED"].includes(status)) {
                return reply.code(400).send({ error: "status must be ACTIVE or SUSPENDED" });
            }

            const row = await prisma.killSwitch.upsert({
                where: {
                    projectId_agentName: { projectId, agentName },
                },
                update: { status, reason: reason ?? null, updatedAt: new Date() },
                create: { projectId, agentName, status, reason: reason ?? null },
            });

            // Also update the Agent record status if it exists
            const agent = await prisma.agent.findFirst({
                where: { projectId, name: agentName },
            });
            if (agent) {
                await prisma.agent.update({
                    where: { id: agent.id },
                    data: { status },
                });
            }

            console.log(`[KillSwitch] Agent "${agentName}" → ${status} (project: ${projectId})`);
            return {
                ok: true,
                agent: { agentName, status: row.status, reason: row.reason, updatedAt: row.updatedAt },
            };
        }
    );

    // ─── GET /v1/projects/:id/killswitch/check ───────────────────────────────
    // SDK uses this to check whether it is allowed to proceed before a call.
    // Query params: ?agent=<name>
    fastify.get(
        "/v1/projects/:id/killswitch/check",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const projectId = await resolveProject(rawId);
            const { agent: agentName } = request.query as { agent?: string };

            // Check global first
            const global = await prisma.killSwitch.findFirst({
                where: { projectId, agentName: "" },
            });
            if (global?.status === "SUSPENDED") {
                return {
                    allowed: false,
                    reason: global.reason ?? "Project is globally suspended",
                    scope: "global",
                };
            }

            // Check per-agent if provided
            if (agentName) {
                const agentSwitch = await prisma.killSwitch.findFirst({
                    where: { projectId, agentName },
                });
                if (agentSwitch?.status === "SUSPENDED") {
                    return {
                        allowed: false,
                        reason: agentSwitch.reason ?? `Agent "${agentName}" is suspended`,
                        scope: "agent",
                    };
                }
            }

            return { allowed: true };
        }
    );
}
