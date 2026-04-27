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

## 🐳 Docker Setup (Recommended)

The easiest way to run the entire system (TOMS + Mock HCM) is using Docker. This ensures all dependencies and networking are pre-configured.

### 1. Build and Start
```bash
docker-compose up --build
```
This command will:
- Build the TOMS microservice image.
- Start the TOMS server at `http://localhost:3000`.
- Start the Mock HCM service at `http://localhost:4000`.
- Initialize a persistent SQLite database in a Docker volume.

### 2. Configuration
The `docker-compose.yml` comes with sensible defaults. If you need to override them, you can create a `.env` file (see `.env.example`).

---

## ⚙️ Local Setup (Manual)

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
JWT_SECRET=your-secure-secret
MOCK_HCM_PORT=4000
HCM_BASE_URL=http://localhost:4000

# Database Configuration (SQLite)
DB_TYPE=sqlite
DATABASE_PATH=data/toms.db

# Database Configuration (Postgres - optional)
# DB_TYPE=postgres
# DB_HOST=localhost
# DB_PORT=5432
# DB_USERNAME=postgres
# DB_PASSWORD=postgres
# DB_NAME=toms
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

## 🚀 Manual Testing (Postman/cURL)

After starting the system with Docker and seeding the database (`npm run seed`), you can use the following steps to try out the features.

### 1. Authenticate
Get a JWT token by "logging in" as one of the seeded users (e.g., Alice).
- **Endpoint**: `POST /auth/login`
- **Body**:
  ```json
  { "email": "alice@example.com" }
  ```
- **Action**: Copy the `access_token` from the response and use it as a **Bearer Token** in the following requests.

### 2. Check Balance
Check how many days of vacation Alice has.
- **Endpoint**: `GET /balance/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa?tenantId=11111111-1111-1111-1111-111111111111&locationId=LOC1&leaveType=VACATION`
- **Headers**: `Authorization: Bearer <token>`

### 3. Submit a Time-Off Request
Alice submits a request for 2 days.
- **Endpoint**: `POST /requests`
- **Headers**: `Authorization: Bearer <token>`
- **Body**:
  ```json
  {
    "locationId": "LOC1",
    "leaveType": "VACATION",
    "startDate": "2024-06-01",
    "endDate": "2024-06-02",
    "timezone": "UTC"
  }
  ```

### 4. Approve the Request (As Manager)
1. Login as Bob (`bob@example.com`) to get his token.
2. Approve the request submitted by Alice.
- **Endpoint**: `PATCH /requests/<request_id>/approve`
- **Headers**: `Authorization: Bearer <bob_token>`
- **Body**:
  ```json
  { "managerId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }
  ```

### 5. Simulate HCM Webhook Sync
Manually trigger a balance update from the HCM.
- **Endpoint**: `POST /sync/webhook/11111111-1111-1111-1111-111111111111`
- **Headers**: `x-hcm-signature: <any_string_for_test>`
- **Body**:
  ```json
  {
    "tenantId": "11111111-1111-1111-1111-111111111111",
    "nonce": "test-nonce",
    "records": [
      {
        "employeeId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "locationId": "LOC1",
        "leaveType": "VACATION",
        "days": 15.0,
        "asOf": "2024-01-01T00:00:00Z"
      }
    ]
  }
  ```

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
