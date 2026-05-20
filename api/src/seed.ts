/**
 * Seed script — creates a default project + API key for local development.
 * Run with:  pnpm seed   (inside /api)
 */
import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";

const prisma = new PrismaClient();

const DEFAULT_API_KEY = process.env.LEAP360_API_KEY || "leap360-dev-secret-key-change-me";
const DEFAULT_PROJECT_ID = process.env.SEED_PROJECT_ID || "00000000-0000-0000-0000-000000000001";
const DEFAULT_PROJECT_NAME = "Default Project";

async function main() {
    const apiKeyHash = crypto
        .createHash("sha256")
        .update(DEFAULT_API_KEY)
        .digest("hex");

    // Upsert the default project
    const project = await prisma.project.upsert({
        where: { id: DEFAULT_PROJECT_ID },
        update: { apiKeyHash },
        create: {
            id: DEFAULT_PROJECT_ID,
            name: DEFAULT_PROJECT_NAME,
            apiKeyHash,
            status: "ACTIVE",
        },
    });

    console.log(`✅  Project seeded: "${project.name}" (id: ${project.id})`);
    console.log(`🔑  API Key: ${DEFAULT_API_KEY}`);

    // Seed a global kill-switch record (ACTIVE = not suspended)
    await prisma.killSwitch.upsert({
        where: { projectId_agentName: { projectId: project.id, agentName: "" } },
        update: {},
        create: {
            projectId: project.id,
            agentName: "",   // empty string == global
            status: "ACTIVE",
        },
    });

    // Seed three default policies
    const policies = [
        {
            name: "PII Protection",
            description: "Detect and block responses containing personally identifiable information.",
            severity: "high",
            action: "block",
            rules: JSON.stringify(["email", "phone number", "SSN", "credit card"]),
        },
        {
            name: "Performance Policy",
            description: "Flag traces with latency above 3000 ms.",
            severity: "medium",
            action: "log",
            rules: JSON.stringify(["latency > 3000ms"]),
        },
        {
            name: "Error Policy",
            description: "Automatically log a violation whenever an LLM call returns a runtime error.",
            severity: "high",
            action: "log",
            rules: JSON.stringify(["runtime_error"]),
        },
    ];

    for (const p of policies) {
        const existing = await prisma.policy.findFirst({
            where: { projectId: project.id, name: p.name },
        });
        if (!existing) {
            await prisma.policy.create({ data: { projectId: project.id, ...p } });
            console.log(`📋  Policy seeded: "${p.name}"`);
        }
    }

    console.log("\n🚀  Seed complete. Start the server with: pnpm dev");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
