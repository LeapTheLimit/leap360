import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../auth";

const policyBodySchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
    action: z.enum(["log", "block"]).default("log"),
    enabled: z.boolean().default(true),
    rules: z.array(z.string()).default([]),
});

export async function policyRoutes(fastify: FastifyInstance) {
    async function resolveProject(id: string) {
        if (id === "demo") {
            const p = await prisma.project.findFirst();
            return p?.id || id;
        }
        return id;
    }

    // ─── GET /v1/projects/:id/policies ───────────────────────────────────────
    fastify.get(
        "/v1/projects/:id/policies",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const projectId = await resolveProject(rawId);

            const policies = await prisma.policy.findMany({
                where: { projectId },
                include: {
                    _count: { select: { violations: true } },
                },
                orderBy: { createdAt: "desc" },
            });

            return policies.map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description ?? null,
                severity: p.severity,
                action: p.action,
                enabled: p.enabled,
                rules: JSON.parse(p.rules),
                violationCount: p._count.violations,
                createdAt: p.createdAt,
            }));
        }
    );

    // ─── POST /v1/projects/:id/policies ──────────────────────────────────────
    fastify.post(
        "/v1/projects/:id/policies",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const projectId = await resolveProject(rawId);

            const parsed = policyBodySchema.safeParse(request.body);
            if (!parsed.success) {
                return reply.code(400).send({ error: parsed.error.flatten() });
            }
            const { rules, ...rest } = parsed.data;

            const policy = await prisma.policy.create({
                data: {
                    projectId,
                    ...rest,
                    rules: JSON.stringify(rules),
                },
            });

            return { id: policy.id, name: policy.name, action: policy.action };
        }
    );

    // ─── PUT /v1/projects/:id/policies/:policyId ─────────────────────────────
    fastify.put(
        "/v1/projects/:id/policies/:policyId",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { policyId } = request.params as { id: string; policyId: string };

            const parsed = policyBodySchema.partial().safeParse(request.body);
            if (!parsed.success) {
                return reply.code(400).send({ error: parsed.error.flatten() });
            }
            const { rules, ...rest } = parsed.data;

            const policy = await prisma.policy.update({
                where: { id: policyId },
                data: {
                    ...rest,
                    ...(rules !== undefined ? { rules: JSON.stringify(rules) } : {}),
                },
            });

            return { id: policy.id, name: policy.name };
        }
    );

    // ─── DELETE /v1/projects/:id/policies/:policyId ──────────────────────────
    fastify.delete(
        "/v1/projects/:id/policies/:policyId",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { policyId } = request.params as { id: string; policyId: string };

            await prisma.policy.delete({ where: { id: policyId } });
            return { ok: true };
        }
    );

    // ─── GET /v1/projects/:id/violations ─────────────────────────────────────
    fastify.get(
        "/v1/projects/:id/violations",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const projectId = await resolveProject(rawId);
            const query = request.query as { status?: string; limit?: string };
            const limit = Math.min(parseInt(query.limit || "100", 10), 500);

            const where: any = { projectId };
            if (query.status) where.status = query.status;

            const violations = await prisma.violation.findMany({
                where,
                include: {
                    policy: { select: { name: true, action: true } },
                    agent: { select: { name: true } },
                    trace: { select: { model: true, provider: true } },
                },
                orderBy: { createdAt: "desc" },
                take: limit,
            });

            const data = violations.map((v) => ({
                id: v.id,
                severity: v.severity,
                description: v.description,
                status: v.status,
                policy: v.policy.name,
                action: v.policy.action,
                agent: v.agent?.name ?? null,
                model: v.trace?.model ?? null,
                provider: v.trace?.provider ?? null,
                createdAt: v.createdAt,
                resolvedAt: v.resolvedAt ?? null,
            }));

            const open = data.filter((v) => v.status === "open").length;
            const investigating = data.filter((v) => v.status === "investigating").length;
            const resolved = data.filter((v) => v.status === "resolved").length;

            return {
                violations: data,
                summary: { open, investigating, resolved, total: violations.length },
            };
        }
    );

    // ─── POST /v1/projects/:id/violations ────────────────────────────────────
    // SDK or internal code can log a violation manually
    fastify.post(
        "/v1/projects/:id/violations",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { id: rawId } = request.params as { id: string };
            const projectId = await resolveProject(rawId);

            const { policyId, traceId, agentId, severity, description } =
                request.body as {
                    policyId: string;
                    traceId?: string;
                    agentId?: string;
                    severity?: string;
                    description: string;
                };

            const policy = await prisma.policy.findFirst({ where: { id: policyId, projectId } });
            if (!policy) return reply.code(404).send({ error: "Policy not found" });

            const violation = await prisma.violation.create({
                data: {
                    projectId,
                    policyId,
                    traceId: traceId ?? null,
                    agentId: agentId ?? null,
                    severity: severity ?? policy.severity,
                    description,
                    status: "open",
                },
            });

            return { id: violation.id, status: violation.status };
        }
    );

    // ─── PATCH /v1/projects/:id/violations/:violationId ──────────────────────
    // Update violation status
    fastify.patch(
        "/v1/projects/:id/violations/:violationId",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const { violationId } = request.params as { id: string; violationId: string };
            const { status } = request.body as { status: "open" | "investigating" | "resolved" };

            if (!["open", "investigating", "resolved"].includes(status)) {
                return reply.code(400).send({ error: "Invalid status" });
            }

            const violation = await prisma.violation.update({
                where: { id: violationId },
                data: {
                    status,
                    resolvedAt: status === "resolved" ? new Date() : null,
                },
            });

            return { id: violation.id, status: violation.status };
        }
    );
}
