# Architecture

WorkshopRelay is a workshop-registration backend whose distinguishing feature
is **correctness under outages, retries, concurrent requests, and process
restarts**. Registrations commit independently of notification delivery, and
every committed business event carries a durable delivery obligation.

## Components

```text
Client / dashboard / demo script
        |
        v
┌───────────────────┐        ┌──────────────────────────────────────────┐
│   Express API     │        │            PostgreSQL                     │
│  (src/api)        │───────▶│  Workshop / Registration                  │
│                   │  TX    │  NotificationEvent (outbox)               │
│  validates,       │        │  NotificationAttempt                      │
│  enforces roles,  │        │  MockDeliveryReceipt                      │
│  commits business │        │  WorkerHeartbeat                          │
│  state + outbox   │        └──────────────────────────────────────────┘
└───────────────────┘                        ▲                ▲
        │ response after commit              │ claim/settle   │ receipts
        │ (no notification HTTP call)        │                │
        v                                    │                │
┌───────────────────┐        HTTP POST       │        ┌───────┴──────────┐
│  Worker           │────────────────────────┴───────▶│  Mock service    │
│  (src/worker)     │                                 │  (src/mock)      │
│  claim → send →   │◀── 2xx / 408 / 429 / 5xx / 4xx ─│  fault controller│
│  settle/retry     │                                 │  durable receipts│
└───────────────────┘                                 └──────────────────┘
```

### Service boundaries

| Process | Responsibility | Must not |
|---|---|---|
| **API** (`npm run dev:api`) | Validate requests, enforce roles, apply business transactions, expose status | Contact the notification service on the request path |
| **Worker** (`npm run dev:worker`) | Claim due events, POST deliveries, schedule retries, recover leases | Hold DB locks while waiting on the network |
| **Mock** (`npm run dev:mock`) | Accept synthetic deliveries, inject controllable faults, persist receipts | Read outbox state to decide success |
| **PostgreSQL** | Durable source of truth for business state and delivery obligations | — |

All three Node processes are stateless; all durable state lives in PostgreSQL.
A single PostgreSQL instance is used locally, with the mock's
`MockDeliveryReceipt` table logically separate from the outbox tables.

## Data model (Prisma: `prisma/schema.prisma`)

- **Member** — synthetic recipient (displayName + notificationAddress).
- **Workshop** — `ACTIVE | CANCELLED`, cancellation is irreversible (MVP).
- **Registration** — unique on `(workshopId, memberId)` (OFF-01, enforced by the
  database, not application code).
- **NotificationEvent** — the transactional outbox row. `id` doubles as the
  receiver idempotency key. `dedupeKey` is a unique *semantic* key
  (`confirmation:<registrationId>` / `cancellation:<workshopId>:<memberId>`)
  making event creation idempotent at the database level. `payload` is a
  versioned snapshot. Delivery state machine:

  ```text
  PENDING ──claim──▶ PROCESSING ──success──▶ DELIVERED
     ▲                   │
     │                   ├──transient──▶ PENDING (nextAttemptAt = now + backoff)
     │                   │
     │                   └──permanent──▶ NEEDS_ATTENTION ──operator──▶ PENDING
     │                                        retry                (requeue)
     └── (retry loop continues indefinitely; jobs are never dropped for age)
  ```

- **NotificationAttempt** — one row per claim, with outcome
  (`SUCCESS | RETRY_SCHEDULED | NEEDS_ATTENTION | STALE_LEASE`), HTTP status and
  sanitized error. Unique on `(eventId, attemptNumber)`.
- **MockDeliveryReceipt** — the receiver's durable delivery record
  (`idempotencyKey` PK, canonical `payloadHash`, payload, receivedAt).
- **WorkerHeartbeat** — observability only (dashboard worker-liveness pill).

Timestamps are `TIMESTAMPTZ` end-to-end; the API serializes ISO-8601 UTC.

## Transactions

### Registration (API request path)

1. Validate body + identity (member id comes from the bearer identity, never
   from the request body).
2. `BEGIN`.
3. `SELECT … FROM "Workshop" WHERE id = $1 FOR UPDATE` — row lock serializes
   registration against cancellation and other registrations of the same
   workshop.
4. Reject missing (`404`) or cancelled (`409`) workshops.
5. `INSERT INTO "Registration" … ON CONFLICT (workshopId, memberId) DO NOTHING` —
   the unique constraint turns races into clean `409 ALREADY_REGISTERED`.
6. `INSERT INTO "NotificationEvent"` with the semantic dedupe key
   `confirmation:<registrationId>` and a **payload snapshot** (title, schedule,
   member address at registration time).
7. `COMMIT`.
8. Return `201` with `notification.status = "PENDING"` — a transaction-time
   snapshot. **No notification HTTP call occurs anywhere on this path.**

If the transaction fails at any point (e.g. FK violation), neither the
registration nor the event exists — invariant INV-3 (tested in
`tests/integration/registration.test.ts`).

### Cancellation (API request path)

1. `BEGIN`; lock the workshop row `FOR UPDATE`.
2. If already `CANCELLED`: return current state with `alreadyCancelled: true`,
   create nothing (INV-7 — repeat cancellation is idempotent).
3. `UPDATE` status → `CANCELLED`, set `cancelledAt`.
4. Fan-out with one set-based statement:

   ```sql
   INSERT INTO "NotificationEvent" (…)
   SELECT gen_random_uuid(),
          'cancellation:<wsId>:' || r."memberId",
          'WORKSHOP_CANCELLED', r."memberId", …
   FROM "Registration" r JOIN "Member" m ON …
   WHERE r."workshopId" = $1
   ON CONFLICT ("dedupeKey") DO NOTHING
   ```

5. `COMMIT` — status change and all fan-out events are atomic.

**Ordering guarantee (PRD §5):** because both flows take the same row lock, a
registration that committed before the cancellation is always included in the
fan-out; a registration that arrives after the cancellation is rejected with
`409 WORKSHOP_CANCELLED`. This race is covered by
`tests/integration/cancellation.test.ts › registration/cancellation race`.

**Scale note:** fan-out executes in one transaction. For rosters of many
thousands this would need a durable paginated fan-out workflow; that is a
documented MVP limitation, not an accident (PRD §9).

## Worker claim protocol

```sql
SELECT "id" FROM "NotificationEvent"
WHERE ("status" = 'PENDING'      AND "nextAttemptAt" <= now())
   OR ("status" = 'PROCESSING'   AND "leaseUntil"    <  now())
ORDER BY "nextAttemptAt"
LIMIT $batch
FOR UPDATE SKIP LOCKED;
```

then, inside the same short transaction:

```sql
UPDATE "NotificationEvent"
SET status = 'PROCESSING',
    "leaseToken" = gen_random_uuid(),   -- fresh fencing token per event
    "leaseUntil" = now() + lease,
    "attemptCount" = "attemptCount" + 1
WHERE id = ANY($claimed)
RETURNING …;
-- + one NotificationAttempt row per claimed event
```

Key properties:

- **`SKIP LOCKED`** — concurrent workers never contend for the same row; a
  batch claim by N workers always returns disjoint sets.
- **Two due conditions** — ordinary due `PENDING` jobs, *and* `PROCESSING`
  jobs whose lease expired (crash recovery, OFF-04).
- **HTTP happens outside the transaction.** The claim transaction is
  milliseconds; the network call (up to `NOTIFICATION_TIMEOUT_MS`) holds no
  locks.
- **Fenced settling** — completion/retry updates are conditional:

  ```sql
  UPDATE … SET status = 'DELIVERED' …
  WHERE id = $1 AND "leaseToken" = $token AND status = 'PROCESSING'
  ```

  A stale worker (whose lease was reclaimed) matches zero rows and cannot
  overwrite the newer worker's state; its attempt row is marked
  `STALE_LEASE` for inspection. This is what makes duplicate *attempts* safe.
- **Lease duration vs HTTP timeout** — `WORKER_LEASE_MS` (default 15 000)
  exceeds `NOTIFICATION_TIMEOUT_MS` (3 000) plus processing margin, so a
  healthy worker's lease does not expire mid-request. The batch size is small
  (10) so a full batch finishes well inside one lease window.

## Delivery pipeline (worker)

```text
claim batch → mapPool(concurrency=5) per event:
  buildDeliveryBody(eventId, type, recipientId, payloadSnapshot)
  POST {MOCK_NOTIFICATION_URL}/notifications
       Idempotency-Key: <eventId>
       Authorization: Bearer {MOCK_AUTH_TOKEN}
  classify response:
    2xx                 → markDelivered (fenced)
    408/429/5xx/network → settleRetry(RETRY_SCHEDULED) + full-jitter backoff
    other 4xx           → settleRetry(NEEDS_ATTENTION)   (operator-visible)
```

Retry policy (all configurable):

| Parameter | Default | Meaning |
|---|---|---|
| `NOTIFICATION_TIMEOUT_MS` | 3 000 | HTTP timeout per attempt |
| `RETRY_BASE_MS` / `RETRY_CAP_MS` | 1 000 / 60 000 | exponential envelope |
| `RETRY_MIN_MS` | 100 | jitter floor (no hot loops) |
| `RETRY_AFTER_MAX_MS` | 300 000 | bound honored on `Retry-After` |
| `RETRY_ALERT_AFTER_ATTEMPTS` | 10 | log escalation threshold (never a drop) |

Backoff is **full jitter**: `delay = max(min, rand × min(cap, base·2^(n-1)))`.
Retryable jobs are retried **indefinitely** — exceeding an attempt count never
discards a job (INV-12). After `RETRY_ALERT_AFTER_ATTEMPTS` each attempt logs at
warn level so operators can see chronic failures.

## Mock notification service

- `POST /notifications` — requires `Idempotency-Key` + service bearer token.
  Receipt insertion is a single atomic
  `INSERT … ON CONFLICT DO NOTHING`:
  - new key → `201 {duplicate: false}` (receipt stored)
  - same key + same canonical payload hash → `200 {duplicate: true}` (no new row)
  - same key + different payload → `409 IDEMPOTENCY_PAYLOAD_MISMATCH`
- Fault controller (PUT `/admin/faults`, demo mode only): `always_success`,
  `fail_first_n`, `always_503`, `always_400`, `timeout_before_commit`,
  `commit_then_timeout`, `seeded_random` — scoped globally / per recipient /
  per event. See `docs/reliability.md` for the fault semantics table.
- `GET /receipts`, `GET /admin/stats`, `POST /admin/reset` — admin-token
  protected; the dashboard reaches them through same-origin API proxy routes
  (`/api/mock/*`, organizer-only) so the browser never talks to the mock port.

## API surface

See the README for the full table. Highlights:

- Consistent error envelope
  `{ "error": { "code", "message", "requestId", "details?" } }` with an
  `X-Request-Id` response header on every request.
- Registration response shape matches the PRD:

  ```json
  {
    "registrationId": "…",
    "workshopId": "…",
    "memberId": "…",
    "notification": { "eventId": "…", "status": "PENDING" }
  }
  ```

- Organizer tooling: roster, per-workshop notification status, event detail with
  attempt history, and `POST /api/notifications/:eventId/retry` to requeue a
  corrected `NEEDS_ATTENTION` job.
- Additive dashboard endpoints (beyond the PRD core table, documented as
  extensions): `GET /api/notifications` (filterable cross-workshop list),
  `GET /api/system/status`, `/api/mock/*` proxies, `/api/demo/personas`.

## Authentication (demo-grade)

Configured bearer tokens (`.env`) map to roles through the `DemoIdentity` table
written by `prisma/seed.ts`:

- `ORGANIZER_TOKEN` → organizer identity (create/cancel/retry/inspection).
- `MEMBER_TOKENS=alice:token,…` → member identities with `memberId` profiles.

Registration derives `memberId` from the authenticated identity (PRD §8); an
organizer token receives `403 NOT_A_MEMBER`. This is explicitly **not**
production-grade account management — see `docs/reliability.md` § Security.

## Dashboard

`public/` is served same-origin by the API process (no external CDNs):

- Persona switcher (tokens come from `/api/demo/personas`, disable with
  `ENABLE_DEMO_PERSONAS=false`) or manual token entry.
- Workshops: create / register / cancel / roster / notification chips.
- Notifications: filterable outbox table, attempt timelines, payload snapshots,
  one-click requeue of `NEEDS_ATTENTION` jobs.
- Mock & Faults: apply fault rules, inspect counters and receipts, reset
  fixtures — all through organizer-protected proxy routes.

## Runtime layout

| Command | Process |
|---|---|
| `npm run dev:api` | API + dashboard on `API_PORT` (default 3000) |
| `npm run dev:worker` | Worker loop (poll `WORKER_POLL_MS`) |
| `npm run dev:mock` | Mock service on `MOCK_PORT` (default 4100) |
| `npm run dev:all` | All three in one terminal (convenience) |
| `npm run demo` | Self-contained demonstration (in-process services) |

Graceful shutdown on SIGINT/SIGTERM: the API stops accepting, the worker stops
claiming and lets in-flight cycles settle (or their leases expire safely); no
in-memory queue exists to lose.
