import Fastify from "fastify";
import cors from "@fastify/cors";
import * as dotenv from "dotenv";
import { traceRoutes } from "./routes/traces";
import { killSwitchRoutes } from "./routes/killswitch";
import { policyRoutes } from "./routes/policies";

dotenv.config();

const app = Fastify({
    logger: {
        transport: {
            target: "pino-pretty",
            options: { colorize: true },
        },
    },
});

async function main() {
    // CORS — allow the React dashboard (and any local tooling)
    await app.register(cors, {
        origin: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "x-leap360-key", "Authorization"],
    });

    // ── Health check ──────────────────────────────────────────────────────────
    app.get("/health", async () => ({
        status: "ok",
        version: "1.0.0",
        ts: new Date().toISOString(),
    }));

    // ── Dashboard login (simple password check — no cloud auth) ───────────────
    app.post("/v1/auth/login", async (request, reply) => {
        const body = request.body as { email?: string; password?: string };
        const adminEmail = process.env.ADMIN_EMAIL || "admin@leap360.ai";
        const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

        if (body.email === adminEmail && body.password === adminPassword) {
            return {
                token: "leap360-dashboard-token",
                projectId: process.env.SEED_PROJECT_ID || "00000000-0000-0000-0000-000000000001",
            };
        }
        return reply.code(401).send({ error: "Invalid credentials" });
    });

    // ── Feature routes ────────────────────────────────────────────────────────
    await app.register(traceRoutes);
    await app.register(killSwitchRoutes);
    await app.register(policyRoutes);

    const port = parseInt(process.env.PORT || "4000", 10);
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`\n🚀  Leap360 API ready at http://localhost:${port}`);
    console.log(`📊  Dashboard  → http://localhost:5173`);
    console.log(`🔑  Default API key: ${process.env.LEAP360_API_KEY || "leap360-dev-secret-key-change-me"}\n`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
