# WorkshopRelay — Workshop Registration & Reliable Notifications

A workshop-registration backend with a **transactional outbox**, an independent
delivery worker, and a mock HTTP notification service with deterministic fault
injection. The distinguishing feature is correctness under outages, retries,
concurrent requests, and process restarts — not endpoint count.

**Registration responses never wait for notification delivery.** Every
committed registration carries a durable confirmation obligation created in the
same database transaction; cancellation fans out durable obligations to every
registered member. Delivery is at-least-once with durable idempotency receipts,
so logical effects are exactly-once.

- Dashboard: workshop management, outbox inspection, fault controls, receipts.
- Tests: **92** (unit + integration against real PostgreSQL + e2e failure
  scenarios) — see [`docs/demo-results.md`](docs/demo-results.md).
- Demo: `npm run demo` reproduces outage → recovery → retries → isolated
  failure → permanent failure → ambiguity → crash → cancellation with real rows.

## Stack

TypeScript · Express 5 · PostgreSQL 17 · Prisma 7 (pg driver adapter) ·
Vitest 4 · Docker Compose (optional packaging). Runtime is `tsx` (Node ≥ 20.19).

## Quick start

```bash
# 1. PostgreSQL 14+ with a database + user (any standard setup), e.g.:
#    CREATE USER workshop WITH PASSWORD 'workshop_dev_password';
#    CREATE DATABASE workshop_relay OWNER workshop;
#    CREATE DATABASE workshop_relay_test OWNER workshop;   -- for tests

# 2. Install & configure
npm install
cp .env.example .env          # DATABASE_URL etc. — defaults match the above

# 3. Generate client, migrate, seed demo identities + sample workshop
npm run setup

# 4. Run the three processes (separate terminals, or dev:all for one)
npm run dev:api               # API + dashboard → http://localhost:3000/
npm run dev:worker            # notification delivery worker
npm run dev:mock              # mock notification service → :4100

# 5. Verify
npm run test:all              # 92 tests
npm run demo                  # scripted demonstration (OFF-08)
```

Docker alternative (packaging provided; requires Docker):

```bash
docker compose up --build     # postgres + migrate + api + worker + mock
```

### Demo identities

Seeded from `.env` (`ORGANIZER_TOKEN`, `MEMBER_TOKENS`) — **dev-only**:

| Identity | Token (default) | Role |
|---|---|---|
| Organizer | `organizer-demo-token` | create/cancel workshops, inspect/requeue notifications, fault controls |
| alice | `alice-demo-token` | member |
| bob | `bob-demo-token` | member |
| carol | `carol-demo-token` | member |
| dave | `dave-demo-token` | member |

The dashboard's persona switcher lists these automatically (disable with
`ENABLE_DEMO_PERSONAS=false`).

## Commands

| Command | Purpose |
|---|---|
| `npm run setup` | `prisma generate` + `migrate deploy` + seed |
| `npm run dev:api` / `dev:worker` / `dev:mock` | run each process (watch mode) |
| `npm run dev:all` | all three in one terminal |
| `npm run start:api` etc. | run without watch |
| `npm run db:migrate` / `db:migrate:dev` / `db:seed` / `db:reset` | migrations & fixtures |
| `npm run test` / `test:integration` / `test:e2e` / `test:all` | vitest suites |
| `npm run demo` | end-to-end demonstration with printed evidence |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` |

## API

All business routes are JSON with a consistent error envelope and an
`X-Request-Id` header:

```json
{ "error": { "code": "ALREADY_REGISTERED", "message": "…", "requestId": "…" } }
```

| Method | Route | Role | Behavior |
|---|---|---|---|
| POST | `/api/workshops` | Organizer | create workshop → `201` |
| GET | `/api/workshops` | Any | list, bounded pagination (`limit≤100`), `status` filter |
| GET | `/api/workshops/:id` | Any | detail (+ viewer registration state) or `404` |
| POST | `/api/workshops/:id/registrations` | Member | register **after commit** → `201`; duplicate → `409 ALREADY_REGISTERED`; cancelled → `409 WORKSHOP_CANCELLED` |
| GET | `/api/workshops/:id/registrations` | Organizer | paginated roster |
| POST | `/api/workshops/:id/cancel` | Organizer | persist fan-out → `200`; repeat calls safe (`alreadyCancelled: true`, 0 new events) |
| GET | `/api/workshops/:id/notification-status` | Organizer | counts by type/status + recent events |
| GET | `/api/notifications` *(ext)* | Organizer | filterable cross-workshop event list for the console |
| GET | `/api/notifications/:eventId` | Organizer | event state + sanitized attempt history |
| POST | `/api/notifications/:eventId/retry` | Organizer | requeue a corrected `NEEDS_ATTENTION` job |
| GET | `/health/live` · `/health/ready` | Public | liveness / database readiness |
| GET | `/api/system/status` *(ext)* | Any | DB + mock + worker heartbeats (dashboard) |
| GET/PUT | `/api/mock/faults`, `/api/mock/receipts`, `/api/mock/reset`, `/api/mock/stats` *(ext)* | Organizer | same-origin proxy to the mock's admin API |

*(ext)* = additive dashboard endpoints beyond the PRD's core contract.

Registration response (matches the PRD exactly):

```json
{
  "registrationId": "uuid",
  "workshopId": "uuid",
  "memberId": "uuid",
  "notification": { "eventId": "uuid", "status": "PENDING" }
}
```

`PENDING` is the transaction-time snapshot; a worker may deliver immediately
afterward. **The API never contacts the notification service.**

### Mock notification service (`MOCK_PORT`, default 4100)

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/notifications` | service token | deliver a synthetic message; **requires `Idempotency-Key`** |
| GET | `/receipts` | admin token | inspect durable receipts |
| PUT | `/admin/faults` | admin token | configure fault behavior (demo mode only) |
| POST | `/admin/reset` | admin token | clear fixtures (demo mode only) |
| GET | `/admin/stats` | admin token | counters |
| GET | `/health/live` | — | liveness |

Delivery request body:

```json
{
  "eventId": "uuid",
  "type": "REGISTRATION_CONFIRMED",
  "recipientId": "uuid",
  "payloadVersion": 1,
  "message": { "workshopId": "uuid", "title": "…", "scheduledAt": "…" }
}
```

Same key + same payload → `200 {duplicate: true}` (no second receipt).
Same key + different payload → `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.

## Fault controls (curl)

```bash
MOCK=http://localhost:4100
AUTH="Authorization: Bearer mock-admin-token"        # MOCK_ADMIN_TOKEN
CT="Content-Type: application/json"

# fail the next 2 deliveries with 503, then recover
curl -s -X PUT -H "$AUTH" -H "$CT" $MOCK/admin/faults \\
  -d '{"mode":"fail_first_n","failFirstN":2}'

# persistent failure for one recipient only
curl -s -X PUT -H "$AUTH" -H "$CT" $MOCK/admin/faults \\
  -d '{"mode":"always_503","scope":{"kind":"recipient","recipientId":"<uuid>"}}'

# permanent rejection (event parks as NEEDS_ATTENTION)
curl -s -X PUT -H "$AUTH" -H "$CT" $MOCK/admin/faults \\
  -d '{"mode":"always_400"}'

# ambiguous outcome: receipt commits, response is lost
curl -s -X PUT -H "$AUTH" -H "$CT" $MOCK/admin/faults \\
  -d '{"mode":"commit_then_timeout","hangMs":5000}'

# timeout before the receiver commits (no receipt)
curl -s -X PUT -H "$AUTH" -H "$CT" $MOCK/admin/faults \\
  -d '{"mode":"timeout_before_commit","hangMs":5000}'

# seeded randomness (record the seed in your notes)
curl -s -X PUT -H "$AUTH" -H "$CT" $MOCK/admin/faults \\
  -d '{"mode":"seeded_random","seed":42,"failureRate":0.3}'

# back to healthy
curl -s -X PUT -H "$AUTH" -H "$CT" $MOCK/admin/faults -d '{"mode":"always_success"}'
```

The dashboard's **Mock & Faults** tab exposes the same controls through the
API's organizer-protected proxy.

## Configuration

See [`.env.example`](.env.example) for the full annotated list: `DATABASE_URL`,
`API_PORT`, `MOCK_PORT`, `MOCK_NOTIFICATION_URL`, `MOCK_AUTH_TOKEN`,
`MOCK_ADMIN_TOKEN`, demo tokens, `WORKER_CONCURRENCY` / `WORKER_POLL_MS` /
`WORKER_LEASE_MS`, `NOTIFICATION_TIMEOUT_MS`, `RETRY_BASE_MS` / `RETRY_CAP_MS`,
`ENABLE_DEMO_FAULTS`, `ENABLE_DEMO_PERSONAS`, `LOG_LEVEL`, and more. All values
are validated at startup (fail fast on bad config). Timestamps are stored as
`TIMESTAMPTZ` and returned as ISO-8601 UTC.

## How reliability works (short version)

1. **Transactional outbox** — registration/cancellation and their notification
   events commit atomically; semantic dedupe keys make event creation
   idempotent.
2. **Claim with leases + fencing tokens** — `SELECT … FOR UPDATE SKIP LOCKED`,
   fresh lease token per claim, expired leases reclaimable; stale workers can
   never overwrite newer results.
3. **Retry forever with capped full-jitter backoff** for transient failures
   (timeouts, connection errors, 408/429/5xx), honoring bounded `Retry-After`;
   jobs are never dropped by attempt count. Permanent 4xx become visible
   `NEEDS_ATTENTION` jobs with a requeue tool.
4. **Idempotent receiver** — durable receipts keyed by event id; duplicate
   deliveries succeed without double-recording. Payload snapshots + canonical
   hashing make duplicate detection stable.
5. **Crash windows are enumerated and tested** — see
   [`docs/reliability.md`](docs/reliability.md).

Full write-ups:

- [`docs/architecture.md`](docs/architecture.md) — components, transactions,
  claim protocol, data model.
- [`docs/reliability.md`](docs/reliability.md) — lost notifications, retries,
  duplicate delivery, restarts, concurrency, limitations.
- [`docs/demo-results.md`](docs/demo-results.md) — recorded demo + test output
  (real runs, machine details, no invented numbers).

## Project structure

```text
backend-workshop/
├── prisma/            schema.prisma · migrations/ · seed.ts
├── src/
│   ├── api/           express app, routes, middleware, transactional services
│   ├── worker/        claim → send → settle loop, HTTP sender
│   ├── mock/          mock service + fault controller
│   ├── domain/        event keys/payloads, retry policy (pure, tested)
│   ├── db/            Prisma client factory, outbox claim/settle SQL
│   └── shared/        config, logger, errors, clock, helpers
├── public/            dashboard (same-origin SPA, no external assets)
├── tests/             unit/ integration/ e2e/ + helpers
├── scripts/           demo.ts · start-all.ts
└── docs/              architecture.md · reliability.md · demo-results.md
```

## Scope & limitations

Implements the PRD MVP plus the recommended dashboard. Non-goals (per PRD):
real email/SMS/push, payments, waitlists, seat limits, Kafka/Redis, and claims
of exactly-once *network* delivery. Known limitations (single-transaction
fan-out scale, unordered confirmation-vs-cancellation delivery, demo-grade
auth) are documented in [`docs/reliability.md`](docs/reliability.md#limitations-honest-scope).
