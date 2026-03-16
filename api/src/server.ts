import Fastify from "fastify";
import cors from "@fastify/cors";
import * as dotenv from "dotenv";
import { traceRoutes } from "./routes/traces";

dotenv.config();

const app = Fastify({
    logger: true,
});

async function main() {
    // CORS — allow the React dashboard
    await app.register(cors, {
        origin: true,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "x-leap360-key", "Authorization"],
    });

    // Health check
    app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

    // Dashboard auth endpoint (simple password check)
    app.post("/v1/auth/login", async (request, reply) => {
        const body = request.body as { email?: string; password?: string };
        const adminEmail = process.env.ADMIN_EMAIL || "admin@leap360.ai";
        const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

        if (body.email === adminEmail && body.password === adminPassword) {
            return { token: "leap360-dashboard-token", projectId: process.env.SEED_PROJECT_ID };
        }
        return reply.code(401).send({ error: "Invalid credentials" });
    });

    // All trace routes
    await app.register(traceRoutes);

    const port = parseInt(process.env.PORT || "4000", 10);
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`🚀 Leap360 API listening on port ${port}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
