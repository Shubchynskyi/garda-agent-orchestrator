# Architecture

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Purpose
Describe actual runtime architecture and boundaries for this repository.

## System Shape (Required)
- Architecture style: `TODO` (for example: monolith, modular monolith, microservices, serverless, desktop, mobile)
- Deployable units: `TODO`
- Runtime boundaries: `TODO`

## Source Layout Snapshot
Use real folders from this repository; replace the placeholder tree below.

```text
<project-root>/
├── <runtime-module-1>/
├── <runtime-module-2>/
├── <shared-or-library>/
└── <ops-or-infra>/
```

## Data and Control Flow (Required)
- Entry points (HTTP, queue, cron, CLI, worker): `TODO`
- Main request or event flow: `TODO`
- Persistence flow and ownership boundaries: `TODO`
- External system integrations: `TODO`

## Architecture Risk Areas
- State consistency and transaction boundaries: `TODO`
- Security boundaries and trust zones: `TODO`
- Failure and retry behavior: `TODO`
- Performance hot paths: `TODO`

## References
- Project discovery report: `garda-agent-orchestrator/live/project-discovery.md`
- Architecture decision records (if any): `TODO`
