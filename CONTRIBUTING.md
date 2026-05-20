# Contributing to Leap360 AI Governance SDK

Thank you for your interest in contributing! This project is open source and community-driven. All contributions are welcome.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Contribution Types](#contribution-types)
- [Code Style](#code-style)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Issues](#reporting-issues)

---

## Getting Started

### Prerequisites

- **Node.js** v18+
- **pnpm** (`npm i -g pnpm`)
- **Python** 3.9+ (for the Python SDK)

### Clone & Install

```bash
git clone https://github.com/LeapTheLimit/LEAP360-SDK.git
cd LEAP360-SDK
pnpm install
```

### Run Locally

```bash
# Initialize the local SQLite database
pnpm migrate
pnpm seed

# Start API (port 4000) + Web Dashboard (port 5173) together
pnpm dev
```

See [HowToRun.md](./HowToRun.md) for the full setup guide.

---

## Project Structure

```
LEAP360-SDK/
├── api/            # Fastify REST API — SQLite via Prisma
│   ├── prisma/     # Schema + migrations
│   └── src/
│       ├── routes/ # killswitch, policies, violations, traces, services
│       └── server.ts
├── web/            # React + Vite dashboard
│   └── src/
│       └── pages/  # ServicesView, KillSwitchView, PoliciesView, ViolationsView …
├── sdk-ts/         # TypeScript/JavaScript SDK (published as `leap360`)
├── sdk-py/         # Python SDK (published as `leap360`)
├── src/            # CLI source (npx leap360 setup / whoami / clear)
└── example/        # Runnable demo script
```

---

## Development Workflow

1. **Fork** the repository and create a feature branch:
   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes** — keep commits focused and atomic.

3. **Test locally** before submitting:
   ```bash
   pnpm dev          # verify API + web work
   cd example && pnpm start   # verify the SDK sends traces
   ```

4. **Open a Pull Request** against the `main` branch.

---

## Contribution Types

| Type | Description |
|------|-------------|
| 🐛 Bug Fix | Fix an existing issue — link it in the PR description |
| ✨ Feature | New provider support, new governance rule, new dashboard page |
| 📖 Docs | README, HowToRun, inline code comments |
| 🧹 Refactor | Improve code quality without changing behaviour |
| 🧪 Tests | Unit or integration tests for API routes or SDK methods |

---

## Code Style

- **TypeScript**: strict mode, no `any` unless absolutely necessary.
- **Formatting**: Prettier defaults (2-space indent, single quotes).
- **Commits**: use [Conventional Commits](https://www.conventionalcommits.org/) — e.g. `feat:`, `fix:`, `docs:`, `chore:`.

---

## Submitting a Pull Request

1. Ensure your branch is up-to-date with `main`.
2. Fill in the PR template (what changed, why, how to test).
3. A maintainer will review within a few days.
4. Address any review comments, then the PR will be merged.

---

## Reporting Issues

Open a [GitHub Issue](https://github.com/LeapTheLimit/LEAP360-SDK/issues) and include:

- **What happened** — clear description of the bug or request.
- **Steps to reproduce** — minimal code snippet if applicable.
- **Environment** — OS, Node version, package version.

---

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](./LICENSE).
