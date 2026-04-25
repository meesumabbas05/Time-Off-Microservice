# TOMS - Task List

## Phase 1: Core Foundation & TDD
- [x] Initial setup (NestJS + TypeORM)
- [x] Entity definitions (User, Tenant, TimeOffRequest, LeaveBalance, OutboxEvent)
- [x] Core Service Logic (Submission, Approval, Rejection)
- [x] TDD Unit Tests (101 tests)

## Phase 2: Security & Integrity
- [x] Tenant isolation (Guards & Interceptors)
- [x] Concurrency protection (`async-mutex`)
- [x] Outbox worker for HCM sync

## Phase 3: Integration Testing (82/80 Scenarios)
- [x] IT-BAL: Balance Lifecycle (7 tests)
- [x] IT-SUB: Submission Flow (10 tests)
- [x] IT-APR: Approval Flow (10 tests)
- [x] IT-CON: Concurrency (5 tests)
- [x] IT-SYN: Sync & Outbox (12 tests)
- [x] IT-SEC: Security Boundaries (16 tests)
- [x] IT-CAN: Cancellation Flow (5 tests)
- [x] IT-AUD: Admin & Audit (7 tests)
- [x] IT-REA: Read Endpoints (10 tests)
- [x] **BUGFIX**: Fixed `fetchBalances` mock mismatch in integration tests
- [x] **STABILIZATION**: Fixed duplicate `triggerManualSync` in service layer

## Phase 4: E2E & Simulator (UPCOMING)
- [/] Develop HCM Mock Simulator (Express)
- [ ] Docker Compose setup (Redis + Postgres)
- [ ] Full browser/E2E flow traversal
- [ ] Year-boundary rollover testing

## Phase 5: Finalization
- [ ] Documentation (OpenAPI/Swagger)
- [ ] Performance benchmarking
- [ ] Production Deployment Strategy
