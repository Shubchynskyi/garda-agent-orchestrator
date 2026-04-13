# Reference Walkthroughs

Hands-on examples showing how Garda Agent Orchestrator works in real projects.

Each walkthrough covers the full lifecycle: **install → first task → update → uninstall**.

| # | Walkthrough | Stack | Typical Team |
|---|---|---|---|
| 1 | [Node.js Backend](01-nodejs-backend.md) | Express / Fastify, npm, Jest | 2-5 devs, GitHub Copilot + Claude |
| 2 | [Java Monolith](02-java-monolith.md) | Spring Boot, Maven, JUnit | 3-8 devs, Codex + Gemini |
| 3 | [Python Service](03-python-service.md) | FastAPI, Poetry, pytest | 1-4 devs, Claude |
| 4 | [Solo Developer — Minimal Mode](04-solo-developer-minimal.md) | Any stack, single agent | 1 dev, any provider |

## How to Read These

- **Before/After file tree** — what your project looks like before and after `garda setup`.
- **Example task execution** — a realistic task from `TASK.md` through the full gate pipeline.
- **Update scenario** — upgrading the orchestrator to a new version.
- **Uninstall outcome** — clean removal with keep/delete choices.

## Prerequisites

All walkthroughs assume:
- Node.js 24 LTS installed.
- `npm install -g garda-agent-orchestrator` completed.
- A git-initialized project directory.

## Related Docs

- [HOW_TO.md](../../HOW_TO.md) — step-by-step setup guide
- [docs/cli-reference.md](../cli-reference.md) — complete CLI command reference
- [docs/work-example.md](../work-example.md) — task lifecycle walkthrough
- [docs/configuration.md](../configuration.md) — token economy, output filters, review capabilities
- [docs/architecture.md](../architecture.md) — design and deployment model
