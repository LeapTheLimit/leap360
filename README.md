# Leap360 Agent Control Plane

Phase 1 of the Leap360 Agent Control Plane, designed to seamlessly ingest and view LLM traces.

## 🚀 Getting Started (< 10 minutes)

### Prerequisites
- Docker & Docker Compose
- Node.js (v20+)
- `pnpm` (run `npm i -g pnpm` if not installed)

### 1. Setup Environment
```bash
cp .env.example .env
```
Ensure your `LEAP360_API_KEY` and `SEED_PROJECT_ID` are configured in `.env`. The defaults are fine for local development.

### 2. Start the Infrastructure
Bring up PostgreSQL, Redis, the API, Worker, and Web dashboard:
```bash
docker compose up -d --build
```
> **Note:** The `api` container will automatically run the Prisma migrations and seed the database on startup.

### 3. Verify the Dashboard
Open [http://localhost:5173](http://localhost:5173) in your browser. You should see the dashboard loading!

### 4. Run the Example App
We've included a ready-to-run demo script that uses the `@leap360/sdk` to mock an OpenAI call.

```bash
cd example
pnpm install
pnpm start
```
After the script finishes, check the Dashboard again. You'll see a new service, traces logged to the "CustomerSupportBot" agent, and full request/response JSONs!

## 🧩 Monorepo Structure
- `/api`: Fastify + Prisma API Server and Redis BullMQ Worker.
- `/sdk-ts`: The official TypeScript SDK `@leap360/sdk`.
- `/sdk-py`: The official Python SDK `leap360`.
- `/web`: The React + Vite Dashboard.
- `/example`: A simple Node script mocking ingestion.

## 💻 Development Commands
If developing without Docker:
- `pnpm install` across the root workspace
- `pnpm migrate` inside `/api`
- `pnpm seed` inside `/api` 
- `pnpm dev` in root to concurrently run API and Web.

Enjoy Leap360! 🥂
