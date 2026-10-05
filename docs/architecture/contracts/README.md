# Architecture Contracts

This directory is the **shared source of truth** for all agents working on 9Drive.

| File | Governs |
|---|---|
| [provider-contract.md](provider-contract.md) | `StorageProvider` interface, capabilities, registry, catalog, routing, health/quota |
| [database-contract.md](database-contract.md) | PostgreSQL schema, model inventory, migration strategy, data rules |
| [api-contract.md](api-contract.md) | HTTP conventions, endpoint inventory, upload protocol, routing modes |
| [job-contract.md](job-contract.md) | Redis/BullMQ queues, job types, worker lifecycle, locks/cache |
| [event-contract.md](event-contract.md) | Internal events, webhooks, frontend refresh events |
| [security-contract.md](security-contract.md) | Auth, authorization, SSRF, uploads, tokens, crypto, Docker hardening |

## Rules

1. **Read every contract relevant to your task before writing code.**
2. **Never edit a contract.** Propose changes instead.
3. An agent that needs a contract change writes
   `docs/architecture/contracts/CHANGE-proposal-<agent>-<n>.md` describing:
   - what changes, why
   - which agents/components are impacted
   - backwards-compatibility impact
4. The **Coordinator** performs impact analysis, updates the contract, and notifies
   impacted agents. Dependent agents re-read the contract before continuing.
5. Silent contract drift is treated as a defect and reverted.

## Shared files owned by the Coordinator only

These files are edited by **no agent**; agents report the change they need and the
Coordinator applies it:

- `backend/src/app.ts` (router mounting, global middleware)
- `backend/package.json`, `frontend/package.json` (dependencies, scripts)
- `docker-compose.yml`, `.env.docker.example`
- `setup.ps1`, `setup.sh`
- `backend/prisma/schema.prisma` (via the database contract proposal process)
- `frontend/src/App.tsx`, `frontend/src/layouts/DriveLayout.tsx` (route/nav registration)
- `README.md`, `AGENTS.md`

## Agent status board

Live status for every agent is maintained in
[`../agent-status.md`](../agent-status.md). Every agent appends its report block:

```
AGENT:
STATUS:
TASK:
COMPLETED:
FILES_CHANGED:
TESTS:
DEPENDENCIES:
BLOCKERS:
RISKS:
NEXT_STEP:
```
