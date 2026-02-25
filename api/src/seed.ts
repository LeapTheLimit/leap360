import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";
import * as dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function main() {
    const apiKey = process.env.LEAP360_API_KEY;
    const projectId = process.env.SEED_PROJECT_ID;

    if (!apiKey || !projectId) {
        console.error("LEAP360_API_KEY and SEED_PROJECT_ID must be set in .env");
        process.exit(1);
    }

    const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

    await prisma.project.upsert({
        where: { id: projectId },
        update: { apiKeyHash },
        create: {
            id: projectId,
            name: "Default Project",
            apiKeyHash,
        },
    });

    console.log(`✅ Seeded project: ${projectId}`);
    console.log(`   API Key: ${apiKey}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
