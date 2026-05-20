# 🚀 Leap360 — How to Run Locally

This guide gets you from a fresh clone to a fully running local AI governance stack in under 5 minutes. **No Docker, no PostgreSQL, no cloud account required.**

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | v18+ | https://nodejs.org |
| pnpm | latest | `npm i -g pnpm` |
| Python *(optional, for Python SDK)* | 3.9+ | https://python.org |

---

## Step 1 — Clone & Install

```bash
git clone https://github.com/LeapTheLimit/LEAP360-SDK.git
cd LEAP360-SDK
pnpm install
```

---

## Step 2 — Configure Environment

```bash
cp .env.example .env
```

The defaults in `.env.example` work out of the box for local development. You can leave everything as-is for your first run.

Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file:./prisma/dev.db` | SQLite file path |
| `LEAP360_API_KEY` | `leap360-dev-secret-key-change-me` | Auth key for API requests |
| `SEED_PROJECT_ID` | `00000000-0000-0000-0000-000000000001` | Default project UUID |

---

## Step 3 — Initialize the Database

```bash
# Create the SQLite schema (runs Prisma migrations)
pnpm migrate

# Seed default project + API key
pnpm seed
```

The database file is created at `api/prisma/dev.db` (auto-ignored by git).

---

## Step 4 — Start the Stack

```bash
pnpm dev
```

This starts two processes in parallel:

| Process | URL | Description |
|---------|-----|-------------|
| API | http://localhost:4000 | Fastify REST API + Prisma/SQLite |
| Dashboard | http://localhost:5173 | React + Vite web UI |

---

## Step 5 — Send a Test Trace

Open a **new terminal** and run the included example:

```bash
cd example
pnpm install
pnpm start
```

Then open the dashboard at **http://localhost:5173** — you'll see:
- A new service (`example-backend-service`) in the Services list
- Traces logged with provider, model, tokens, and latency

---

## Step 6 — Explore Governance Features

### Kill Switch
Visit **http://localhost:5173/killswitch** to suspend the entire project or a specific agent.

Or via API:
```bash
curl -X POST http://localhost:4000/v1/projects/00000000-0000-0000-0000-000000000001/killswitch \
  -H "x-leap360-key: leap360-dev-secret-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"status":"SUSPENDED","reason":"Testing kill switch"}'
```

### Policies
Visit **http://localhost:5173/policies** to create governance rules.

Or via API:
```bash
curl -X POST http://localhost:4000/v1/projects/00000000-0000-0000-0000-000000000001/policies \
  -H "x-leap360-key: leap360-dev-secret-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"name":"No PII","severity":"high","action":"block","rules":["detect_pii"]}'

```

### Violations
Visit **http://localhost:5173/violations** to view the policy violation log.

---

## CLI Quick Config

If you want the SDK CLI to remember your settings:

```bash
npx leap360 setup
# → saves to ~/.leap360/config.json

npx leap360 whoami   # view saved config
npx leap360 clear    # remove saved config
```

---

## Useful Commands

| Command | Description |
|---------|-------------|
| `pnpm install` | Install all workspace dependencies |
| `pnpm migrate` | Run Prisma migrations (SQLite) |
| `pnpm seed` | Seed default project + API key |
| `pnpm dev` | Start API + Dashboard in watch mode |
| `pnpm build` | Build all packages for production |

---

## Troubleshooting

**`pnpm: script execution is disabled`** (Windows PowerShell)
```powershell
# Run via cmd instead
cmd /c pnpm install
cmd /c pnpm dev
```

**Port already in use**
```bash
# Kill whatever is on port 4000 or 5173
npx kill-port 4000
npx kill-port 5173
```

**Database errors after schema changes**
```bash
# Reset and re-migrate
rm api/prisma/dev.db
pnpm migrate
pnpm seed
```

---

## Default Credentials

| Setting | Value |
|---------|-------|
| API Key | `leap360-dev-secret-key-change-me` |
| Project ID | `00000000-0000-0000-0000-000000000001` |
| Dashboard | http://localhost:5173 |
| API | http://localhost:4000 |

> ⚠️ Change `LEAP360_API_KEY` in your `.env` before exposing the API on a shared or public network.
