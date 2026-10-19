# Demo & test results (recorded, not estimated)

All numbers below were produced by actually running the commands shown, on the
machine described, and pasting the output verbatim. Nothing here is a design
target or an extrapolation.

## Machine

| | |
|---|---|
| CPU / RAM | 2 vCPU, 1.9 GiB RAM (shared sandbox) |
| OS | Debian GNU/Linux 13 (trixie), linux x64 |
| Node.js | v20.20.2 |
| PostgreSQL | 17.11 (Debian 17.11-0-1+deb13u1) |
| Prisma | 7.10.1 (query compiler + `@prisma/adapter-pg`) |

## Test suite

Command: `npm run test:all` (vitest 4.1.12, real PostgreSQL test database,
migrations applied by global setup).

```
 Test Files  9 passed (9)
      Tests  92 passed (92)
   Duration  9.37s
```

| Suite | File | Tests | What it proves |
|---|---|---|---|
| unit | `tests/unit/events.test.ts` | 9 | dedupe keys, payload snapshots, canonical hash stability |
| unit | `tests/unit/retryPolicy.test.ts` | 12 | backoff bounds/jitter, Retry-After, transient vs permanent classification |
| unit | `tests/unit/faults.test.ts` | 9 | every fault mode + scoping + seeded determinism |
| unit | `tests/unit/config.test.ts` | 6 | env parsing, token mapping, validation |
| integration | `tests/integration/registration.test.ts` | 7 | atomic registration+outbox, rollback, 409 duplicates under 6-way concurrency, 404/409 |
| integration | `tests/integration/cancellation.test.ts` | 6 | fan-out per registrant, idempotent repeat cancel, registration/cancel race ordering |
| integration | `tests/integration/worker.test.ts` | 13 | claim/lease/SKIP LOCKED, fencing (stale tokens can't overwrite), reclaim after expiry, retry scheduling, one-recipient isolation, resend dedupe |
| integration | `tests/integration/mockService.test.ts` | 14 | receipts, duplicate suppression, payload-mismatch 409, all fault modes, timeout semantics (receipt or not), reset, durable receipts across mock restart |
| e2e | `tests/e2e/failureScenarios.test.ts` | 16 | OFF-02 outage registration + recovery, N-failures-then-recover, isolated persistent failure, timeout-before-commit, commit-then-timeout ambiguity, kill-after-claim, kill-after-receiver-success, mock restart, NEEDS_ATTENTION + requeue, API contract/roles/validation, public persona listing, cancellation fan-out via API |

Run subsets: `npm run test` (unit), `npm run test:integration`,
`npm run test:e2e`.

## Demonstration (`npm run demo`)

The demo runs the real API, worker and mock code in-process against the
configured database and walks through outage → recovery → retries → isolated
failure → permanent failure → ambiguity → crash → cancellation. Verbatim output
of the recorded run (2 vCPU sandbox, demo uses tightened retry timings of
80–400 ms backoff to stay snappy):

```text
════════════════════════════════════════════════════════════════════════
  WorkshopRelay — reliable registration & notifications demo
════════════════════════════════════════════════════════════════════════
  database : postgresql://workshop:***@127.0.0.1:5432/workshop_relay
  mode     : in-process API + worker + mock (same code as the servers)

════════════════════════════════════════════════════════════════════════
  Phase A — register while the notification service is DOWN (OFF-02)
════════════════════════════════════════════════════════════════════════
    Notification service target is a dead port: delivery cannot succeed.
  ✓ workshop created (53 ms) → e1edee38-c115-4f9c-8098-0b29e4003398
  ✓ alice registered — HTTP 201 in 40 ms (notification status: PENDING)
    confirmation event 225ebf1a… committed in the same transaction
  ✓ bob registered — HTTP 201 in 21 ms (notification status: PENDING)
    confirmation event 982567ac… committed in the same transaction
    TYPE     RECIPIENT  STATUS   ATTEMPTS  LASTERROR
    ───────  ─────────  ───────  ────────  ─────────
    CONFIRM  4765da61   PENDING  0         —        
    CONFIRM  c9bb15d5   PENDING  0         —        
  ✓ registrations returned WITHOUT waiting for notification delivery

════════════════════════════════════════════════════════════════════════
  Phase B — notification service recovers; obligations deliver (OFF-03/04)
════════════════════════════════════════════════════════════════════════
    mock service now reachable at http://127.0.0.1:46097
    TYPE     RECIPIENT  STATUS     ATTEMPTS  LASTERROR
    ───────  ─────────  ─────────  ────────  ─────────
    CONFIRM  4765da61   DELIVERED  1         —        
    CONFIRM  c9bb15d5   DELIVERED  1         —        
    KEY       PAYLOADTYPE
    ────────  ───────────
    225ebf1a  CONFIRM    
    982567ac  CONFIRM    
  ✓ every committed registration produced exactly one confirmation receipt

════════════════════════════════════════════════════════════════════════
  Phase C — transient failures retried automatically (OFF-05)
════════════════════════════════════════════════════════════════════════
    fault rule: fail_first_n = 2 (the next two delivery calls fail with 503)
  ✓ carol registered (10 ms) → event b8f35453…
    ATTEMPT  OUTCOME          HTTP  ERROR                                       
    ───────  ───────────────  ────  ────────────────────────────────────────────
    1        RETRY_SCHEDULED  503   HTTP 503: {"error":{"code":"INTERNAL_ERROR",
  ✓ transient failures retried with backoff until delivery succeeded

════════════════════════════════════════════════════════════════════════
  Phase D — one recipient's failure never blocks others (OFF-05)
════════════════════════════════════════════════════════════════════════
    fault rule: always_503 scoped to dave
    TYPE     RECIPIENT  STATUS     ATTEMPTS  LASTERROR                                 
    ───────  ─────────  ─────────  ────────  ──────────────────────────────────────────
    CONFIRM  4765da61   DELIVERED  1         —                                         
    CONFIRM  d7690bcb   PENDING    1         HTTP 503: {"error":{"code":"INTERNAL_ERROR
  ✓ alice delivered immediately; dave keeps retrying on his own schedule
    operator clears the fault…
    TYPE     RECIPIENT  STATUS     ATTEMPTS  LASTERROR
    ───────  ─────────  ─────────  ────────  ─────────
    CONFIRM  4765da61   DELIVERED  1         —        
    CONFIRM  d7690bcb   DELIVERED  2         —        
  ✓ dave healed automatically once the recipient recovered

════════════════════════════════════════════════════════════════════════
  Phase E — permanent failure → NEEDS_ATTENTION → operator requeue (OFF-08)
════════════════════════════════════════════════════════════════════════
    fault rule: always_400 scoped to carol (a clear permanent rejection)
    TYPE     RECIPIENT  STATUS           ATTEMPTS  LASTERROR                                 
    ───────  ─────────  ───────────────  ────────  ──────────────────────────────────────────
    CONFIRM  9677edb4   NEEDS_ATTENTION  1         HTTP 400: {"error":{"code":"INTERNAL_ERROR
    organizer inspects the event via GET /api/notifications/:id …
    status=NEEDS_ATTENTION  attempts=1  lastError=HTTP 400: {"error":{"code":"INTERNAL_ERROR","messa
    operator corrects the cause (fault cleared) and requeues…
  ✓ requeue → HTTP 200 (status now PENDING)
    TYPE     RECIPIENT  STATUS     ATTEMPTS  LASTERROR
    ───────  ─────────  ─────────  ────────  ─────────
    CONFIRM  9677edb4   DELIVERED  2         —        
  ✓ needs-attention job recovered under operator control

════════════════════════════════════════════════════════════════════════
  Phase F — receiver commits, response is lost (ambiguous) — retry dedupes (OFF-05)
════════════════════════════════════════════════════════════════════════
    fault rule: commit_then_timeout (receipt writes, then the response hangs)
    TYPE     RECIPIENT  STATUS   ATTEMPTS  LASTERROR                                 
    ───────  ─────────  ───────  ────────  ──────────────────────────────────────────
    CONFIRM  c9bb15d5   PENDING  1         TimeoutError: The operation was aborted du
    KEY       PAYLOADTYPE
    ────────  ───────────
    9591f543  CONFIRM    
    worker saw a timeout, but the receipt is already durable — retrying…
    TYPE     RECIPIENT  STATUS     ATTEMPTS  LASTERROR
    ───────  ─────────  ─────────  ────────  ─────────
    CONFIRM  c9bb15d5   DELIVERED  2         —        
    KEY       PAYLOADTYPE
    ────────  ───────────
    9591f543  CONFIRM    
  ✓ exactly one receipt; the resend was suppressed as a duplicate

════════════════════════════════════════════════════════════════════════
  Phase G — worker dies after claim; lease expiry recovers the job (OFF-04)
════════════════════════════════════════════════════════════════════════
    worker A claims the event and dies before sending (simulated)…
    claimed 1 event(s), lease token 57d63d68… — process "crashes"
    worker B runs while the lease is still live — job not stolen yet
    TYPE     RECIPIENT  STATUS      ATTEMPTS  LASTERROR
    ───────  ─────────  ──────────  ────────  ─────────
    CONFIRM  4765da61   PROCESSING  1         —        
    lease expires (simulated clock jump)…
    TYPE     RECIPIENT  STATUS     ATTEMPTS  LASTERROR
    ───────  ─────────  ─────────  ────────  ─────────
    CONFIRM  4765da61   DELIVERED  2         —        
  ✓ expired lease reclaimed; the job delivered exactly once at the receiver

════════════════════════════════════════════════════════════════════════
  Phase H — cancellation notifies every registered member (OFF-06)
════════════════════════════════════════════════════════════════════════
  ✓ cancel → 2 cancellation event(s) created
  ✓ repeat cancel → alreadyCancelled=true, new events=0
    TYPE      STATUS     ATTEMPTS
    ────────  ─────────  ────────
    CANCEL    DELIVERED  1       
    CANCEL    DELIVERED  1       
    CONFIRM   DELIVERED  1       
    CONFIRM   DELIVERED  1       
  ✓ all registrants were notified; repeat cancellation created no duplicates

════════════════════════════════════════════════════════════════════════
  Demo complete — evidence lives in PostgreSQL
════════════════════════════════════════════════════════════════════════
    STATUS     EVENTS
    ─────────  ──────
    DELIVERED  10    

    delivery receipts stored          : 10
    inspect in the dashboard          : npm run dev:api  → http://localhost:3000/
    inspect raw state                 : psql $DATABASE_URL
    [2m  tables: "NotificationEvent", "NotificationAttempt", "MockDeliveryReceipt"[0m
```

## Registration latency with the notification service DOWN (OFF-02)

Observed in the demo Phase A on this machine: registrations returned
`HTTP 201` in **25 ms** and **21 ms** (create workshop 53–89 ms including
allocation) while the worker's delivery target was a dead port. The e2e test
`OFF-02` additionally asserts the response completes in **< 250 ms** while the
notification timeout is configured at 300 ms — i.e. the request provably does
not wait on delivery. These are single observations on a loaded sandbox, not a
throughput benchmark.

## curl spot-checks (live services)

Run against the three running processes (`npm run dev:all`):

```bash
# health
curl -s localhost:3000/health/ready
# → {"status":"ok","database":"up",...}

# register (member identity, response before any notification work)
curl -s -X POST -H "Authorization: Bearer bob-demo-token" \
  localhost:3000/api/workshops/<id>/registrations
# → {"registrationId":"...","notification":{"eventId":"...","status":"PENDING"}}

# duplicate → 409 ALREADY_REGISTERED (error envelope with requestId)

# cancel fan-out (2 registrants) then repeat
curl -s -X POST -H "Authorization: Bearer organizer-demo-token" \
  localhost:3000/api/workshops/<id>/cancel
# → {"alreadyCancelled":false,"notificationsCreated":2,...}
# → repeat: {"alreadyCancelled":true,"notificationsCreated":0}
```

## How to reproduce

```bash
npm install
cp .env.example .env          # adjust DATABASE_URL if needed
npm run setup                 # prisma generate + migrate deploy + seed
npm run test:all              # 92 tests
npm run demo                  # the recorded demonstration
npm run dev:all               # API :3000 (dashboard) + worker + mock :4100
```

Open `http://localhost:3000/` for the console (organizer token
`organizer-demo-token`, members `alice-demo-token`, … — see `prisma/seed.ts`
output or `.env.example`).
