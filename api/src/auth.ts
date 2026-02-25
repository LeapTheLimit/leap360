import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";
import { FastifyRequest, FastifyReply } from "fastify";

const prisma = new PrismaClient();

// Cache project lookups to avoid hitting DB on every request
const projectCache = new Map<string, { id: string; name: string }>();

export async function authPreHandler(
    request: FastifyRequest,
    reply: FastifyReply
) {
    const apiKey = request.headers["x-leap360-key"] as string | undefined;

    if (!apiKey) {
        return reply.code(401).send({ error: "Missing x-leap360-key header" });
    }

    // Check cache first
    if (projectCache.has(apiKey)) {
        (request as any).project = projectCache.get(apiKey);
        return;
    }

    const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

    const project = await prisma.project.findFirst({
        where: { apiKeyHash },
        select: { id: true, name: true },
    });

    if (!project) {
        return reply.code(401).send({ error: "Invalid API key" });
    }

    projectCache.set(apiKey, project);
    (request as any).project = project;
}

export { prisma };
