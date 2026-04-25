# TOMS Phase 4: E2E & Simulator Handoff

## Project Status Overview
- **Phase 3 Summary**: Stabilization is complete. Core logic refactored for multi-tenancy, dynamic configuration, and atomic rate limiting.
- **Test Integrity**: 100% Pass Rate (94 Unit, 82 Integration).
- **Core Stack**: NestJS, TypeORM (SQLite), Axios (with Circuit Breaker/Retry), Express (Mock HCM).

---

## Technical Architecture Reference

### 1. HCM Client Layer (`HcmClientModule`)
- **Dynamic Config**: Uses `TenantRepository` to inject per-request credentials from the database.
- **Resilience**: `opossum` (Circuit Breaker) wrapped around `axios` with `axios-retry` (exponential backoff).
- **Key Methods**: `deduct()`, `credit()`, `fetchBalances()`, `getBalance()`.

### 2. Atomic Rate Limiting
- **Implementation**: Database-backed `RateLimitGuard` using `upsert` and `INCREMENT` to prevent window-initialization race conditions.
- **Limits**: 10 submissions per minute per user; 10 active `PENDING_APPROVAL` requests per employee.

### 3. Outbox Pattern
- **Logic**: All HCM-impacting actions (`Approval`, `Admin-Cancel`) are written to an `OutboxEvent` table atomically with the state change.
- **Worker**: Stateless processor that handles retries (up to 5 attempts) and `DEAD_LETTER` escalation.

---

## Next Steps: Phase 4 Implementation Plan

### 1. E2E Stack Verification
- [ ] Spin up `docker-compose` with TOMS and `mock-hcm-service`.
- [ ] Run `npm run test:e2e` to verify full life-cycle stability.

### 2. Performance & Security Stress Tests
- [ ] Hammer the Approve endpoint with 100+ concurrent requests for the same user via `Promise.all`.
- [ ] Verify `LARGE_RECONCILIATION_DRIFT` alerts trigger when external HCM balance drifts > 5 days.
- [ ] Benchmarking 1000+ record syncs via the HMAC-secured batch webhook.

### 3. Year-Boundary Simulation
- [ ] Simulate New Year boundary (Dec 31 23:59:59) and verify `SPOT_SYNC` correctly updates balances during Jan 1st submissions.

---

## Handoff Instructions for New AI Session

**Copy and paste this into the new chat:**

> "I am handing over the **Time-Off Microservice (TOMS)** project. Phase 3 (Stabilization) is finished. Please read the `test-suite.md` and `handoff-phase-4.md` for full architectural context.
>
> **Task 1**: Initialize the Phase 4 environment. Verify Docker Compose can spin up the stack.
> **Task 2**: Fix any remaining E2E test failures (if any) and ensure the worker doesn't double-process events.
> **Task 3**: Focus on Year-Boundary logic and performance benchmarking for batch syncs."

---

## Key Files Path Map
- **Core HCM Logic**: `src/hcm-client/hcm-client.service.ts`
- **Security Guard**: `src/security/rate-limit/rate-limit.guard.ts`
- **Sync/Outbox**: `src/outbox/outbox.service.ts`
- **Full Test Specs**: `test/integration/` and `test/e2e/`
