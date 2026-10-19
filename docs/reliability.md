# Reliability

This document explains exactly how WorkshopRelay behaves when things fail:
lost notifications, retries, duplicate delivery, and process restarts. Design
claims are separated from measured results (the latter live in
`docs/demo-results.md`).

## The core guarantee

> **Every committed successful registration produces exactly one logical
> confirmation obligation, stored in the same database transaction as the
> registration itself. Delivery of that obligation is at-least-once, and the
> receiver suppresses duplicates logically via durable idempotency receipts.**

Broken down:

| Property | Mechanism |
|---|---|
| No notification loss after commit | Outbox row is created **inside** the business transaction. A committed registration without its confirmation event cannot exist (single atomic commit; tested). |
| No phantom notifications from failed registrations | Rolled-back transactions create neither registration nor event (tested). |
| Registration latency independent of delivery | The API never issues notification HTTP calls. Delivery happens in a separate worker process. |
| At-least-once delivery attempts | Retryable failures are retried indefinitely with capped full-jitter backoff; jobs are never discarded for age or attempt count. |
| Exactly-once *logical* delivery | The event id is the receiver idempotency key. The mock stores one receipt per key and treats same-key/same-payload resends as successful duplicates. |
| Crash safety | Leases + fencing tokens; every crash window has a defined recovery (table below). |
| Isolation between recipients | Independent outbox rows, claimed in batches and processed with bounded concurrency; one recipient's 503s never block another's delivery (tested). |

## Crash windows (PRD §9) and what happens

| Failure point | Durable state | Recovery |
|---|---|---|
| Before registration transaction commits | Nothing committed | No registration, no confirmation (client may retry; safe). |
| After commit, before API response reaches client | Registration + confirmation event exist | Client retries → `409 ALREADY_REGISTERED` (idempotent from the client's view); the event still delivers. |
| After claim (lease taken), before HTTP send | Event `PROCESSING`, lease until `T` | Lease expires → another worker reclaims (or the same worker after restart) and attempts again. |
| Receiver commits receipt, response lost/timeout | Receipt durable; event still `PROCESSING`/`PENDING` | Worker retries the same idempotency key → receiver returns `duplicate: true` success → worker marks `DELIVERED`. One receipt. |
| After successful response, before `markDelivered` | Receipt durable; event `PROCESSING` | Same as above — the resend is deduplicated at the receiver. The `kill after receiver success` e2e test exercises exactly this. |
| Worker restarts during retry delay | `nextAttemptAt` durable in the DB | A restarted (or any other) worker picks the job up when due. Nothing is held only in memory. |
| Worker crashes mid-settle (rare) | Either the fenced UPDATE committed or it didn't | If not: lease expiry reclaims; the stale attempt row is marked `STALE_LEASE`. |
| Mock service restarts | Receipts are PostgreSQL rows | Duplicate suppression survives restarts (tested: `receipts survive a mock restart`). |
| PostgreSQL restarts | — | All business and delivery state is in PostgreSQL; processes reconnect (pg pool). |
| API restarts | — | Stateless. In-flight requests that hadn't committed have no effect. |

### Kill/restart evidence

- `tests/integration/worker.test.ts` — lease expiry reclaims; stale fencing
  tokens cannot overwrite newer claims (both `markDelivered` and
  `settleRetry` paths); attempt rows record `STALE_LEASE`.
- `tests/e2e/failureScenarios.test.ts` — `kill after claim`,
  `kill after receiver success`, `mock restart keeps receipts durable`,
  `retry state survives worker restart` (integration).
- `scripts/demo.ts` Phase G — narrated crash simulation with visible rows.

## Lost notifications — the precise answer

A notification can only be "lost" in one narrow sense: **permanently failing
delivery to a recipient that will never accept anything again**. In that case
the job is not silently dropped — it remains visible (`PENDING` with a growing
`attemptCount` and `lastError`, or `NEEDS_ATTENTION` for permanent 4xx), and
alerting logs fire after `RETRY_ALERT_AFTER_ATTEMPTS`. The operator sees it in
the dashboard and can fix the cause and requeue.

Everything else is recovery:

- **Outage during registration** — the obligation is already durable; it
  delivers after the outage (demo Phase A/B).
- **Timeout ambiguity** — either the receipt committed (retry dedupes) or it
  didn't (retry delivers). Both are safe; `timeout_before_commit` and
  `commit_then_timeout` fault modes test each branch.
- **Process death anywhere** — see the crash-window table.

The system's own prerequisites are documented (PRD §5): eventual delivery
requires the database and workers to recover and the notification service to
eventually accept valid requests. Permanent malformed payloads or configuration
failures require visible operator intervention — the `NEEDS_ATTENTION` state
exists precisely so those cases are loud rather than falsely promised.

## Retries

- Classification (`src/domain/retryPolicy.ts`):
  - **Transient** (retry forever): timeouts, connection errors
    (`ECONNREFUSED`, `UND_ERR_*`, `fetch failed`, …), HTTP `408`, `429`, `5xx`.
  - **Permanent** (park as `NEEDS_ATTENTION`): other `4xx` — e.g. `400` bad
    request, `409` idempotency payload mismatch. Retrying these unchanged would
    never succeed; a visible operator action is the honest behavior.
- Backoff: full jitter between `RETRY_MIN_MS` and
  `min(RETRY_CAP_MS, RETRY_BASE_MS·2^(n-1))`.
- `Retry-After` (seconds or HTTP-date) is honored when present, clamped to
  `[RETRY_MIN_MS, RETRY_AFTER_MAX_MS]`.
- **Jobs are never dropped for exceeding an attempt count** (INV-12). After
  `RETRY_ALERT_AFTER_ATTEMPTS` (default 10) each retry logs at `warn` level.

## Duplicate delivery — the precise answer

Network delivery is **at-least-once**: the same event may be POSTed multiple
times (retry after timeout, lease reclaim after crash, worker restart). This is
explicitly *not* claimed to be exactly-once network delivery (PRD non-goal).

What IS guaranteed:

1. **One outbox event per logical occurrence** — enforced by unique semantic
   dedupe keys (`confirmation:<registrationId>`,
   `cancellation:<workshopId>:<memberId>`) created in the same transaction as
   the business state. Repeat cancellation creates zero new events (tested).
2. **One receipt per event at the receiver** — `MockDeliveryReceipt` is keyed by
   the event id (`idempotencyKey`). The receipt insert is atomic with the
   delivery operation (`INSERT … ON CONFLICT DO NOTHING` in one statement):
   - same key + same canonical payload hash → `200 {duplicate: true}`, no new
     row;
   - same key + different payload → `409 IDEMPOTENCY_PAYLOAD_MISMATCH`,
     surfaced for investigation (this would indicate a snapshot bug or a
     malicious sender).
3. **Payload snapshots** — events carry a frozen, versioned copy of workshop +
   member data. Later database edits cannot change what a queued notification
   means, so a retry cannot produce "the same key with a different payload"
   through ordinary use (INV-11; hash stability tested).

Duplicate *attempts* are visible in `NotificationAttempt` (including
`STALE_LEASE` outcomes), so operators can see exactly what happened.

## Restarts

| Process | Restart behavior |
|---|---|
| API | Stateless; nothing to recover. Auth identity lookups are per-request. |
| Worker | In-flight HTTP is abandoned; the lease expires and jobs are reclaimed. Retry schedules survive because `nextAttemptAt` lives in the DB. On graceful shutdown the worker stops claiming and lets the current cycle settle. |
| Mock | Fault config is in-memory (documented: a restart resets to `always_success`, the safe default). **Receipts are durable**, so duplicate suppression survives — this is the part that matters for correctness. |
| PostgreSQL | Everything is durable; pools reconnect. |

`WORKER_LEASE_MS` (15 s) is deliberately larger than
`NOTIFICATION_TIMEOUT_MS` (3 s) plus processing margin: a healthy worker
finishes inside its lease, so reclaim is only for genuinely dead workers.

## Concurrency

- **Duplicate registrations** — serialized by the workshop row lock and/or the
  `(workshopId, memberId)` unique index; exactly one wins, the rest get clean
  `409`s (6-way race tested).
- **Registration vs cancellation** — both take the workshop `FOR UPDATE` lock;
  whichever commits first defines the outcome (either registered-and-fanned-out
  or rejected-with-`409`), and both outcomes are consistent (tested).
- **Repeat cancellation** — first caller creates the fan-out set; concurrent
  and sequential repeats create zero events (tested).
- **Competing workers** — `SKIP LOCKED` claim batches are disjoint; settle
  writes are fenced by lease token (tested).

## Observability

- Structured JSON logs with `requestId`, `eventId`, `attempt`, `workerId`,
  `outcome` (PRD §11).
- `NotificationAttempt` history is inspectable per event via the API/dashboard.
- `WorkerHeartbeat` rows power the dashboard's worker-liveness indicator.
- Mock counters (`/api/mock/stats`): received, accepted, duplicates suppressed,
  payload mismatches, faults injected.

## Security posture (explicitly demo-grade)

- Configured bearer tokens mapped to roles via the `DemoIdentity` table. No
  password storage, no token expiry, no OAuth — this is documented demo
  authentication (PRD §10).
- Organizer-only routes: workshop creation/cancellation, rosters, notification
  inspection/requeue, mock fault controls and receipt viewing.
- Mock fault controls and `reset` require the admin token **and**
  `ENABLE_DEMO_FAULTS=true`; disable both on any deployment resembling
  production.
- `ENABLE_DEMO_PERSONAS=false` disables the persona listing endpoint; the UI
  falls back to manual token entry.
- Request bodies bounded (64 KB API / 128 KB mock); SQL errors never leak to
  clients (error envelope only); synthetic recipient data only
  (`*@synthetic.invalid`).
- CORS is deny-by-default; the dashboard is same-origin.
- No real secrets in the repo: `.env.example` carries dummy values; `.env` is
  git-ignored.

## Limitations (honest scope)

1. **Single-transaction fan-out** — cancellation writes one event per
   registration inside one transaction. Fine for realistic workshop rosters;
   very large rosters (tens of thousands+) need a durable paginated fan-out
   workflow.
2. **Delivery order** — an already-created confirmation is *not* cancelled when
   its workshop later cancels (OFF-03 requires the confirmation to exist).
   Per-recipient ordering between confirmation and cancellation is **not
   guaranteed**; both may deliver in either order. Cancellation payloads state
   the final `status: "CANCELLED"` explicitly so receivers can reconcile.
   Ordered per-recipient delivery is an optional extension.
3. **At-least-once attempts** — exactly-once *network* delivery is not claimed
   and not achievable without receiver cooperation; the receiver's idempotency
   table provides exactly-once *logical* effects.
4. **Mock fault config is in-memory** — resets to `always_success` on mock
   restart (safe default). Receipts are durable.
5. **Demo authentication** — see above.
6. **No background scheduler for `NEEDS_ATTENTION`** — these jobs require an
   operator action (by design).
7. **The optional leaderboard/waitlist/payments** etc. are out of scope per the
   PRD non-goals.

## Measured results vs design targets

Everything above describes mechanisms; each mechanism is verified by tests in
`tests/unit`, `tests/integration`, `tests/e2e` and demonstrated with real
output in `docs/demo-results.md`. No performance numbers are claimed beyond the
observations recorded there (with machine details and sample sizes).
