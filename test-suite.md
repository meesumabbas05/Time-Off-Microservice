# TOMS Test Suite
## ExampleHR — Time-Off Microservice (TOMS)

**Version:** 1.1  
**Author:** Meesum Abbas  
**Linked TRD:** [TRD-time-off-microservice.md](./TRD-time-off-microservice.md)
**Last Updated:** 2026-04-25  
**Coverage Targets:** Statement ≥ 90% | Branch ≥ 85% | Security (C-13–C-20) 100% | All Challenges (C-01–C-24) ≥ 1 named test case

---

## Table of Contents

1. [Testing Philosophy & Strategy](#1-testing-philosophy--strategy)
2. [Test Infrastructure & Tooling](#2-test-infrastructure--tooling)
3. [Unit Tests](#3-unit-tests)
   - 3.1 [BalanceService](#31-balanceservice)
   - 3.2 [TimeOffRequestService](#32-timeoffrequestservice)
   - 3.3 [HcmSyncService](#33-hcmsyncservice)
   - 3.4 [ReconciliationService](#34-reconciliationservice)
   - 3.5 [Guards & Security Layer](#35-guards--security-layer)
   - 3.6 [DTOs & Validation Pipe](#36-dtos--validation-pipe)
   - 3.7 [Outbox Worker](#37-outbox-worker)
   - 3.8 [Utility Functions](#38-utility-functions)
   - 3.9 [HcmClientModule — Circuit Breaker & Retry](#39-hcmclientmodule--circuit-breaker--retry)
4. [Integration Tests](#4-integration-tests)
   - 4.1 [Balance Lifecycle](#41-balance-lifecycle)
   - 4.2 [Request Submission Flow](#42-request-submission-flow)
   - 4.3 [Manager Approval Flow](#43-manager-approval-flow)
   - 4.4 [Concurrent Requests & Serialization](#44-concurrent-requests--serialization)
   - 4.5 [Sync & Outbox](#45-sync--outbox)
   - 4.6 [Security & Access Control](#46-security--access-control)
   - 4.7 [Cancellation Flow](#47-cancellation-flow)
   - 4.8 [Admin & Audit](#48-admin--audit)
   - 4.9 [Request Read Endpoints](#49-request-read-endpoints)
5. [End-to-End Tests](#5-end-to-end-tests)
   - 5.1 [Full Lifecycle Scenarios](#51-full-lifecycle-scenarios)
   - 5.2 [Failure & Recovery Scenarios](#52-failure--recovery-scenarios)
   - 5.3 [Year-Boundary & Timing Scenarios](#53-year-boundary--timing-scenarios)
   - 5.4 [Batch Sync Scenarios](#54-batch-sync-scenarios)
6. [Challenge Coverage Matrix](#6-challenge-coverage-matrix)
7. [Mock HCM Control Reference](#7-mock-hcm-control-reference)
8. [Test Data Fixtures](#8-test-data-fixtures)

---

## 1. Testing Philosophy & Strategy

### Guiding Principles

TOMS is a **manager-gated write-through cache** of HCM balances. The highest-risk failure modes are:
1. **Balance over-deduction** — approving more days than are available.
2. **Security bypass** — an actor performing actions beyond their role or ownership scope.
3. **Dual-write inconsistency** — locally approved but HCM never debited (or vice versa).
4. **Stale-data decisions** — eligibility checks against cached balances that no longer reflect HCM truth.

The test suite is **risk-ordered**: concurrency correctness and security enforcement are tested exhaustively before happy-path coverage. Every TRD challenge (`C-01` through `C-24`) maps to at least one named test case, with security challenges (`C-13–C-20`) requiring both an **attack attempt** and a **legitimate equivalent**.

### Test Pyramid Distribution

```
               ┌──────────────────────────────────┐
               │    E2E / Contract Tests (10%)     │  ~25 scenarios
               │  Full stack: NestJS + SQLite +    │
               │  mock HCM (Docker Compose)        │
               └──────────────────────────────────┘
          ┌────────────────────────────────────────────┐
          │       Integration Tests (40%)              │  ~80 scenarios
          │  Service layer + real SQLite DB +          │
          │  mock HCM HTTP client                      │
          └────────────────────────────────────────────┘
      ┌────────────────────────────────────────────────────┐
      │              Unit Tests (50%)                      │  ~120 scenarios
      │  Isolated service/guard/utility logic;             │
      │  all external deps mocked via Jest                 │
      └────────────────────────────────────────────────────┘
```

### Test ID Scheme

Each test case is assigned a unique ID using the following scheme:

| Prefix | Layer | Example |
|---|---|---|
| `UT-` | Unit Test | `UT-BAL-001` |
| `IT-` | Integration Test | `IT-SUB-001` |
| `E2E-` | End-to-End Test | `E2E-LC-001` |

Sub-prefixes group tests by subsystem (e.g., `BAL` = BalanceService, `SUB` = Submission, `APR` = Approval, `SEC` = Security, `SYN` = Sync/Outbox, `AUD` = Audit, `LC` = Lifecycle, `FR` = Failure/Recovery, `YB` = Year-Boundary).

---

## 2. Test Infrastructure & Tooling

### Frameworks & Libraries

| Tool | Purpose |
|---|---|
| **Jest** | Primary test runner, assertions, mocking (`jest.fn()`, `jest.spyOn()`) |
| **Supertest** | HTTP-level integration and E2E testing against the NestJS app |
| **@nestjs/testing** | `Test.createTestingModule()` for wiring partial DI containers |
| **TypeORM in-memory SQLite** | Integration test DB — fresh instance per test suite, migrations applied via `synchronize: true` |
| **Express mock-hcm** | Lightweight HCM simulator with control endpoints (see §7) |
| **Docker Compose** | E2E environment — `toms` + `mock-hcm` services |
| **faker.js** | Deterministic fixture generation for UUIDs, dates, amounts |

### Test Environment Setup

```typescript
// jest.config.ts (unit tests)
{
  testMatch: ['**/*.unit.spec.ts'],
  moduleNameMapper: { '@/(.*)': '<rootDir>/src/$1' },
  coverageThreshold: { global: { statements: 90, branches: 85 } }
}

// jest.config.integration.ts
{
  testMatch: ['**/*.integration.spec.ts'],
  globalSetup: './test/setup/db-bootstrap.ts',    // runs migrations
  globalTeardown: './test/setup/db-teardown.ts',
  testTimeout: 30000
}

// jest.config.e2e.ts
{
  testMatch: ['**/*.e2e.spec.ts'],
  globalSetup: './test/setup/docker-compose-up.ts',
  globalTeardown: './test/setup/docker-compose-down.ts',
  testTimeout: 60000
}
```

### Shared Test Fixtures (see §8 for full definitions)

- `TENANT_A`, `TENANT_B` — two distinct tenant records.
- `EMPLOYEE_ALICE` — 10 days vacation balance, EMPLOYEE role, under MANAGER_BOB.
- `EMPLOYEE_CHARLIE` — 3 days vacation balance, EMPLOYEE role, also under MANAGER_BOB.
- `MANAGER_BOB` — MANAGER role; manages Alice and Charlie; has own employee record.
- `ADMIN_EVE` — ADMIN role.
- `EMPLOYEE_DAVE` — belongs to TENANT_B (cross-tenant fixture).
- All users have pre-signed JWTs available as test constants.

---

## 3. Unit Tests

> **Scope:** Pure service logic with all external dependencies mocked via `jest.fn()`. No HTTP, no real DB, no HCM calls. Each `describe` block creates a fresh DI module.

---

### 3.1 BalanceService

**File:** `src/balance/balance.service.unit.spec.ts`

---

#### UT-BAL-001 — `getAvailableAtApproval` returns correct available days with no approved-but-undeducted requests

- **Method:** `BalanceService.getAvailableAtApproval(tenantId, employeeId, locationId, leaveType)`
- **Setup:** Mock repository returns `balance_days = 10.00`. Mock request repository returns empty sum for approved-but-undeducted requests (`SUM = 0`).
- **Action:** Call `getAvailableAtApproval(...)`.
- **Assert:** Returns `10.00`.
- **Traceability:** C-04, C-05

---

#### UT-BAL-002 — `getAvailableAtApproval` correctly subtracts approved-but-undeducted days

- **Method:** `BalanceService.getAvailableAtApproval(...)`
- **Setup:** `balance_days = 10.00`. Two approved requests with `hcm_request_id = NULL` and `days_requested = 3.00` and `2.00` respectively.
- **Action:** Call `getAvailableAtApproval(...)`.
- **Assert:** Returns `10.00 - 3.00 - 2.00 = 5.00`.
- **Traceability:** C-04, C-05, C-07

---

#### UT-BAL-003 — `getAvailableAtApproval` excludes already-HCM-deducted requests (hcm_request_id IS NOT NULL)

- **Method:** `BalanceService.getAvailableAtApproval(...)`
- **Setup:** `balance_days = 10.00`. One approved request with `hcm_request_id = 'HCM-REF-123'` (already deducted from `balance_days`); one request with `hcm_request_id = NULL` and `days_requested = 4.00`.
- **Action:** Call `getAvailableAtApproval(...)`.
- **Assert:** Returns `10.00 - 4.00 = 6.00` (the HCM-deducted request is not double-counted).
- **Traceability:** C-01, C-04

---

#### UT-BAL-004 — `getAvailableAtApproval` returns 0 when approved-but-undeducted sum equals balance_days

- **Method:** `BalanceService.getAvailableAtApproval(...)`
- **Setup:** `balance_days = 5.00`. One approved undeducted request for `5.00`.
- **Action:** Call `getAvailableAtApproval(...)`.
- **Assert:** Returns `0.00`.
- **Traceability:** C-05

---

#### UT-BAL-005 — `isFresh` returns `true` when `hcm_last_synced` is within FRESHNESS_TTL

- **Method:** `BalanceService.isFresh(balance)`
- **Setup:** `balance.hcm_last_synced = NOW() - 5 minutes`. `FRESHNESS_TTL = 15 minutes`.
- **Action:** Call `isFresh(balance)`.
- **Assert:** Returns `true`.
- **Traceability:** C-16

---

#### UT-BAL-006 — `isFresh` returns `false` when `hcm_last_synced` is older than FRESHNESS_TTL

- **Method:** `BalanceService.isFresh(balance)`
- **Setup:** `balance.hcm_last_synced = NOW() - 20 minutes`. `FRESHNESS_TTL = 15 minutes`.
- **Action:** Call `isFresh(balance)`.
- **Assert:** Returns `false`.
- **Traceability:** C-16

---

#### UT-BAL-007 — `isFresh` returns `false` when `hcm_last_synced` is exactly at TTL boundary

- **Method:** `BalanceService.isFresh(balance)`
- **Setup:** `balance.hcm_last_synced = NOW() - 15 minutes` (exactly).
- **Action:** Call `isFresh(balance)`.
- **Assert:** Returns `false` (boundary is exclusive — at TTL triggers refresh).
- **Traceability:** C-16

---

#### UT-BAL-008 — `refreshFromHcm` writes fetched balance and updates `hcm_last_synced`

- **Method:** `BalanceService.refreshFromHcm(tenantId, employeeId, locationId, leaveType)`
- **Setup:** Mock HCM client returns `{ days: 8.50, asOf: NOW() }`. Mock repository `save` resolves.
- **Action:** Call `refreshFromHcm(...)`.
- **Assert:** Repository `save` called with `balance_days = 8.50` and `hcm_last_synced = asOf`. Audit log entry written with `source = SPOT_SYNC`.
- **Traceability:** C-02, C-16

---

#### UT-BAL-009 — `refreshFromHcm` discards out-of-order HCM response (asOf older than current hcm_last_synced)

- **Method:** `BalanceService.refreshFromHcm(...)`
- **Setup:** Current `hcm_last_synced = T2`. HCM returns `{ days: 10.00, asOf: T1 }` where `T1 < T2`.
- **Action:** Call `refreshFromHcm(...)`.
- **Assert:** Repository `save` NOT called. No audit log entry. Returns current balance unchanged.
- **Traceability:** C-10

---

#### UT-BAL-010 — `refreshFromHcm` writes audit log with `previous_days`, `new_days`, and `delta`

- **Method:** `BalanceService.refreshFromHcm(...)`
- **Setup:** Current `balance_days = 6.00`. HCM returns `{ days: 10.00, asOf: NOW() }`.
- **Action:** Call `refreshFromHcm(...)`.
- **Assert:** Audit log entry has `previous_days = 6.00`, `new_days = 10.00`, `delta = +4.00`, `source = SPOT_SYNC`.
- **Traceability:** C-24

---

#### UT-BAL-011 — `getAvailableAtApproval` handles fractional days correctly (DECIMAL arithmetic)

- **Method:** `BalanceService.getAvailableAtApproval(...)`
- **Setup:** `balance_days = 5.50`. Approved-undeducted sum = `2.50`.
- **Action:** Call `getAvailableAtApproval(...)`.
- **Assert:** Returns `3.00` exactly (no floating-point error, DECIMAL-aware subtraction).
- **Traceability:** C-23

---

#### UT-BAL-012 — `refreshFromHcm` propagates HCM client errors (circuit-breaker open)

- **Method:** `BalanceService.refreshFromHcm(...)`
- **Setup:** Mock HCM client throws `CircuitBreakerOpenError`.
- **Action:** Call `refreshFromHcm(...)`.
- **Assert:** Error propagates; no DB write; no audit log entry.
- **Traceability:** C-08

---

### 3.2 TimeOffRequestService

**File:** `src/time-off-request/time-off-request.service.unit.spec.ts`

---

#### UT-REQ-001 — `submitRequest` creates a PENDING_APPROVAL record when balance is sufficient and fresh

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** Mock `BalanceService.isFresh` returns `true`. Mock `BalanceService.getBalance` returns `10.00`. `dto.days_requested = 5.00`.
- **Action:** Call `submitRequest(...)`.
- **Assert:** Repository `save` called with `status = PENDING_APPROVAL`. Returns `202 Accepted` shape `{ requestId, status: 'PENDING_APPROVAL' }`.
- **Traceability:** C-02

---

#### UT-REQ-002 — `submitRequest` triggers HCM freshness refresh when balance is stale before eligibility check

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** Mock `BalanceService.isFresh` returns `false`. Mock `refreshFromHcm` resolves. Post-refresh balance = `10.00`. `dto.days_requested = 5.00`.
- **Action:** Call `submitRequest(...)`.
- **Assert:** `BalanceService.refreshFromHcm` called exactly once before the eligibility check. Request created successfully.
- **Traceability:** C-16

---

#### UT-REQ-003 — `submitRequest` rejects with `INSUFFICIENT_BALANCE` (422) when balance < days_requested

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** Fresh balance = `3.00`. `dto.days_requested = 5.00`.
- **Action:** Call `submitRequest(...)`.
- **Assert:** Throws `InsufficientBalanceException` (HTTP 422). No record inserted into DB.
- **Traceability:** C-02

---

#### UT-REQ-004 — `submitRequest` rejects with `PENDING_REQUEST_LIMIT_REACHED` (429) when pending count ≥ 10

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** Mock repository count returns `10` for `PENDING_APPROVAL` status.
- **Action:** Call `submitRequest(...)`.
- **Assert:** Throws `PendingRequestLimitException` (HTTP 429) before freshness check is invoked. `BalanceService.isFresh` NOT called.
- **Traceability:** C-20

---

#### UT-REQ-005 — `submitRequest` rejects with `PENDING_REQUEST_LIMIT_REACHED` at exactly 10 pending requests (boundary)

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** Pending count = `10` (boundary, not `> 10`).
- **Action:** Call `submitRequest(...)`.
- **Assert:** Throws `PendingRequestLimitException`. Response body includes `{ currentPending: 10 }`.
- **Traceability:** C-20

---

#### UT-REQ-006 — `submitRequest` succeeds at 9 pending requests (one below cap)

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** Pending count = `9`. Balance is fresh and sufficient.
- **Action:** Call `submitRequest(...)`.
- **Assert:** Request created successfully, no cap rejection.
- **Traceability:** C-20

---

#### UT-REQ-007 — `submitRequest` does NOT modify any balance column on success

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** Fresh balance = `10.00`. `dto.days_requested = 5.00`.
- **Action:** Call `submitRequest(...)`.
- **Assert:** `leave_balances` repository `save` NOT called. `balance_days` remains `10.00`. No audit log entry for SUBMISSION source written.
- **Traceability:** C-04, C-05 (no reservation)

---

#### UT-REQ-008 — `approveRequest` sets status to APPROVED and creates outbox HCM_DEDUCT event in same transaction

- **Method:** `TimeOffRequestService.approveRequest(requestId, managerId)`
- **Setup:** Request in `PENDING_APPROVAL`. Available balance after aggregate = `5.00`. `days_requested = 3.00`. Mock `BEGIN IMMEDIATE` transaction succeeds.
- **Action:** Call `approveRequest(...)`.
- **Assert:** Request status updated to `APPROVED`. `decided_by = managerId`. `decided_at` set. Outbox event inserted with `event_type = HCM_DEDUCT` and `idempotency_key = request.idempotency_key`.
- **Traceability:** C-01, C-08

---

#### UT-REQ-009 — `approveRequest` rejects with `BALANCE_INSUFFICIENT_AT_APPROVAL` (409) when available_days < days_requested at approval time

- **Method:** `TimeOffRequestService.approveRequest(requestId, managerId)`
- **Setup:** `balance_days = 3.00`. Approved-undeducted sum = `2.00` → `available_days = 1.00`. `days_requested = 2.00`.
- **Action:** Call `approveRequest(...)`.
- **Assert:** Throws `BalanceInsufficientAtApprovalException` (HTTP 409). Response includes `currentAvailableDays` and list of competing approved requests. Status NOT changed.
- **Traceability:** C-04, C-05, C-07

---

#### UT-REQ-010 — `approveRequest` rejects with `SELF_APPROVAL_FORBIDDEN` (403) when manager is the submitter

- **Method:** `TimeOffRequestService.approveRequest(requestId, managerId)`
- **Setup:** Request `employee_id = managerId` (same user).
- **Action:** Call `approveRequest(...)`.
- **Assert:** Throws `SelfApprovalForbiddenException` (HTTP 403). No DB writes.
- **Traceability:** C-14

---

#### UT-REQ-011 — `approveRequest` enforces freshness re-check of balance at approval time (stale balance triggers HCM refresh)

- **Method:** `TimeOffRequestService.approveRequest(requestId, managerId)`
- **Setup:** Balance `hcm_last_synced` is stale (> 15 min ago). Mock `refreshFromHcm` returns updated balance `5.00`.
- **Action:** Call `approveRequest(...)`.
- **Assert:** `BalanceService.refreshFromHcm` called. Approval proceeds against refreshed balance.
- **Traceability:** C-07, C-16

---

#### UT-REQ-012 — `rejectRequest` sets status to REJECTED and records `decided_by` and `decided_at`

- **Method:** `TimeOffRequestService.rejectRequest(requestId, managerId, reason)`
- **Setup:** Request in `PENDING_APPROVAL`.
- **Action:** Call `rejectRequest(...)`.
- **Assert:** Status = `REJECTED`. `decided_by = managerId`. `decided_at` set. No balance column touched. No outbox event created.
- **Traceability:** State machine

---

#### UT-REQ-013 — `rejectRequest` does NOT deduct from balance

- **Method:** `TimeOffRequestService.rejectRequest(...)`
- **Setup:** `balance_days = 5.00`. Request `days_requested = 3.00`.
- **Action:** Call `rejectRequest(...)`.
- **Assert:** `leave_balances.balance_days` still `5.00`. No audit log entry with `source = REJECTION`.
- **Traceability:** C-01

---

#### UT-REQ-014 — `cancelRequest` sets status to CANCELLED for PENDING_APPROVAL request

- **Method:** `TimeOffRequestService.cancelRequest(requestId, employeeId)`
- **Setup:** Request in `PENDING_APPROVAL`. `employee_id = employeeId`.
- **Action:** Call `cancelRequest(...)`.
- **Assert:** Status = `CANCELLED`. No balance deduction.
- **Traceability:** C-12

---

#### UT-REQ-015 — `cancelRequest` throws for a request not in PENDING_APPROVAL status

- **Method:** `TimeOffRequestService.cancelRequest(...)`
- **Setup:** Request in `APPROVED` status.
- **Action:** Call `cancelRequest(...)`.
- **Assert:** Throws `InvalidStateTransitionException` (HTTP 409). Status unchanged.
- **Traceability:** State machine / C-12

---

#### UT-REQ-016 — `cancelRequest` throws `FORBIDDEN` when employee does not own the request

- **Method:** `TimeOffRequestService.cancelRequest(...)`
- **Setup:** `request.employee_id != cancellingEmployeeId`.
- **Action:** Call `cancelRequest(...)`.
- **Assert:** Throws `ForbiddenException` (HTTP 403).
- **Traceability:** C-13 (ownership enforcement)

---

#### UT-REQ-017 — `submitRequest` uses `employeeId` from JWT, NOT from DTO body

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** `dto` includes `employeeId = 'ANOTHER_EMPLOYEE'`. `user.userId = 'ALICE_ID'`.
- **Action:** Call `submitRequest(...)`.
- **Assert:** Saved record uses `employee_id = 'ALICE_ID'`, not value from DTO.
- **Traceability:** C-15

---

#### UT-REQ-018 — `approveRequest` response includes `available_days` and competing requests on 409

- **Method:** `TimeOffRequestService.approveRequest(...)`
- **Setup:** Insufficient available balance scenario (as UT-REQ-009). Two competing approved-but-undeducted requests in the system.
- **Action:** Call `approveRequest(...)`.
- **Assert:** Exception payload includes `{ currentAvailableDays: X, competingRequests: [...] }`.
- **Traceability:** C-05

---

#### UT-REQ-019 — `submitRequest` handles fractional day requests (e.g., 0.5 days)

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** Balance = `5.50`. `dto.days_requested = 0.50`.
- **Action:** Call `submitRequest(...)`.
- **Assert:** Request created. Eligibility check uses DECIMAL comparison. Balance not modified.
- **Traceability:** C-23

---

#### UT-REQ-020 — `submitRequest` uses employee's timezone for calendar date calculation

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** `user.timezone = 'Asia/Karachi'` (UTC+5). `dto.startDate = '2026-01-01'`, `dto.endDate = '2026-01-03'`. UTC wall clock is `2025-12-31T21:00:00Z`.
- **Action:** Call `submitRequest(...)`.
- **Assert:** `days_requested` calculated as `3` calendar days in PST (not UTC). Start/end dates stored as submitted, not shifted.
- **Traceability:** C-22

---

#### UT-REQ-021 — `submitRequest` validates date range (end_date must be ≥ start_date)

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** `dto.startDate = '2026-03-10'`, `dto.endDate = '2026-03-05'` (end before start).
- **Action:** Call `submitRequest(...)`.
- **Assert:** Throws `InvalidDateRangeException` (HTTP 400). No DB write.
- **Traceability:** C-22 (date arithmetic)

---

### 3.3 HcmSyncService

**File:** `src/hcm-sync/hcm-sync.service.unit.spec.ts`

---

#### UT-SYN-001 — `processBatchSync` applies all records atomically and commits when all valid

- **Method:** `HcmSyncService.processBatchSync(payload)`
- **Setup:** Payload with 3 valid records. Mock DB transaction commits successfully.
- **Action:** Call `processBatchSync(...)`.
- **Assert:** All 3 `leave_balances` upserted. 3 audit log entries written (`source = BATCH_SYNC`). Returns `{ synced: 3, skipped: 0 }`.
- **Traceability:** C-09

---

#### UT-SYN-002 — `processBatchSync` rolls back entire transaction if any record causes DB error

- **Method:** `HcmSyncService.processBatchSync(payload)`
- **Setup:** 3 records; DB throws on insertion of second record.
- **Action:** Call `processBatchSync(...)`.
- **Assert:** Transaction rolled back. No records persisted (first record not committed either). Returns HTTP 500 / throws `BatchSyncFailureException`.
- **Traceability:** C-09

---

#### UT-SYN-003 — `processBatchSync` skips records where `asOf` ≤ `hcm_last_synced` (out-of-order protection)

- **Method:** `HcmSyncService.processBatchSync(payload)`
- **Setup:** Record A has `asOf = T_old < hcm_last_synced`. Record B is new (`asOf = T_new > hcm_last_synced`).
- **Action:** Call `processBatchSync(...)`.
- **Assert:** Record A skipped. Record B upserted. Returns `{ synced: 1, skipped: 1 }`. No audit log for skipped record.
- **Traceability:** C-10

---

#### UT-SYN-004 — `processBatchSync` rejects entire batch if any record is structurally invalid

- **Method:** `HcmSyncService.processBatchSync(payload)`
- **Setup:** 3 records; record 2 has missing `leaveType` field.
- **Action:** Call `processBatchSync(...)`.
- **Assert:** Validation phase (Phase 1, no writes) rejects batch with HTTP 400. Zero DB writes.
- **Traceability:** C-09

---

#### UT-SYN-005 — `processBatchSync` verifies HMAC signature before processing

- **Method:** `HcmSyncService.processBatchSync(payload, signature, tenantSecret)`
- **Setup:** Mismatched HMAC signature.
- **Action:** Call `processBatchSync(...)`.
- **Assert:** Throws `HmacVerificationFailedException` (HTTP 401). No processing occurs.
- **Traceability:** C-18

---

#### UT-SYN-006 — `processBatchSync` rejects duplicate nonce (replay protection)

- **Method:** `HcmSyncService.processBatchSync(payload)`
- **Setup:** Mock nonce store returns `true` for `payload.nonce` (already processed within 24h).
- **Action:** Call `processBatchSync(...)`.
- **Assert:** Throws `ReplayAttackDetectedException` (HTTP 401). No processing.
- **Traceability:** C-18

---

#### UT-SYN-007 — `processBatchSync` accepts the same payload after 24h nonce expiry (nonce window)

- **Method:** `HcmSyncService.processBatchSync(payload)`
- **Setup:** Nonce was stored 25h ago (expired). Mock nonce store returns `false`.
- **Action:** Call `processBatchSync(...)`.
- **Assert:** Batch processed normally. New nonce stored.
- **Traceability:** C-18

---

#### UT-SYN-008 — `triggerManualSync` fetches balances for all active employees in tenant and writes audit log

- **Method:** `HcmSyncService.triggerManualSync(tenantId, adminId)`
- **Setup:** 5 active employees. Mock HCM client returns balances for all 5.
- **Action:** Call `triggerManualSync(...)`.
- **Assert:** 5 HCM calls made. 5 `leave_balances` records updated. 5 audit log entries with `source = MANUAL_SYNC`, `actor = adminId`.
- **Traceability:** C-24

---

### 3.4 ReconciliationService

**File:** `src/reconciliation/reconciliation.service.unit.spec.ts`

---

#### UT-REC-001 — Reconciliation job selects only employees with stale balances or active PENDING requests

- **Method:** `ReconciliationService.runReconciliation()`
- **Setup:** Employee A: `hcm_last_synced = 35 min ago` (stale). Employee B: `hcm_last_synced = 5 min ago`, no pending requests. Employee C: `hcm_last_synced = 5 min ago`, has pending request.
- **Action:** Call `runReconciliation()`.
- **Assert:** HCM balance fetched for A and C. Employee B NOT fetched.
- **Traceability:** §4.6 Layer 3

---

#### UT-REC-002 — Reconciliation corrects divergence greater than 0.5 days

- **Method:** `ReconciliationService.runReconciliation()`
- **Setup:** Local `balance_days = 10.00`. HCM returns `9.00`. Drift = `1.00 > 0.5`.
- **Action:** Call `runReconciliation()`.
- **Assert:** Local balance updated to `9.00`. Audit log entry with `source = RECONCILIATION`. `RECONCILIATION_DRIFT` event logged.
- **Traceability:** §4.6 Layer 3

---

#### UT-REC-003 — Reconciliation does NOT update when drift is ≤ 0.5 days

- **Method:** `ReconciliationService.runReconciliation()`
- **Setup:** Local `balance_days = 10.00`. HCM returns `10.40`. Drift = `0.40 ≤ 0.5`.
- **Action:** Call `runReconciliation()`.
- **Assert:** No DB write. No audit log entry.
- **Traceability:** §4.6 Layer 3

---

#### UT-REC-004 — Reconciliation raises HR Admin alert when drift > 5 days

- **Method:** `ReconciliationService.runReconciliation()`
- **Setup:** Local `balance_days = 15.00`. HCM returns `8.00`. Drift = `7.00 > 5`.
- **Action:** Call `runReconciliation()`.
- **Assert:** Alert service called with `LARGE_RECONCILIATION_DRIFT` event. `alertEmployeeId` and drift amount included.
- **Traceability:** §4.6 Layer 3

---

#### UT-REC-005 — Reconciliation writes out-of-order protection during correction (does not apply stale HCM data)

- **Method:** `ReconciliationService.runReconciliation()`
- **Setup:** Local `hcm_last_synced = T2`. HCM returns response with `asOf = T1 < T2`.
- **Action:** Call `runReconciliation()`.
- **Assert:** Balance NOT updated. Audit log NOT written.
- **Traceability:** C-10

---

### 3.5 Guards & Security Layer

**File:** `src/auth/guards/*.guard.unit.spec.ts`

---

#### UT-SEC-001 — `JwtAuthGuard` rejects request with no Authorization header (401)

- **Guard:** `JwtAuthGuard`
- **Setup:** HTTP request with no `Authorization` header.
- **Action:** `canActivate()` called.
- **Assert:** Returns `false` / throws `UnauthorizedException` (HTTP 401).
- **Traceability:** §4.2 Auth Layer

---

#### UT-SEC-002 — `JwtAuthGuard` rejects request with expired JWT (401)

- **Guard:** `JwtAuthGuard`
- **Setup:** JWT signed 2 hours ago with 1-hour expiry.
- **Assert:** Throws `UnauthorizedException`. `userId` NOT attached to request context.
- **Traceability:** §4.2 Auth Layer

---

#### UT-SEC-003 — `JwtAuthGuard` accepts valid JWT and attaches `{ userId, tenantId, role }` to request

- **Guard:** `JwtAuthGuard`
- **Setup:** Valid JWT signed with correct secret, not expired.
- **Assert:** `canActivate()` returns `true`. `req.user` has `{ userId, tenantId, role }`.
- **Traceability:** §4.2 Auth Layer

---

#### UT-SEC-004 — `RbacGuard` rejects EMPLOYEE role on MANAGER-only endpoint (403)

- **Guard:** `RbacGuard`
- **Setup:** `req.user.role = 'EMPLOYEE'`. Endpoint decorated with `@Roles('MANAGER')`.
- **Assert:** Returns `false` / throws `ForbiddenException` (HTTP 403).
- **Traceability:** C-13

---

#### UT-SEC-005 — `RbacGuard` allows ADMIN on MANAGER-only endpoint (role hierarchy)

- **Guard:** `RbacGuard`
- **Setup:** `req.user.role = 'ADMIN'`. Endpoint decorated with `@Roles('MANAGER')`.
- **Assert:** Returns `true`.
- **Traceability:** §4.2 Role Matrix

---

#### UT-SEC-006 — `RbacGuard` allows MANAGER on MANAGER-only endpoint

- **Guard:** `RbacGuard`
- **Setup:** `req.user.role = 'MANAGER'`. Endpoint `@Roles('MANAGER')`.
- **Assert:** Returns `true`.
- **Traceability:** §4.2 Role Matrix

---

#### UT-SEC-007 — `OwnershipGuard` rejects when route `employeeId` ≠ `req.user.userId`

- **Guard:** `OwnershipGuard`
- **Setup:** `req.params.employeeId = 'CHARLIE_ID'`. `req.user.userId = 'ALICE_ID'`.
- **Assert:** Throws `ForbiddenException` (HTTP 403) with reason `EMPLOYEE_ID_MISMATCH`.
- **Traceability:** C-15

---

#### UT-SEC-008 — `OwnershipGuard` allows MANAGER to access their team member's data

- **Guard:** `OwnershipGuard`
- **Setup:** `req.user.role = 'MANAGER'`. `employeeId` belongs to a reportee of this manager.
- **Assert:** Returns `true`.
- **Traceability:** §4.2 Role Matrix

---

#### UT-SEC-009 — `OwnershipGuard` blocks MANAGER from accessing non-team employee data

- **Guard:** `OwnershipGuard`
- **Setup:** `req.user.role = 'MANAGER'`. `employeeId` belongs to employee in a different manager's team.
- **Assert:** Throws `ForbiddenException` (HTTP 403).
- **Traceability:** §4.2 Role Matrix

---

#### UT-SEC-010 — `TenantScopeInterceptor` appends `tenantId` to all repository queries automatically

- **Interceptor:** `TenantScopeInterceptor`
- **Setup:** Spy on `QueryBuilder.andWhere`. `req.user.tenantId = 'TENANT_A'`.
- **Action:** Interceptor executes.
- **Assert:** All downstream repository calls include `WHERE tenant_id = 'TENANT_A'` clause.
- **Traceability:** C-17

---

#### UT-SEC-011 — `RateLimitGuard` (throughput) rejects when user exceeds 10 submissions per minute

- **Guard:** `RateLimitGuard`
- **Setup:** Sliding-window counter for `userId` = `10` (at limit).
- **Action:** Another submission attempt.
- **Assert:** Throws `TooManyRequestsException` (HTTP 429) with rate limit reason.
- **Traceability:** C-20

---

#### UT-SEC-012 — `RateLimitGuard` (throughput) allows request when counter is below limit

- **Guard:** `RateLimitGuard`
- **Setup:** Sliding-window counter = `5`.
- **Assert:** Returns `true`. Counter incremented.
- **Traceability:** C-20

---

#### UT-SEC-013 — Self-approval check fires before balance re-validation (guard ordering)

- **Method:** `TimeOffRequestService.approveRequest(...)`
- **Setup:** Manager is the submitter. Balance would otherwise be sufficient.
- **Assert:** `SELF_APPROVAL_FORBIDDEN` (403) thrown before any balance logic executes.
- **Traceability:** C-14

---

### 3.6 DTOs & Validation Pipe

**File:** `src/dto/*.dto.unit.spec.ts`

---

#### UT-DTO-001 — `CreateTimeOffRequestDto` strips unknown fields (`whitelist: true`)

- **DTO:** `CreateTimeOffRequestDto`
- **Input:** `{ locationId, leaveType, startDate, endDate, timezone, status: 'APPROVED', decidedBy: 'hacker' }`
- **Assert:** Validated object contains only whitelisted fields. `status` and `decidedBy` stripped.
- **Traceability:** C-19

---

#### UT-DTO-002 — `CreateTimeOffRequestDto` rejects request with non-whitelisted fields when `forbidNonWhitelisted: true`

- **DTO:** `CreateTimeOffRequestDto`
- **Input:** `{ ..., unknownField: 'injected' }`
- **Assert:** `ValidationPipe` throws `BadRequestException` (HTTP 400) with details about forbidden field.
- **Traceability:** C-19

---

#### UT-DTO-003 — `CreateTimeOffRequestDto` rejects `days_requested: 0.001` (minimum value enforcement)

- **DTO:** `CreateTimeOffRequestDto`
- **Input:** `{ ..., days_requested: 0.001 }` (below minimum of `0.5`)
- **Assert:** ValidationPipe rejects with HTTP 400. Constraint: `@Min(0.5)`.
- **Traceability:** C-19, C-23

---

#### UT-DTO-004 — `ApproveRequestDto` requires `managerId` matching JWT payload

- **DTO:** `ApproveRequestDto`
- **Input:** `{ managerId: 'DIFFERENT_MANAGER' }`. JWT `userId = 'MANAGER_BOB'`.
- **Assert:** Service rejects with `MANAGER_ID_MISMATCH` (HTTP 403).
- **Traceability:** §4.4 Endpoints

---

#### UT-DTO-005 — `BatchSyncDto` validates that `records` array is non-empty

- **DTO:** `BatchSyncDto`
- **Input:** `{ tenantId, nonce, records: [] }`
- **Assert:** ValidationPipe rejects with HTTP 400.
- **Traceability:** C-09

---

#### UT-DTO-006 — `CreateTimeOffRequestDto` rejects negative `days_requested`

- **DTO:** `CreateTimeOffRequestDto`
- **Input:** `{ days_requested: -1 }`
- **Assert:** Rejects with HTTP 400. No request created.
- **Traceability:** C-23

---

### 3.7 Outbox Worker

**File:** `src/outbox/outbox.worker.unit.spec.ts`

---

#### UT-OBX-001 — Outbox worker picks up `PENDING` events and calls the correct HCM operation

- **Method:** `OutboxWorker.processEvents()`
- **Setup:** Two `PENDING` outbox events: one `HCM_DEDUCT`, one `HCM_CREDIT`. Mock HCM client resolves both.
- **Action:** Call `processEvents()`.
- **Assert:** `HcmClient.deduct()` called for deduct event. `HcmClient.credit()` called for credit event. Both event statuses updated to `DONE`.
- **Traceability:** C-08, C-11

---

#### UT-OBX-002 — Outbox worker increments `attempt_count` on retriable HCM error and does not mark DONE

- **Method:** `OutboxWorker.processEvents()`
- **Setup:** HCM client throws 503 for the deduct event.
- **Assert:** `attempt_count` incremented to `1`. Status remains `PENDING`. Event re-queued for next cycle.
- **Traceability:** C-08, C-11

---

#### UT-OBX-003 — Outbox worker marks event `DEAD_LETTER` after 5 failed attempts

- **Method:** `OutboxWorker.processEvents()`
- **Setup:** Event `attempt_count = 4`. HCM client throws 503.
- **Assert:** `attempt_count = 5`. Status = `DEAD_LETTER`. Alert service called with `HCM_DEAD_LETTER` event.
- **Traceability:** C-08, C-11

---

#### UT-OBX-004 — Outbox worker uses idempotency key on each HCM call (safe retry)

- **Method:** `OutboxWorker.processEvents()`
- **Setup:** Event has `idempotency_key = 'KEY-123'`.
- **Assert:** HCM client called with `X-Idempotency-Key: KEY-123` header. Same key used on all retry attempts.
- **Traceability:** C-01, C-11

---

#### UT-OBX-005 — Outbox worker does NOT re-process `DONE` or `DEAD_LETTER` events

- **Method:** `OutboxWorker.processEvents()`
- **Setup:** Three events: statuses `['DONE', 'DEAD_LETTER', 'PENDING']`.
- **Assert:** HCM client called exactly once (for the `PENDING` event only).
- **Traceability:** C-11

---

#### UT-OBX-006 — Outbox worker processes events ordered by `created_at ASC` (FIFO)

- **Method:** `OutboxWorker.processEvents()`
- **Setup:** Two `PENDING` events with different `created_at` times. Mock HCM resolves both.
- **Assert:** Older event processed first.
- **Traceability:** §4.2 Outbox Worker

---

#### UT-OBX-007 — Outbox worker updates `balance_days` and sets `hcm_request_id` after successful HCM deduction

- **Method:** `OutboxWorker.processEvents()`
- **Setup:** `HCM_DEDUCT` event for request with `days_requested = 3.00`. HCM returns `{ hcm_request_id: 'HCM-456' }`.
- **Assert:** `leave_balances.balance_days` decremented by `3.00`. `time_off_requests.hcm_request_id = 'HCM-456'`. Audit log entry with `source = APPROVAL`.
- **Traceability:** C-01, C-24

---

#### UT-OBX-008 — Outbox worker marks request status `FAILED` on non-retriable HCM error (4xx)

- **Method:** `OutboxWorker.processEvents()`
- **Setup:** HCM returns 422 `INVALID_DIMENSIONS`.
- **Assert:** Event status = `DEAD_LETTER`. Request status = `FAILED`. `failure_reason` populated. Alert raised.
- **Traceability:** C-06

---

### 3.8 Utility Functions

**File:** `src/utils/*.util.unit.spec.ts`

---

#### UT-UTL-001 — `computeBusinessDays` returns correct count for date range in UTC+5 timezone

- **Function:** `computeBusinessDays(startDate, endDate, timezone)`
- **Input:** `startDate = '2026-01-05'`, `endDate = '2026-01-09'`, `timezone = 'Asia/Karachi'`
- **Assert:** Returns `5` (Mon–Fri).
- **Traceability:** C-22

---

#### UT-UTL-002 — `computeBusinessDays` correctly handles DST boundary for timezone-aware calculation

- **Function:** `computeBusinessDays(...)`
- **Input:** Date range spanning DST change. `timezone = 'America/New_York'`.
- **Assert:** Days calculated without off-by-one error at DST transition.
- **Traceability:** C-22

---

#### UT-UTL-003 — `verifyHmac` returns `true` for valid signature

- **Function:** `verifyHmac(payload, secret, signature)`
- **Input:** `HMAC-SHA256(payload, secret)` correctly computed.
- **Assert:** Returns `true`.
- **Traceability:** C-18

---

#### UT-UTL-004 — `verifyHmac` returns `false` for tampered payload

- **Function:** `verifyHmac(payload, secret, signature)`
- **Input:** Valid signature, but payload has been modified.
- **Assert:** Returns `false`.
- **Traceability:** C-18

---

#### UT-UTL-005 — `decimalSubtract` performs exact subtraction without floating-point error

- **Function:** `decimalSubtract(10.1, 0.1)`
- **Assert:** Returns `10.0` exactly (not `10.000000000000002`).
- **Traceability:** C-23

---

### 3.9 HcmClientModule — Circuit Breaker & Retry

**File:** `src/hcm-client/hcm-client.module.unit.spec.ts`

---

#### UT-HCM-001 — Circuit breaker opens after 5 consecutive HCM failures for a tenant

- **Module:** `HcmClientModule` (`opossum` wrapping per-tenant Axios instance)
- **Setup:** Mock Axios instance returns 503 for 5 consecutive calls targeting the same tenant.
- **Action:** Call `HcmClient.deduct(...)` 5 times.
- **Assert:** On the 5th failure the circuit breaker state transitions to `OPEN`. The 6th call fails immediately with `CircuitBreakerOpenError` without making a network call. Call count to mock Axios not increased past 5.
- **Traceability:** C-08, §4.2 HCM Client Module

---

#### UT-HCM-002 — Circuit breaker does NOT open on non-5xx errors (4xx are business errors, not circuit-trip events)

- **Module:** `HcmClientModule`
- **Setup:** Mock Axios returns 422 (business-level rejection) for 5 consecutive calls.
- **Action:** 5 calls.
- **Assert:** Circuit breaker remains `CLOSED`. No `CircuitBreakerOpenError` raised.
- **Traceability:** C-06, C-08

---

#### UT-HCM-003 — Circuit breaker half-opens after 30 seconds and allows a probe request

- **Module:** `HcmClientModule`
- **Setup:** Circuit is `OPEN`. Advance fake timer by 30 seconds (`jest.useFakeTimers`).
- **Action:** Attempt one call.
- **Assert:** State transitions to `HALF_OPEN`. One call is made to the mock Axios instance.
- **Traceability:** C-08, §4.2

---

#### UT-HCM-004 — Circuit breaker closes after a successful probe in HALF_OPEN state

- **Module:** `HcmClientModule`
- **Setup:** State is `HALF_OPEN`. Probe call succeeds (mock returns 200).
- **Action:** Probe call executes.
- **Assert:** Circuit transitions to `CLOSED`. Subsequent calls proceed normally.
- **Traceability:** C-08, §4.2

---

#### UT-HCM-005 — Axios-retry retries 3 times with exponential backoff on 5xx before circuit counts failure

- **Module:** `HcmClientModule` (axios-retry configuration)
- **Setup:** Mock Axios returns 503 for 3 attempts, then 200 on the 4th.
- **Action:** One logical `HcmClient.deduct(...)` call.
- **Assert:** Underlying Axios called 4 times. Delays between retries approximately 500ms → 1000ms → 2000ms (verified via fake timers). Final result is successful (200 returned).
- **Traceability:** C-08, §4.2

---

#### UT-HCM-006 — HcmClientModule injects per-tenant credentials from `tenants` table

- **Module:** `HcmClientModule`
- **Setup:** Two tenants with different `hcm_base_url` and `hcm_api_key` values. Mock tenants repository.
- **Action:** `HcmClient.deduct(...)` called for each tenant.
- **Assert:** Tenant A call uses `hcm_base_url_A` and `Authorization: hcm_api_key_A`. Tenant B uses its own credentials. No credential cross-contamination.
- **Traceability:** C-17, §4.2

---

#### UT-HCM-007 — All outbound HCM calls include `X-Idempotency-Key` header

- **Module:** `HcmClientModule`
- **Setup:** Mock Axios captures outgoing request headers.
- **Action:** Call `HcmClient.deduct(...)` with idempotency key `KEY-ABC`.
- **Assert:** `X-Idempotency-Key: KEY-ABC` present in the intercepted request headers.
- **Traceability:** C-01, C-11

---

#### UT-DIM-001 — `validateDimensionCombination` rejects leave type not applicable for employee's location

- **Method:** `TimeOffRequestService.validateDimensionCombination(employeeId, locationId, leaveType)`
- **Setup:** Employee location is `LOC-PK`. `leaveType = 'PARENTAL'` which is not configured for `LOC-PK` in the tenant's leave policy.
- **Action:** Called internally during `submitRequest`.
- **Assert:** Throws `InvalidDimensionCombinationException` (HTTP 422). HCM not called. No request record created.
- **Traceability:** C-21

---

#### UT-DIM-002 — `validateDimensionCombination` passes for valid combination (happy path)

- **Method:** `TimeOffRequestService.validateDimensionCombination(...)`
- **Setup:** `leaveType = 'VACATION'` is valid for `LOC-PK` in tenant policy.
- **Assert:** No exception raised. Submission flow proceeds.
- **Traceability:** C-21

---

#### UT-DIM-003 — `validateDimensionCombination` check runs BEFORE HCM call (TOMS does not rely on HCM to catch invalid dims)

- **Method:** `TimeOffRequestService.submitRequest(dto, user)`
- **Setup:** Invalid dimension combination. Balance is fresh and sufficient.
- **Assert:** `HcmClient` NOT called. Exception raised locally. Validates defence-in-depth (C-06).
- **Traceability:** C-21, C-06

---

---

## 4. Integration Tests

> **Scope:** The NestJS application is bootstrapped with a real in-memory SQLite DB (migrations applied). HCM calls are made to a locally-started mock Express server. HTTP calls made via Supertest. Each `describe` block seeds its own data and clears the DB after.

---

### 4.1 Balance Lifecycle

**File:** `test/integration/balance.integration.spec.ts`

---

#### IT-BAL-001 — `GET /balances/:employeeId` returns cached balance with freshness metadata

- **Endpoint:** `GET /api/v1/balances/ALICE_ID`
- **Setup:** Alice's balance seeded: `balance_days = 10.00`, `hcm_last_synced = NOW() - 5 min`.
- **Request:** Auth as ALICE. No `?refresh=true`.
- **Assert:** HTTP 200. Body includes `balance_days`, `hcm_last_synced`, `isFresh: true`.
- **Traceability:** §4.4 Endpoints

---

#### IT-BAL-002 — `GET /balances/:employeeId?refresh=true` forces live HCM fetch and updates balance

- **Endpoint:** `GET /api/v1/balances/ALICE_ID?refresh=true`
- **Setup:** Alice's balance seeded: `balance_days = 5.00`. Mock HCM returns `8.00`.
- **Request:** Auth as ALICE.
- **Assert:** HTTP 200. Response `balance_days = 8.00`. DB record updated. Audit log entry `source = SPOT_SYNC`.
- **Traceability:** C-16, §4.4

---

#### IT-BAL-003 — `GET /balances/:employeeId` returns 401 with no JWT

- **Endpoint:** `GET /api/v1/balances/ALICE_ID`
- **Request:** No Authorization header.
- **Assert:** HTTP 401.
- **Traceability:** §4.2 Auth

---

#### IT-BAL-004 — EMPLOYEE cannot read another employee's balance (403)

- **Endpoint:** `GET /api/v1/balances/CHARLIE_ID`
- **Request:** Auth as ALICE (EMPLOYEE).
- **Assert:** HTTP 403.
- **Traceability:** C-15, §4.2

---

#### IT-BAL-005 — MANAGER can read their own direct report's balance

- **Endpoint:** `GET /api/v1/balances/ALICE_ID`
- **Request:** Auth as BOB (ALICE's manager).
- **Assert:** HTTP 200. Returns Alice's balance.
- **Traceability:** §4.2 Role Matrix

---

#### IT-BAL-006 — ADMIN can read any employee's balance across the tenant

- **Endpoint:** `GET /api/v1/balances/CHARLIE_ID`
- **Request:** Auth as EVE (ADMIN).
- **Assert:** HTTP 200. Returns Charlie's balance.
- **Traceability:** §4.2 Role Matrix

---

#### IT-BAL-007 — `GET /balances/:employeeId` returns `available_days` computed as balance_days minus approved-undeducted requests

- **Endpoint:** `GET /api/v1/balances/ALICE_ID/:locationId/:leaveType`
- **Setup:** Alice: `balance_days = 10.00`. One approved-undeducted request for `3.00`.
- **Assert:** Response `available_days = 7.00`. `balance_days = 10.00`.
- **Traceability:** C-04

---

### 4.2 Request Submission Flow

**File:** `test/integration/submission.integration.spec.ts`

---

#### IT-SUB-001 — Happy path: employee submits valid request, receives 202, request stored as PENDING_APPROVAL

- **Endpoint:** `POST /api/v1/requests`
- **Setup:** Alice: `balance_days = 10.00`, fresh. Mock HCM not required (no HCM call at submission).
- **Body:** `{ locationId, leaveType, startDate: '2026-06-01', endDate: '2026-06-05', timezone: 'Asia/Karachi' }`
- **Request:** Auth as ALICE.
- **Assert:** HTTP 202. Body: `{ requestId, status: 'PENDING_APPROVAL' }`. DB record has `employee_id = ALICE_ID`.
- **Traceability:** §4.5 Full Submission Flow

---

#### IT-SUB-002 — Submission with insufficient balance returns 422 INSUFFICIENT_BALANCE

- **Endpoint:** `POST /api/v1/requests`
- **Setup:** Charlie: `balance_days = 2.00`, fresh. `days_requested = 5`.
- **Assert:** HTTP 422. Body: `{ error: 'INSUFFICIENT_BALANCE', availableBalance: 2.00 }`. No record in DB.
- **Traceability:** C-02

---

#### IT-SUB-003 — Submission triggers mandatory HCM freshness refresh when balance is stale (> 15 min)

- **Endpoint:** `POST /api/v1/requests`
- **Setup:** Alice: `hcm_last_synced = 20 min ago`. Mock HCM returns `8.00`.
- **Assert:** Mock HCM `GET /balances` called. Balance updated to `8.00` before eligibility check. HTTP 202 created.
- **Traceability:** C-02, C-16

---

#### IT-SUB-004 — 10th pending request is accepted; 11th returns 429 PENDING_REQUEST_LIMIT_REACHED

- **Endpoint:** `POST /api/v1/requests`
- **Setup:** Alice already has 10 `PENDING_APPROVAL` requests.
- **Assert:** HTTP 429. Body: `{ error: 'PENDING_REQUEST_LIMIT_REACHED', currentPending: 10 }`.
- **Traceability:** C-20

---

#### IT-SUB-005 — Submission with `employeeId` in body pointing to different employee is rejected 403

- **Endpoint:** `POST /api/v1/requests`
- **Body:** `{ ..., employeeId: 'CHARLIE_ID' }` — Alice's JWT.
- **Assert:** HTTP 403 `EMPLOYEE_ID_MISMATCH`. Record created uses `ALICE_ID` from JWT (or request rejected if guard runs first).
- **Traceability:** C-15, C-19

---

#### IT-SUB-006 — Submission with unknown extra fields returns 400 (forbidden non-whitelisted)

- **Endpoint:** `POST /api/v1/requests`
- **Body:** `{ ..., status: 'APPROVED', decidedBy: 'manager_id' }`
- **Assert:** HTTP 400. Body lists forbidden fields. No DB write.
- **Traceability:** C-19

---

#### IT-SUB-007 — Two concurrent submissions against the same balance both pass to PENDING_APPROVAL (by design)

- **Endpoint:** `POST /api/v1/requests` (concurrent)
- **Setup:** Charlie: `balance_days = 3.00`. Two simultaneous `POST /requests` for `2.00` days each.
- **Action:** Fire both requests with `Promise.all`.
- **Assert:** Both receive HTTP 202. Both records in DB with `PENDING_APPROVAL`. `balance_days` NOT changed.
- **Traceability:** C-04 (intentional design)

---

#### IT-SUB-008 — Submission with `days_requested = 0` is rejected by DTO validation (400)

- **Endpoint:** `POST /api/v1/requests`
- **Body:** `{ ..., days_requested: 0 }`
- **Assert:** HTTP 400. No record created.
- **Traceability:** C-23

---

#### IT-SUB-009 — Employee (not manager) cannot submit a request using the approve endpoint (403)

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`
- **Request:** Auth as ALICE (EMPLOYEE).
- **Assert:** HTTP 403 (RBAC guard). No status change.
- **Traceability:** C-13

---

#### IT-SUB-010 — Submission response `requestId` is a valid UUID v4

- **Endpoint:** `POST /api/v1/requests`
- **Setup:** Valid submission.
- **Assert:** `requestId` in response matches UUID v4 regex.
- **Traceability:** §2 Tech Stack (UUID v4)

---

### 4.3 Manager Approval Flow

**File:** `test/integration/approval.integration.spec.ts`

---

#### IT-APR-001 — Happy path: manager approves request, status becomes APPROVED, outbox event created

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`
- **Setup:** Alice request `PENDING_APPROVAL`, `days_requested = 3.00`. Alice `balance_days = 10.00`.
- **Request:** Auth as BOB (manager).
- **Assert:** HTTP 200. `status = APPROVED`. Outbox event inserted: `HCM_DEDUCT`, `status = PENDING`.
- **Traceability:** C-01, §4.5 Approval Flow

---

#### IT-APR-002 — Manager rejects request, status becomes REJECTED, no outbox event, no balance change

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/reject`
- **Setup:** Alice request `PENDING_APPROVAL`.
- **Body:** `{ reason: 'Team conflict' }`
- **Assert:** HTTP 200. `status = REJECTED`. No outbox event. `balance_days` unchanged.
- **Traceability:** C-01

---

#### IT-APR-003 — Employee cannot approve their own request (self-approval blocked, 403)

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`
- **Setup:** Request where `employee_id = BOB_ID`. Bob also has a MANAGER role.
- **Request:** Auth as BOB.
- **Assert:** HTTP 403 `SELF_APPROVAL_FORBIDDEN`.
- **Traceability:** C-14

---

#### IT-APR-004 — Manager cannot approve a request belonging to a non-reportee (403)

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`
- **Setup:** Request belongs to DAVE (in a different team). Auth as BOB.
- **Assert:** HTTP 403. Request status unchanged.
- **Traceability:** §4.2 Role Matrix

---

#### IT-APR-005 — Approval of non-existent request returns 404

- **Endpoint:** `PATCH /api/v1/requests/NON_EXISTENT_ID/approve`
- **Assert:** HTTP 404.
- **Traceability:** §4.4 Endpoints

---

#### IT-APR-006 — Approval of already-APPROVED request returns 409 (invalid state transition)

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`
- **Setup:** Request status already `APPROVED`.
- **Assert:** HTTP 409. Status unchanged.
- **Traceability:** State machine

---

#### IT-APR-007 — Approval triggers HCM freshness re-check when balance is stale at approval time

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`
- **Setup:** Balance `hcm_last_synced = 20 min ago`. Mock HCM returns fresh balance.
- **Assert:** Mock HCM `GET /balances` called before re-validation proceeds.
- **Traceability:** C-07, C-16

---

#### IT-APR-008 — Approval fails with 409 when balance changed between submission and approval (C-07)

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`
- **Setup:** Alice submitted request for `5.00` days when balance was `8.00`. Balance reduced to `4.00` via batch sync before approval.
- **Assert:** HTTP 409 `BALANCE_INSUFFICIENT_AT_APPROVAL`. Response includes `currentAvailableDays: 4.00`. Request remains `PENDING_APPROVAL`.
- **Traceability:** C-07

---

#### IT-APR-009 — `decided_by`, `decided_at` fields are populated correctly after approval

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`
- **Assert:** `decided_by = BOB_ID`, `decided_at` is a valid ISO timestamp.
- **Traceability:** §4.3 Data Model

---

#### IT-APR-010 — Approval-time re-validation reads live aggregate, not a cached value

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`  
- **Setup:** Two approved-undeducted requests already in DB (reducing effective balance). A third request approval attempted.
- **Assert:** Re-validation correctly sums all approved-but-undeducted requests at query time; no stale read.
- **Traceability:** C-04, C-05, C-07

---

### 4.4 Concurrent Requests & Serialization

**File:** `test/integration/concurrency.integration.spec.ts`

---

#### IT-CON-001 — Two concurrent approval attempts for the same employee are serialized; second fails with 409

- **Endpoint:** `PATCH /api/v1/requests/:id/approve` (concurrent)
- **Setup:** Charlie: `balance_days = 3.00`. Two `PENDING_APPROVAL` requests each for `2.00` days. Two managers attempt to approve both simultaneously via `Promise.all`.
- **Assert:** Exactly one request succeeds (HTTP 200, status = APPROVED). Other returns HTTP 409 `BALANCE_INSUFFICIENT_AT_APPROVAL`. Net deduction never exceeds `balance_days`.
- **Traceability:** C-04, C-05

---

#### IT-CON-002 — 50 concurrent submission attempts against same employee — at most one record created per request (no phantom rows)

- **Endpoint:** `POST /api/v1/requests` (50 concurrent)
- **Setup:** Charlie: `balance_days = 10.00`. 50 concurrent `POST /requests`.
- **Assert:** All accepted (balance is sufficient). Exactly 50 unique `requestId` values returned. No duplicate records in DB.
- **Traceability:** C-04, C-20

---

#### IT-CON-003 — Sequential approvals correctly decrement available balance via live aggregate

- **Endpoint:** `PATCH /api/v1/requests/:id/approve` (sequential)
- **Setup:** Alice: `balance_days = 10.00`. Three pending requests: `3.00`, `3.00`, `5.00`. Manager approves in order.
- **Assert:** First approval (3.00): succeeds. Second approval (3.00): succeeds (available = 4.00). Third approval (5.00): fails 409 (available = 1.00).
- **Traceability:** C-05

---

#### IT-CON-004 — Concurrent approval attempts for different employees do not interfere

- **Endpoint:** `PATCH /api/v1/requests/:id/approve` (concurrent for different employees)
- **Setup:** Alice and Charlie each have one pending request. Concurrent approval of both.
- **Assert:** Both approvals succeed independently and correctly.
- **Traceability:** C-04

---

#### IT-CON-005 — Concurrent submissions capped at 10 pending; race condition does not allow >10

- **Endpoint:** `POST /api/v1/requests` (concurrent)
- **Setup:** Alice has 9 pending requests. 5 concurrent submissions fired simultaneously.
- **Assert:** Exactly 1 additional request created (10th). Remaining 4 receive 429. Total pending = 10.
- **Traceability:** C-20

---

### 4.5 Sync & Outbox

**File:** `test/integration/sync-outbox.integration.spec.ts`

---

#### IT-SYN-001 — Outbox worker calls HCM deduct and updates balance_days on success

- **Trigger:** Outbox worker `processEvents()`
- **Setup:** Approved request, `HCM_DEDUCT` PENDING outbox event. Mock HCM returns 200 `{ hcm_request_id: 'HCM-789' }`.
- **Assert:** `balance_days` decremented. `hcm_request_id = 'HCM-789'`. Outbox event `DONE`. Audit log written (`source = APPROVAL`).
- **Traceability:** C-01, C-08, C-24

---

#### IT-SYN-002 — Outbox worker retries on HCM 503 (transient failure) with exponential backoff

- **Trigger:** Outbox worker (2 invocations)
- **Setup:** First call: mock HCM returns 503. Second call (simulated): mock HCM returns 200.
- **Assert:** First invocation: `attempt_count = 1`, event still `PENDING`. Second invocation: event `DONE`, balance updated.
- **Traceability:** C-08, C-11

---

#### IT-SYN-003 — Outbox event survives service restart (persisted to DB, picked up on next worker run)

- **Setup:** Approved request + `HCM_DEDUCT` outbox event committed to DB. Simulate restart by re-starting worker without in-memory state.
- **Assert:** Worker picks up the event from DB. HCM call made. Event marked `DONE`.
- **Traceability:** C-11

---

#### IT-SYN-004 — Batch sync atomicity: all records applied or none (mid-batch DB error → rollback)

- **Endpoint:** `POST /api/v1/sync/balances/batch`
- **Setup:** Batch of 5 records. DB is set up to fail on the 3rd record (e.g., constraint violation).
- **Assert:** HTTP 500 / 400. DB state shows ZERO records updated (full rollback).
- **Traceability:** C-09

---

#### IT-SYN-005 — Batch sync skips out-of-order records (asOf earlier than hcm_last_synced)

- **Endpoint:** `POST /api/v1/sync/balances/batch`
- **Setup:** 3 records: record 1 has `asOf = T_old` (stale), records 2 and 3 have fresh `asOf`.
- **Assert:** HTTP 200 `{ synced: 2, skipped: 1 }`. Record 1 balance unchanged.
- **Traceability:** C-10

---

#### IT-SYN-006 — Batch sync webhook rejects HMAC mismatch (401)

- **Endpoint:** `POST /api/v1/sync/balances/batch`
- **Setup:** Correct payload, incorrect `X-HCM-Signature`.
- **Assert:** HTTP 401. No records processed.
- **Traceability:** C-18

---

#### IT-SYN-007 — Batch sync webhook rejects replayed nonce (401)

- **Endpoint:** `POST /api/v1/sync/balances/batch`
- **Setup:** Same nonce sent twice within 24h.
- **Assert:** Second call: HTTP 401 `REPLAY_ATTACK_DETECTED`. No records processed on second call.
- **Traceability:** C-18

---

#### IT-SYN-008 — Manual sync trigger (ADMIN) fetches and updates all tenant balances

- **Endpoint:** `POST /api/v1/sync/balances/trigger`
- **Setup:** 3 employees in tenant. Mock HCM returns updated balances.
- **Request:** Auth as EVE (ADMIN).
- **Assert:** HTTP 202. All 3 balances updated. Audit log entries `source = MANUAL_SYNC`.
- **Traceability:** §4.4

---

#### IT-SYN-009 — Non-ADMIN attempt to trigger manual sync returns 403

- **Endpoint:** `POST /api/v1/sync/balances/trigger`
- **Request:** Auth as ALICE (EMPLOYEE).
- **Assert:** HTTP 403.
- **Traceability:** §4.4 Role Matrix

---

#### IT-SYN-010 — Reconciliation job detects HCM drift and corrects local balance

- **Method:** `ReconciliationService.runReconciliation()` (triggered directly in test)
- **Setup:** Alice local `balance_days = 10.00`. Mock HCM returns `7.00`. Drift = `3.00 > 0.5`.
- **Assert:** `balance_days` updated to `7.00`. Audit log entry `source = RECONCILIATION`.
- **Traceability:** §4.6 Layer 3

---

#### IT-SYN-011 — Cancellation of APPROVED request creates HCM_CREDIT outbox event

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/cancel` (on an approved request — via ADMIN path)
- **Setup:** Alice's APPROVED request with `hcm_request_id` set.
- **Assert:** Outbox event `HCM_CREDIT` created for the balance to be credited back. Request status = `CANCELLED`.
- **Traceability:** C-12

---

#### IT-SYN-012 — HCM_CREDIT outbox event retried on failure (same durability as HCM_DEDUCT)

- **Trigger:** Outbox worker for `HCM_CREDIT` event
- **Setup:** Mock HCM rejects credit call on first attempt (503), succeeds on second.
- **Assert:** `attempt_count` incremented after first failure. Credit applied on second attempt. Balance restored.
- **Traceability:** C-12

---

### 4.6 Security & Access Control

**File:** `test/integration/security.integration.spec.ts`

---

#### IT-SEC-001 — [ATTACK] Employee calls manager approval endpoint → 403

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`
- **Request:** Auth as ALICE (EMPLOYEE role).
- **Assert:** HTTP 403 (RBAC guard). Request unchanged.
- **Traceability:** C-13

---

#### IT-SEC-002 — [LEGITIMATE] Manager calls approve endpoint for their team's request → 200

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/approve`
- **Request:** Auth as BOB (MANAGER). Request belongs to ALICE (BOB's reportee).
- **Assert:** HTTP 200. Request approved.
- **Traceability:** C-13

---

#### IT-SEC-003 — [ATTACK] Manager-role user approves their own submitted request → 403 SELF_APPROVAL_FORBIDDEN

- **Endpoint:** `PATCH /api/v1/requests/BOB_REQ/approve`
- **Setup:** BOB submitted a request. BOB tries to approve it.
- **Assert:** HTTP 403 `SELF_APPROVAL_FORBIDDEN`.
- **Traceability:** C-14

---

#### IT-SEC-004 — [LEGITIMATE] Manager approves a different employee's request (not self) → 200

- **Endpoint:** `PATCH /api/v1/requests/ALICE_REQ/approve`
- **Request:** Auth as BOB. Request by ALICE.
- **Assert:** HTTP 200.
- **Traceability:** C-14

---

#### IT-SEC-005 — [ATTACK] Employee submits request with another employee's ID in body → 403

- **Endpoint:** `POST /api/v1/requests`
- **Body:** `{ ..., employeeId: 'CHARLIE_ID' }`. Alice's JWT.
- **Assert:** HTTP 403 `EMPLOYEE_ID_MISMATCH`. No record created for CHARLIE.
- **Traceability:** C-15

---

#### IT-SEC-006 — [LEGITIMATE] Employee submits request — employeeId from JWT (no body field) → 202

- **Endpoint:** `POST /api/v1/requests`
- **Body:** No `employeeId` field.
- **Assert:** HTTP 202. Record uses `employee_id = ALICE_ID` from JWT.
- **Traceability:** C-15

---

#### IT-SEC-007 — [ATTACK] Client omits `?refresh=true` to use stale balance; submission-time mandatory refresh still fires

- **Endpoint:** `POST /api/v1/requests`
- **Setup:** Alice balance stale (20 min old). No `?refresh=true` parameter on any prior balance call.
- **Assert:** `BalanceService.refreshFromHcm` called automatically before eligibility check. Cannot be suppressed by client.
- **Traceability:** C-16

---

#### IT-SEC-008 — [LEGITIMATE] `?refresh=true` on GET balance triggers HCM fetch even when balance is fresh

- **Endpoint:** `GET /api/v1/balances/ALICE_ID?refresh=true`
- **Setup:** Balance is fresh (5 min old).
- **Assert:** HCM fetch still invoked. Balance updated.
- **Traceability:** C-16

---

#### IT-SEC-009 — [ATTACK] Tenant A user tries to access Tenant B employee's balance → 403/404

- **Endpoint:** `GET /api/v1/balances/DAVE_ID` (DAVE belongs to Tenant B)
- **Request:** Auth as ALICE (Tenant A JWT).
- **Assert:** HTTP 403 or 404. No Tenant B data in response.
- **Traceability:** C-17

---

#### IT-SEC-010 — [ATTACK] Tenant A user constructs approval for Tenant B request → 403

- **Endpoint:** `PATCH /api/v1/requests/TENANT_B_REQ/approve`
- **Request:** Auth as BOB (Tenant A MANAGER).
- **Assert:** HTTP 403 or 404. Cross-tenant manipulation blocked.
- **Traceability:** C-17

---

#### IT-SEC-011 — [ATTACK] Batch webhook with replayed valid signature → 401 REPLAY_ATTACK_DETECTED

- **Endpoint:** `POST /api/v1/sync/balances/batch`
- **Setup:** First call accepted. Same payload replayed immediately.
- **Assert:** Second call: HTTP 401.
- **Traceability:** C-18

---

#### IT-SEC-012 — [LEGITIMATE] Batch webhook with fresh valid HMAC → 200

- **Endpoint:** `POST /api/v1/sync/balances/batch`
- **Setup:** Correct HMAC, unique nonce.
- **Assert:** HTTP 200. Records processed.
- **Traceability:** C-18

---

#### IT-SEC-013 — [ATTACK] Mass assignment: `status: 'APPROVED'` in POST body stripped, request remains PENDING_APPROVAL

- **Endpoint:** `POST /api/v1/requests`
- **Body:** `{ ..., status: 'APPROVED', decidedBy: 'hacker_uuid' }`
- **Assert:** HTTP 400 (forbidden non-whitelisted) OR record stored with `status = PENDING_APPROVAL` and `decided_by = NULL`.
- **Traceability:** C-19

---

#### IT-SEC-014 — [ATTACK] Mass assignment: `days_requested: 0.001` rejected by DTO minimum constraint

- **Endpoint:** `POST /api/v1/requests`
- **Body:** `{ ..., days_requested: 0.001 }`
- **Assert:** HTTP 400.
- **Traceability:** C-19, C-23

---

#### IT-SEC-015 — [ATTACK] Rate limit flooding: 11+ submissions per minute from same user returns 429

- **Endpoint:** `POST /api/v1/requests` (11 rapid-fire requests)
- **Setup:** Balance sufficient for all. No pending cap issue.
- **Assert:** First 10 accepted (HTTP 202). 11th returns HTTP 429 (rate limit, not pending cap).
- **Traceability:** C-20

---

#### IT-SEC-016 — Invalid JWT secret rejected (401)

- **Endpoint:** `GET /api/v1/balances/ALICE_ID`
- **Request:** JWT signed with wrong secret.
- **Assert:** HTTP 401.
- **Traceability:** §4.2 Auth

---

### 4.7 Cancellation Flow

**File:** `test/integration/cancellation.integration.spec.ts`

---

#### IT-CAN-001 — Employee cancels their own PENDING_APPROVAL request → status CANCELLED, no balance change

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/cancel`
- **Request:** Auth as ALICE. Alice's request.
- **Assert:** HTTP 200. Status = `CANCELLED`. `balance_days` unchanged. No outbox event.
- **Traceability:** C-12

---

#### IT-CAN-002 — Employee cannot cancel a request belonging to another employee (403)

- **Endpoint:** `PATCH /api/v1/requests/CHARLIE_REQ/cancel`
- **Request:** Auth as ALICE.
- **Assert:** HTTP 403.
- **Traceability:** C-12, C-13

---

#### IT-CAN-003 — Cancellation of APPROVED request creates HCM_CREDIT outbox event

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/cancel` (ADMIN cancels APPROVED request)
- **Assert:** HTTP 200. Outbox event `HCM_CREDIT` inserted. Request status = `CANCELLED`.
- **Traceability:** C-12

---

#### IT-CAN-004 — Cannot cancel an already REJECTED request (409)

- **Endpoint:** `PATCH /api/v1/requests/REQ_ID/cancel`
- **Setup:** Request in `REJECTED` status.
- **Assert:** HTTP 409. Status unchanged.
- **Traceability:** C-12 / State machine

---

### 4.8 Admin & Audit

**File:** `test/integration/admin.integration.spec.ts`

---

#### IT-AUD-001 — `GET /admin/audit` returns audit log entries for specified employee and date range

- **Endpoint:** `GET /api/v1/admin/audit?employeeId=ALICE_ID&from=2026-01-01&to=2026-12-31`
- **Request:** Auth as EVE (ADMIN).
- **Assert:** HTTP 200. Array of entries, each with `actor`, `timestamp`, `source`, `previousDays`, `newDays`, `delta`, `referenceId`.
- **Traceability:** C-24

---

#### IT-AUD-002 — Non-ADMIN cannot access audit endpoint (403)

- **Endpoint:** `GET /api/v1/admin/audit`
- **Request:** Auth as ALICE.
- **Assert:** HTTP 403.
- **Traceability:** §4.4 Role Matrix

---

#### IT-AUD-003 — Every balance change (submission-check, approval, rejection, sync) creates an audit log entry

- **Setup:** Run: submit → approve → HCM deduct (outbox). Then: sync batch.
- **Assert:** Audit log has entries for each distinct event source: `APPROVAL` (deduction), `BATCH_SYNC`. No entry for `SUBMISSION` (no balance change at submission). All entries have full metadata.
- **Traceability:** C-24

---

#### IT-AUD-004 — Audit log entries include `reference_id` linking to causative entity (requestId or batchJobId)

- **Setup:** Approval creates outbox deduction. Batch sync runs.
- **Assert:** Approval audit entry `reference_id = requestId`. Batch sync entry `reference_id = batchJobId`.
- **Traceability:** C-24

---

#### IT-AUD-005 — `GET /health` returns DB connectivity status and HCM reachability

- **Endpoint:** `GET /api/v1/health`
- **Auth:** None required.
- **Assert:** HTTP 200. Body: `{ db: 'OK', hcm: { tenantA: 'OK' } }`.
- **Traceability:** §4.4 Endpoints

---

#### IT-AUD-006 — `GET /health` returns degraded status when HCM is unreachable

- **Endpoint:** `GET /api/v1/health`
- **Setup:** Mock HCM health check endpoint returns 503.
- **Assert:** HTTP 200. Body: `{ db: 'OK', hcm: { tenantA: 'DEGRADED' } }`. Does not return 5xx itself.
- **Traceability:** §4.4 Endpoints, C-08

---

### 4.9 Request Read Endpoints

**File:** `test/integration/request-read.integration.spec.ts`

---

#### IT-RRD-001 — `GET /requests/:requestId` returns request detail for the owning employee

- **Endpoint:** `GET /api/v1/requests/REQ_ID`
- **Setup:** Alice's request `REQ_ID` in `PENDING_APPROVAL`.
- **Request:** Auth as ALICE.
- **Assert:** HTTP 200. Body contains `{ id, status, days_requested, start_date, end_date, employee_id, submitted_at }`. All fields present.
- **Traceability:** §4.4 Endpoints

---

#### IT-RRD-002 — `GET /requests/:requestId` returns 403 for an employee who does not own the request

- **Endpoint:** `GET /api/v1/requests/CHARLIE_REQ`
- **Request:** Auth as ALICE (different employee).
- **Assert:** HTTP 403.
- **Traceability:** §4.2 Role Matrix, C-13

---

#### IT-RRD-003 — `GET /requests/:requestId` is accessible to the manager of the request's owner

- **Endpoint:** `GET /api/v1/requests/ALICE_REQ`
- **Request:** Auth as BOB (ALICE's manager).
- **Assert:** HTTP 200. Returns Alice's request detail.
- **Traceability:** §4.2 Role Matrix

---

#### IT-RRD-004 — `GET /requests/:requestId` returns 404 for a non-existent request ID

- **Endpoint:** `GET /api/v1/requests/NON_EXISTENT`
- **Request:** Auth as EVE (ADMIN).
- **Assert:** HTTP 404.
- **Traceability:** §4.4 Endpoints

---

#### IT-RRD-005 — `GET /requests` (list) returns only the authenticated employee's own requests

- **Endpoint:** `GET /api/v1/requests`
- **Setup:** Alice has 3 requests. Charlie has 2 requests.
- **Request:** Auth as ALICE.
- **Assert:** HTTP 200. Array contains exactly Alice's 3 requests. Charlie's requests absent.
- **Traceability:** §4.4 Endpoints

---

#### IT-RRD-006 — `GET /requests` (list) supports `?status=PENDING_APPROVAL` filter

- **Endpoint:** `GET /api/v1/requests?status=PENDING_APPROVAL`
- **Setup:** Alice has 1 `PENDING_APPROVAL`, 1 `APPROVED`, 1 `REJECTED` request.
- **Request:** Auth as ALICE.
- **Assert:** HTTP 200. Array contains exactly 1 request with `status = PENDING_APPROVAL`.
- **Traceability:** §4.4 Endpoints

---

#### IT-RRD-007 — `GET /requests` (list) supports `?from=DATE&to=DATE` date range filter

- **Endpoint:** `GET /api/v1/requests?from=2026-06-01&to=2026-06-30`
- **Setup:** Alice has requests in May, June, and July.
- **Request:** Auth as ALICE.
- **Assert:** HTTP 200. Only June requests returned.
- **Traceability:** §4.4 Endpoints

---

#### IT-RRD-008 — MANAGER can list all requests for their team (`?employeeId=ALICE_ID`)

- **Endpoint:** `GET /api/v1/requests?employeeId=ALICE_ID`
- **Request:** Auth as BOB (manager of Alice).
- **Assert:** HTTP 200. Returns Alice's requests.
- **Traceability:** §4.2 Role Matrix

---

#### IT-RRD-009 — MANAGER cannot list requests for employees outside their team (403)

- **Endpoint:** `GET /api/v1/requests?employeeId=DAVE_ID`
- **Request:** Auth as BOB. DAVE belongs to a different manager's team.
- **Assert:** HTTP 403.
- **Traceability:** §4.2 Role Matrix, C-13

---

#### IT-RRD-010 — ADMIN can list requests for any employee in their tenant

- **Endpoint:** `GET /api/v1/requests?employeeId=CHARLIE_ID`
- **Request:** Auth as EVE (ADMIN).
- **Assert:** HTTP 200. Returns Charlie's requests.
- **Traceability:** §4.4 Role Matrix

---

---

## 5. End-to-End Tests

> **Scope:** The complete Docker Compose stack is running: `toms` (NestJS + SQLite) + `mock-hcm` (Express). All HTTP calls go through actual network sockets. Tests use Supertest pointed at `http://localhost:3000`. Mock HCM is controlled via its `/__mock__/` control endpoints.

---

### 5.1 Full Lifecycle Scenarios

**File:** `test/e2e/full-lifecycle.e2e.spec.ts`

---

#### E2E-LC-001 — Complete happy-path: submit → approve → HCM deduct → balance confirmed

- **Actors:** ALICE (employee), BOB (manager).
- **Steps:**
  1. `POST /__mock__/set-balance` — set Alice HCM balance to `10.00`.
  2. `POST /api/v1/requests` — Alice submits 3-day request.
  3. Assert: HTTP 202, `PENDING_APPROVAL`.
  4. `PATCH /api/v1/requests/:id/approve` — BOB approves.
  5. Assert: HTTP 200, `APPROVED`. Outbox event created.
  6. Wait 6 seconds (outbox worker cycle).
  7. `GET /api/v1/balances/ALICE_ID` — check balance.
  8. `POST /__mock__/get-state` — verify HCM received deduction.
  9. Assert: Local `balance_days = 7.00`. `hcm_request_id` populated. HCM balance also `7.00`.
- **Traceability:** C-01, C-04

---

#### E2E-LC-002 — Submit request while balance stale → automatic refresh → correct eligibility decision

- **Steps:**
  1. Set HCM balance to `5.00`. Let local cache go stale (or seed stale record directly).
  2. Alice submits 4-day request.
  3. Assert: Mock HCM `GET /balances` was called. Request created (HTTP 202).
  4. Change HCM balance to `3.00`. Request submitted for 4 days.
  5. Assert: Refresh fires. HTTP 422 returned (locally refreshed balance is now `3.00 < 4.00`).
- **Traceability:** C-02, C-16

---

#### E2E-LC-003 — Two competing pending requests; manager approves first, second fails with 409

- **Steps:**
  1. Charlie: HCM balance `3.00`. Submit request A (`2.00` days), request B (`2.00` days).
  2. Assert: Both HTTP 202, both `PENDING_APPROVAL`.
  3. Manager approves request A.
  4. Assert: HTTP 200, A = `APPROVED`.
  5. Manager attempts approval of request B.
  6. Assert: HTTP 409 `BALANCE_INSUFFICIENT_AT_APPROVAL`. B remains `PENDING_APPROVAL`.
  7. `POST /__mock__/get-state` — HCM deducted only once.
- **Traceability:** C-04, C-05

---

#### E2E-LC-004 — Complete submit → cancel flow (no HCM interaction)

- **Steps:**
  1. Alice submits request (PENDING_APPROVAL).
  2. Alice cancels: `PATCH /requests/:id/cancel`.
  3. Assert: HTTP 200, `CANCELLED`. Mock HCM received no calls.
  4. Check balance: unchanged.
- **Traceability:** C-12

---

#### E2E-LC-005 — Complete submit → approve → outbox deduct → cancel → HCM credit flow

- **Steps:**
  1. Alice submits, BOB approves. Outbox deducts HCM.
  2. ADMIN cancels approved request.
  3. Assert: `HCM_CREDIT` outbox event created.
  4. Wait for outbox worker.
  5. Assert: HCM credit call received. Local balance restored. Audit log shows CANCELLATION entry.
- **Traceability:** C-12, C-24

---

#### E2E-LC-006 — Manager rejection flow: no HCM deduction, balance unchanged

- **Steps:**
  1. Alice submits 5-day request (balance `10.00`).
  2. BOB rejects.
  3. Assert: HTTP 200, `REJECTED`. Wait 6s.
  4. Assert: Mock HCM received no deduction call. Balance remains `10.00`.
- **Traceability:** C-01

---

#### E2E-LC-007 — Full batch sync followed by submission and approval using synced balance

- **Steps:**
  1. Seed local balance `5.00`. Post batch payload with `{ days: 8.00, asOf: NOW() }` for Alice.
  2. Assert: `{ synced: 1, skipped: 0 }`. Alice local balance updated to `8.00`.
  3. Alice submits 7-day request. BOB approves.
  4. Assert: Approval succeeds (available = 8.00 ≥ 7.00).
- **Traceability:** C-09, full lifecycle

---

### 5.2 Failure & Recovery Scenarios

**File:** `test/e2e/failure-recovery.e2e.spec.ts`

---

#### E2E-FR-001 — HCM down at approval time: request APPROVED locally, outbox retries, balance updated when HCM recovers

- **Steps:**
  1. `POST /__mock__/simulate-error` — force next 3 HCM calls to return 503.
  2. Manager approves Alice's request.
  3. Assert: HTTP 200, `APPROVED`. Outbox `PENDING`.
  4. Wait 10s (2 outbox cycles). Assert: `attempt_count = 2`, outbox still `PENDING`.
  5. `POST /__mock__/simulate-error` — clear error mode (HCM recovers).
  6. Wait 6s. Assert: Outbox `DONE`. `balance_days` decremented. `hcm_request_id` set.
- **Traceability:** C-08, C-11

---

#### E2E-FR-002 — Outbox dead-letter: after 5 HCM failures, event is DEAD_LETTER and alert raised

- **Steps:**
  1. `POST /__mock__/simulate-error` — force all calls to 503 permanently.
  2. Approve a request. Wait for outbox to exhaust retries (5 attempts, ~30s).
  3. Assert: Outbox event `DEAD_LETTER`. Request status `FAILED`. Alert logged.
- **Traceability:** C-08, C-11

---

#### E2E-FR-003 — HCM returns 4xx (invalid dimensions) on deduction: request marked FAILED, alert raised

- **Steps:**
  1. Force mock HCM to return 422 on POST /time-off/request.
  2. Approve a request. Wait for outbox.
  3. Assert: `DEAD_LETTER` event. Request `FAILED`. `failure_reason` populated. Alert sent.
- **Traceability:** C-06

---

#### E2E-FR-004 — Idempotency: HCM deduction replayed with same key → HCM returns same result, balance not double-deducted

- **Steps:**
  1. Approve request. Outbox calls HCM with `idempotency_key = K`.
  2. Force mock HCM to: accept K, return success, but TOMS does not receive response (simulate network failure). Outbox retries.
  3. Second call uses same `K`. Mock HCM returns same `hcm_request_id`.
  4. Assert: Balance deducted exactly once. `hcm_request_id` matches. Audit log shows one deduction.
- **Traceability:** C-01, C-11

---

#### E2E-FR-005 — Batch sync partial failure rolls back all changes (atomicity)

- **Steps:**
  1. `POST /__mock__/simulate-error` — configure HCM to fail on record 3 of a 5-record batch at the DB insertion level (seed a bad record directly).
  2. Actually: send a batch where record 3 has an invalid schema field.
  3. Assert: HTTP 400. All 5 employees' balances unchanged in DB.
- **Traceability:** C-09

---

#### E2E-FR-006 — Reconciliation corrects locally-diverged balance after HCM manual correction

- **Steps:**
  1. Seed local balance `10.00`, fresh.
  2. Manually set HCM balance to `6.00` (via `/__mock__/set-balance`).
  3. Trigger `POST /api/v1/sync/balances/trigger` (ADMIN).
  4. Assert: Local balance updated to `6.00`. Audit `source = MANUAL_SYNC`. Drift log entry present.
- **Traceability:** §4.6 Layer 3

---

### 5.3 Year-Boundary & Timing Scenarios

**File:** `test/e2e/year-boundary.e2e.spec.ts`

---

#### E2E-YB-001 — Sub-case B: Employee submits request at 00:01 Jan 1st after HCM has refreshed but TOMS cache is stale

- **Steps:**
  1. Set local stale balance `0.00` (last synced Dec 31 11:59 PM).
  2. Configure mock HCM to return `10.00` (year-start refresh applied).
  3. Alice submits request for `3.00` days at 00:01 AM Jan 1st.
  4. Assert: Mandatory freshness refresh fires (`hcm_last_synced > 15 min`). Balance updated to `10.00`. Request accepted (HTTP 202).
- **Traceability:** C-03 Sub-case B

---

#### E2E-YB-002 — Sub-case C: Partial batch sync — some balances updated, others not; request against partially-refreshed data validated correctly

- **Steps:**
  1. Send batch with 3 records; records 1 & 2 have fresh `asOf`, record 3 has stale `asOf`.
  2. Assert: Records 1 & 2 applied. Record 3 skipped.
  3. Submit request for employee 3 (stale balance). Force freshness check (balance is stale since last sync was old).
  4. Assert: Spot refresh called for employee 3 before eligibility check.
- **Traceability:** C-03 Sub-case C

---

#### E2E-YB-003 — Out-of-order HCM balance update rejected; more-recent value preserved

- **Steps:**
  1. Apply current balance: `8.00` at `T2`.
  2. Submit batch with `asOf = T1 < T2`, value `10.00`.
  3. Assert: Balance remains `8.00`. `{ synced: 0, skipped: 1 }`.
- **Traceability:** C-10

---

#### E2E-YB-004 — Timezone boundary correctness: submission for Jan 1 at 01:00 AM PKT (Dec 31 UTC) uses correct date

- **Steps:**
  1. TOMS server: UTC clock shows `Dec 31 20:00:00 UTC`. Alice: `timezone = Asia/Karachi` (UTC+5) = `Jan 01 01:00:00 PKT`.
  2. Alice submits request for `startDate = 2026-01-01`, `endDate = 2026-01-03`.
  3. Assert: Request stored with `start_date = 2026-01-01` (not shifted). `days_requested = 3`.
- **Traceability:** C-22

---

### 5.4 Batch Sync Scenarios

**File:** `test/e2e/batch-sync.e2e.spec.ts`

---

#### E2E-BS-001 — Valid batch payload with correct HMAC processed successfully

- **Steps:**
  1. Compute `HMAC-SHA256(rawBody, tenant.webhook_secret)`.
  2. `POST /api/v1/sync/balances/batch` with `X-HCM-Signature: <computed>`.
  3. Assert: HTTP 200. Records applied.
- **Traceability:** C-18

---

#### E2E-BS-002 — Replayed batch rejected; original application not affected

- **Steps:**
  1. Submit batch (accepted). Re-submit exact same payload + signature.
  2. Assert: Second call: HTTP 401 `REPLAY_ATTACK_DETECTED`. No data changes from second call.
- **Traceability:** C-18

---

#### E2E-BS-003 — Large batch (1000 records) completes atomically within timeout

- **Steps:**
  1. Generate 1000 valid records. Submit batch.
  2. Assert: HTTP 200. All 1000 records processed. Response time < 5s.
- **Traceability:** C-09, §4.6 Layer 4

---

#### E2E-BS-004 — Batch sync followed immediately by approval: approval uses synced balance

- **Steps:**
  1. Batch pushes Alice balance to `8.00`. Alice submits 7-day request.
  2. BOB approves.
  3. Assert: Approval uses `available_days = 8.00`. Succeeds.
- **Traceability:** C-07, C-09

---

---

## 6. Challenge Coverage Matrix

The table below maps every TRD challenge (`C-01` through `C-24`) to its test cases and confirms coverage at each testing layer.

| Challenge | Description | Unit Tests | Integration Tests | E2E Tests | Coverage |
|---|---|---|---|---|---|
| **C-01** | Dual-Write Consistency at Approval Time | UT-REQ-008, UT-OBX-004, UT-OBX-007 | IT-APR-001, IT-SYN-001, IT-SYN-011 | E2E-LC-001, E2E-FR-001, E2E-FR-004 | ✅ Full |
| **C-02** | Stale Balance → False Eligibility | UT-BAL-008, UT-REQ-002, UT-REQ-003 | IT-SUB-002, IT-SUB-003, IT-BAL-002 | E2E-LC-002 | ✅ Full |
| **C-03** | Year-Start Balance Refresh Race | UT-BAL-005, UT-BAL-006 | IT-SYN-005 | E2E-YB-001, E2E-YB-002 | ✅ Full |
| **C-04** | Concurrent Requests Exhausting Balance | UT-BAL-001, UT-REQ-007 | IT-SUB-007, IT-CON-001, IT-CON-002 | E2E-LC-003 | ✅ Full |
| **C-05** | Manager Approving Two Conflicting Pending | UT-BAL-002, UT-REQ-009, UT-REQ-018 | IT-CON-001, IT-CON-003, IT-APR-010 | E2E-LC-003 | ✅ Full |
| **C-06** | HCM Validation Unreliability | UT-OBX-008 | IT-SYN-001 (TOMS local pre-check) | E2E-FR-003 | ✅ Full |
| **C-07** | Balance Changes Between Submission and Approval | UT-BAL-002, UT-REQ-011 | IT-APR-007, IT-APR-008, IT-APR-010 | E2E-BS-004 | ✅ Full |
| **C-08** | HCM Outage During Approval Deduction | UT-BAL-012, UT-OBX-002, UT-OBX-003 | IT-SYN-002, IT-AUD-006 | E2E-FR-001, E2E-FR-002 | ✅ Full |
| **C-09** | Batch Sync Partial Failure (Atomicity) | UT-SYN-002, UT-SYN-004 | IT-SYN-004 | E2E-BS-003, E2E-FR-005, E2E-LC-007 | ✅ Full |
| **C-10** | Out-of-Order Balance Updates | UT-BAL-009, UT-SYN-003, UT-REC-005 | IT-SYN-005 | E2E-YB-003 | ✅ Full |
| **C-11** | Orphaned Outbox Events on Crash | UT-OBX-001–UT-OBX-006 | IT-SYN-002, IT-SYN-003 | E2E-FR-001, E2E-FR-004 | ✅ Full |
| **C-12** | Cancellation After Approval (HCM Credit) | UT-REQ-014, UT-REQ-015 | IT-CAN-001–IT-CAN-004, IT-SYN-011, IT-SYN-012 | E2E-LC-004, E2E-LC-005 | ✅ Full |
| **C-13** | Horizontal Privilege Escalation | UT-SEC-004 | IT-SEC-001, IT-SEC-002, IT-SUB-009 | — | ✅ Full |
| **C-14** | Employee Approving Own Request | UT-REQ-010, UT-SEC-013 | IT-APR-003, IT-APR-004, IT-SEC-003, IT-SEC-004 | — | ✅ Full |
| **C-15** | Spoofing Another Employee's Submission | UT-REQ-017, UT-SEC-007 | IT-SEC-005, IT-SEC-006, IT-SUB-005, IT-BAL-004 | — | ✅ Full |
| **C-16** | Bypassing HCM Freshness via Parameter | UT-BAL-005–UT-BAL-007, UT-REQ-002 | IT-SEC-007, IT-SEC-008, IT-SUB-003, IT-APR-007 | E2E-LC-002 | ✅ Full |
| **C-17** | Accessing Another Tenant's Data | UT-SEC-010 | IT-SEC-009, IT-SEC-010 | — | ✅ Full |
| **C-18** | Replay Attack on HCM Batch Webhook | UT-SYN-005–UT-SYN-007 | IT-SYN-006, IT-SYN-007, IT-SEC-011, IT-SEC-012 | E2E-BS-001, E2E-BS-002 | ✅ Full |
| **C-19** | Mass Assignment / Parameter Pollution | UT-DTO-001–UT-DTO-006 | IT-SUB-005, IT-SUB-006, IT-SEC-013, IT-SEC-014 | — | ✅ Full |
| **C-20** | Rate Limiting & Pending Request Cap | UT-REQ-004–UT-REQ-006, UT-SEC-011, UT-SEC-012 | IT-SUB-004, IT-CON-005, IT-SEC-015 | — | ✅ Full |
| **C-21** | Invalid Dimension Combinations | UT-DIM-001, UT-DIM-002, UT-DIM-003, UT-OBX-008 | IT-SYN-001 | E2E-FR-003 | ✅ Full |
| **C-22** | Timezone Handling for Date Boundaries | UT-REQ-020, UT-REQ-021, UT-UTL-001, UT-UTL-002 | — | E2E-YB-004 | ✅ Full |
| **C-23** | Fractional Day Requests and Rounding | UT-BAL-011, UT-REQ-019, UT-DTO-003, UT-DTO-006, UT-UTL-005 | IT-SUB-008, IT-SEC-014 | — | ✅ Full |
| **C-24** | Audit Trail Completeness | UT-BAL-010, UT-OBX-007, UT-SYN-008 | IT-AUD-001–IT-AUD-005, IT-SYN-001 | E2E-LC-005, E2E-FR-006 | ✅ Full |

---

## 7. Mock HCM Control Reference

The mock HCM server (`test/mock-hcm/`) exposes production-simulating endpoints plus test-control endpoints.

### Production API Endpoints (used by TOMS)

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/balances/:employeeId/:locationId` | Returns configurable per-employee balance |
| `POST` | `/time-off/request` | Validates & deducts atomically; returns `hcm_request_id` |
| `POST` | `/balances/batch` | Bulk upsert with configurable partial failure injection |
| `GET` | `/health` | Returns 200 OK or configurable error |

### Test Control Endpoints

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/__mock__/set-balance` | `{ employeeId, locationId, leaveType, days }` | Set exact balance for employee |
| `POST` | `/__mock__/simulate-error` | `{ nextNCalls: N, statusCode: 503 }` | Force next N calls to any production endpoint to return `statusCode` |
| `POST` | `/__mock__/clear-errors` | `{}` | Clear all active error simulation |
| `GET` | `/__mock__/get-state` | — | Return full mock HCM in-memory state for assertions |
| `POST` | `/__mock__/reset` | `{}` | Clear all state (called in `beforeEach`) |
| `GET` | `/__mock__/call-log` | — | Return ordered log of all production API calls received |

### Mock HCM Configuration Flags

| Flag | Default | Description |
|---|---|---|
| `VALIDATE_IDEMPOTENCY_KEY` | `true` | Tracks seen idempotency keys; returns same result for duplicates |
| `DEDUCT_FROM_BALANCE` | `true` | Whether mock HCM actually tracks its own balance state |
| `REJECT_INSUFFICIENT` | `false` | Whether HCM actively rejects over-deduction (disabled to test C-06 path) |

---

## 8. Test Data Fixtures

### Users

```typescript
// test/fixtures/users.ts

export const TENANT_A_ID = 'tenant-a-uuid-1111';
export const TENANT_B_ID = 'tenant-b-uuid-2222';

export const EMPLOYEE_ALICE = {
  id: 'user-alice-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-001',
  email: 'alice@example.com',
  role: 'EMPLOYEE',
  manager_id: 'user-bob-uuid',
  timezone: 'Asia/Karachi',
  location_id: 'LOC-PK',
};

export const MANAGER_BOB = {
  id: 'user-bob-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-002',
  email: 'bob@example.com',
  role: 'MANAGER',
  manager_id: null,
  timezone: 'America/New_York',
  location_id: 'LOC-US',
};

export const EMPLOYEE_CHARLIE = {
  id: 'user-charlie-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-003',
  email: 'charlie@example.com',
  role: 'EMPLOYEE',
  manager_id: 'user-bob-uuid',
  timezone: 'Europe/London',
  location_id: 'LOC-GB',
};

export const ADMIN_EVE = {
  id: 'user-eve-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-004',
  email: 'eve@example.com',
  role: 'ADMIN',
  manager_id: null,
  timezone: 'UTC',
  location_id: 'LOC-US',
};

export const EMPLOYEE_DAVE = {
  id: 'user-dave-uuid',
  tenant_id: TENANT_B_ID,   // Different tenant!
  employee_id: 'EMP-B-001',
  email: 'dave@other.com',
  role: 'EMPLOYEE',
  manager_id: null,
  timezone: 'UTC',
  location_id: 'LOC-US',
};
```

### JWT Factories

```typescript
// test/fixtures/jwt.ts

import * as jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

export function signToken(user: { id: string; tenantId: string; role: string }): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '1h', subject: user.id });
}

export const ALICE_TOKEN   = signToken({ id: EMPLOYEE_ALICE.id, tenantId: TENANT_A_ID, role: 'EMPLOYEE' });
export const BOB_TOKEN     = signToken({ id: MANAGER_BOB.id, tenantId: TENANT_A_ID, role: 'MANAGER' });
export const EVE_TOKEN     = signToken({ id: ADMIN_EVE.id, tenantId: TENANT_A_ID, role: 'ADMIN' });
export const CHARLIE_TOKEN = signToken({ id: EMPLOYEE_CHARLIE.id, tenantId: TENANT_A_ID, role: 'EMPLOYEE' });
export const DAVE_TOKEN    = signToken({ id: EMPLOYEE_DAVE.id, tenantId: TENANT_B_ID, role: 'EMPLOYEE' });
```

### Leave Balances

```typescript
// test/fixtures/balances.ts

export const ALICE_VACATION_BALANCE = {
  id: 'lb-alice-vacation-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-001',
  location_id: 'LOC-PK',
  leave_type: 'VACATION',
  balance_days: 10.00,
  hcm_last_synced: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago (fresh)
};

export const CHARLIE_VACATION_BALANCE = {
  id: 'lb-charlie-vacation-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-003',
  location_id: 'LOC-GB',
  leave_type: 'VACATION',
  balance_days: 3.00,
  hcm_last_synced: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
};

export const STALE_BALANCE = (base: typeof ALICE_VACATION_BALANCE) => ({
  ...base,
  hcm_last_synced: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago (stale)
});
```

### Standard Request Bodies

```typescript
// test/fixtures/requests.ts

export const VALID_SUBMISSION_BODY = {
  locationId: 'LOC-PK',
  leaveType: 'VACATION',
  startDate: '2026-06-01',
  endDate: '2026-06-05',
  timezone: 'Asia/Karachi',
};

export const MALICIOUS_SUBMISSION_BODY = {
  ...VALID_SUBMISSION_BODY,
  status: 'APPROVED',
  decidedBy: 'hacker_manager_uuid',
  days_requested: 0.001,
};

export const APPROVE_BODY = (managerId: string) => ({ managerId });
export const REJECT_BODY = (reason: string) => ({ reason });
```

---

## Appendix A — Test Execution Commands

```bash
# Unit tests
npx jest --config jest.config.ts --coverage

# Integration tests (requires no Docker; uses in-memory SQLite)
npx jest --config jest.config.integration.ts

# E2E tests (requires Docker Compose)
docker compose -f compose.yml -f compose.test.yml up -d
npx jest --config jest.config.e2e.ts
docker compose -f compose.yml -f compose.test.yml down

# All tests with combined coverage report
npx jest --projects jest.config.ts jest.config.integration.ts --coverage

# Watch mode (unit only)
npx jest --config jest.config.ts --watch

# Run tests for a specific challenge (by search tag)
npx jest --config jest.config.ts -t "C-04"
```

## Appendix B — Coverage Gates (CI Enforcement)

The following gates are enforced in CI and will fail the pipeline if not met:

```json
// jest.config.ts (shared coverage block)
{
  "coverageThreshold": {
    "global": {
      "statements": 90,
      "branches": 85,
      "functions": 90,
      "lines": 90
    },
    "./src/auth/guards/": {
      "branches": 100,
      "statements": 100
    },
    "./src/time-off-request/time-off-request.service.ts": {
      "branches": 95,
      "statements": 95
    }
  }
}
```

## Appendix C — Test Naming Conventions

All test files follow the naming convention:

| Layer | File suffix | Example |
|---|---|---|
| Unit | `*.unit.spec.ts` | `balance.service.unit.spec.ts` |
| Integration | `*.integration.spec.ts` | `approval.integration.spec.ts` |
| E2E | `*.e2e.spec.ts` | `full-lifecycle.e2e.spec.ts` |

Each `it()` block title format: `[TEST-ID] — description that maps to TRD challenge`

Example:
```typescript
it('IT-CON-001 — Two concurrent approval attempts are serialized; second fails with 409', async () => { ... });
```

---

*End of TOMS Test Suite v1.0*
