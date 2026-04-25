# Time-Off Microservice (TOMS) - Project Context

## Project Overview
TOMS is a high-integrity microservice for managing employee time-off requests. It solves critical challenges around data integrity (race conditions), security (tenant isolation), and resilience (asynchronous HCM synchronization).

## Core Architecture
- **Framework**: NestJS (TypeScript)
- **Database**: TypeORM (SQLite for testing, Postgres planned for production)
- **Patterns**: 
  - **Outbox Pattern**: Reliable HCM synchronization using an events log and recovery worker.
  - **Serialized Approvals**: `async-mutex` ensures that a user's balance is never over-committed during concurrent approval attempts.
  - **Tenant Isolation**: Strict isolation enforced via `TenantScopeInterceptor` and `RolesGuard`.

## Current State
- **Phase 3 (Integration Testing) is COMPLETE**.
- All **101 unit tests** are passing.
- All **82 integration tests** are passing.
- Code is pushed to `main` with all fixes for HCM synchronization mocks and service consolidation.

## Technical Debt / Resolved Issues
- **Service Consolidation**: Removed duplicate implementations of sync methods in `HcmSyncService`.
- **Mock Consistency**: Synchronized `HCM_CLIENT` mocks across unit and integration tests to support `fetchBalances` batching.
- **Query Validation**: Implemented `ListRequestsDto` for robust search filtering.

## Environment Requirements
- **Local Dev**: Node.js, `npm install`
- **Testing**: `npm run test:all` (runs unit then integration tests)
- **Database**: Automatically handled via TypeORM migrations/sync during tests.
