# Time-Off Microservice (TOMS)

A resilient, multi-tenant microservice for managing employee time-off requests. TOMS acts as a manager-gated write-through cache for a central Human Capital Management (HCM) system, ensuring high availability even during HCM outages.

## 🚀 Key Features

- **Resilient Approval Flow**: Uses the **Outbox Pattern** to ensure that once a manager approves a request, it is eventually synchronized with the HCM system, even if the HCM is temporarily down.
- **Multi-Tenant Architecture**: Full data isolation between tenants, with per-tenant HCM configurations and webhook secrets.
- **High Performance**: Decisions are made against a local SQLite cache of balances, eliminating the latency of real-time HCM lookups.
- **HCM Synchronization**: Supports batch sync webhooks for bulk updates and spot-refreshes for stale data (Configurable TTL).
- **Self-Healing**: Automated reconciliation job detects and corrects any drift between the local cache and HCM truth.
- **Security First**: Role-based access control (RBAC), ownership enforcement, and HMAC signature verification for all incoming webhooks.

---

## 🛠 Prerequisites

- **Node.js**: v20 or higher
- **npm**: v10 or higher
- **SQLite3**: Required for local data persistence

---

## ⚙️ Local Setup

### 1. Installation
```bash
git clone <repository-url>
cd toms
npm install
```

### 2. Configuration
Create a `.env` file in the root directory:
```env
PORT=3000
DATABASE_PATH=data/toms.sqlite
JWT_SECRET=your-secure-secret
MOCK_HCM_PORT=4000
HCM_BASE_URL=http://localhost:4000
```

### 3. Initialize Database
TOMS uses TypeORM with automatic synchronization in development. You can seed initial test data (Tenants, Users, Balances) using the provided script:
```bash
npm run seed
```

---

## 🏃 Running the System

To run the full system locally, you need to start both the **Mock HCM** and the **TOMS Server**.

### 1. Start Mock HCM (Simulated External System)
The Mock HCM simulates the external source of truth for balances and time-off records.
```bash
node test/mock-hcm/mock-hcm.js
# Listening at http://localhost:4000
```

### 2. Start TOMS Server
```bash
# Development mode (watch)
npm run start:dev

# Production mode
npm run build
npm run start:prod
```

---

## 🧪 Testing

TOMS features a comprehensive test suite (Unit, Integration, and E2E) with 100% coverage of critical security and concurrency challenges.

```bash
# Run all tests sequentially (Unit -> Integration -> E2E)
npm run test:all

# Run individual layers
npm run test      # Unit tests
npm run test:int  # Integration tests
npm run test:e2e  # End-to-End tests
```

---

## 📖 API Quick Reference

### Time-Off Requests
- `POST /requests`: Submit a new request (Employee).
- `PATCH /requests/:id/approve`: Approve a request (Manager/Admin).
- `PATCH /requests/:id/reject`: Reject a request (Manager/Admin).
- `PATCH /requests/:id/cancel`: Cancel a pending or approved request (Owner/Admin).
- `GET /requests`: List requests with filters (Employee/Manager/Admin).

### Balance Management
- `GET /balance/:employeeId`: Get current balance for an employee.
- `POST /sync/webhook/:tenantId`: Inbound batch sync from HCM (Requires HMAC Signature).
- `POST /sync/trigger/:tenantId`: Manually trigger a spot-refresh for the current tenant.

---

## 🏗 Architecture Details

### The Outbox Pattern
When a request is approved, TOMS:
1. Updates the local request status to `APPROVED`.
2. Persists an `OutboxEvent` in the same database transaction.
3. A background worker picks up the event and attempts to sync with the HCM.
4. If the HCM is down, the worker retries with exponential backoff and circuit breaking.

### Circuit Breakers
All outgoing calls to the HCM are protected by **Opossum circuit breakers**. If the HCM returns consecutive errors, the breaker opens to prevent cascading failures and allow the HCM to recover.

### Security
- **JWT Authentication**: All endpoints are protected via `JwtAuthGuard`.
- **Ownership Enforcement**: `OwnershipGuard` ensures employees can only view/cancel their own requests.
- **Tenant Isolation**: `TenantScopeInterceptor` ensures all DB queries are filtered by the requesting user's `tenant_id`.

---

## 📄 License
MIT
