const express = require('express');
const app = express();
const port = process.env.MOCK_HCM_PORT || 4000;

app.use(express.json());

// In-memory "database" for mock HCM
let balances = new Map();
let requests = new Map();
let callLog = [];
let errorSimulation = { nextNCalls: 0, statusCode: 503 };

// Middleware to log calls and simulate errors
app.use((req, res, next) => {
  if (req.path.startsWith('/__mock__/')) {
    return next();
  }

  callLog.push({
    method: req.method,
    path: req.path,
    body: req.body,
    headers: req.headers,
    timestamp: new Date().toISOString()
  });

  if (errorSimulation.nextNCalls > 0) {
    errorSimulation.nextNCalls--;
    console.log(`[Mock-HCM] Simulating error ${errorSimulation.statusCode} for ${req.path}`);
    return res.status(errorSimulation.statusCode).json({ error: 'SIMULATED_ERROR' });
  }

  next();
});

// Helper to seed data
const seedBalance = (employeeId, locationId, leaveType, days) => {
  const key = `${employeeId}:${locationId}:${leaveType}`;
  balances.set(key, { days, asOf: new Date().toISOString() });
};

// GET /time-off/balance/:employeeId
app.get('/time-off/balance/:employeeId', (req, res) => {
  const { employeeId } = req.params;
  const { locationId, leaveType } = req.query;
  const key = `${employeeId}:${locationId}:${leaveType}`;

  if (!balances.has(key)) {
    seedBalance(employeeId, locationId, leaveType, 20);
  }

  const balance = balances.get(key);
  console.log(`[Mock-HCM] Returning balance for ${key}: ${balance.days}`);
  res.json(balance);
});

// POST /time-off/deduct
app.post('/time-off/deduct', (req, res) => {
  const { employeeId, locationId, leaveType, daysRequested, requestId } = req.body;
  const idempotencyKey = req.headers['idempotency-key'];
  const key = `${employeeId}:${locationId}:${leaveType}`;

  if (requests.has(idempotencyKey)) {
    return res.status(201).json(requests.get(idempotencyKey));
  }

  if (!balances.has(key)) {
    seedBalance(employeeId, locationId, leaveType, 20);
  }

  const balance = balances.get(key);
  if (balance.days < daysRequested) {
    return res.status(422).json({ error: 'INSUFFICIENT_BALANCE' });
  }

  balance.days -= daysRequested;
  balance.asOf = new Date().toISOString();
  balances.set(key, balance);

  const hcmRequestId = `HCM-REQ-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
  const responseData = { hcm_request_id: hcmRequestId, status: 'DEDUCTED' };
  requests.set(idempotencyKey, responseData);

  res.status(201).json(responseData);
});

// POST /time-off/credit
app.post('/time-off/credit', (req, res) => {
  const { employeeId, locationId, leaveType, daysRequested, hcmRequestId } = req.body;
  const idempotencyKey = req.headers['idempotency-key'];
  const key = `${employeeId}:${locationId}:${leaveType}`;

  if (requests.has(idempotencyKey)) {
    return res.status(201).json(requests.get(idempotencyKey));
  }

  if (!balances.has(key)) {
    seedBalance(employeeId, locationId, leaveType, 20);
  }

  const balance = balances.get(key);
  balance.days += daysRequested;
  balance.asOf = new Date().toISOString();
  balances.set(key, balance);

  const responseData = { status: 'CREDITED' };
  requests.set(idempotencyKey, responseData);

  res.status(201).json(responseData);
});

// GET /time-off/balances
app.get('/time-off/balances', (req, res) => {
  const allBalances = Array.from(balances.entries()).map(([key, value]) => {
    const [employeeId, locationId, leaveType] = key.split(':');
    return { employeeId, locationId, leaveType, days: value.days, asOf: value.asOf };
  });
  res.json(allBalances);
});

// --- Test Control Endpoints ---

app.post('/admin/reset', (req, res) => {
  balances.clear();
  requests.clear();
  callLog = [];
  errorSimulation = { nextNCalls: 0, statusCode: 503 };
  res.json({ status: 'RESET' });
});

app.post('/__mock__/reset', (req, res) => {
  balances.clear();
  requests.clear();
  callLog = [];
  errorSimulation = { nextNCalls: 0, statusCode: 503 };
  res.json({ status: 'RESET' });
});

app.post('/__mock__/set-balance', (req, res) => {
  const { employeeId, locationId, leaveType, days } = req.body;
  const key = `${employeeId}:${locationId}:${leaveType}`;
  console.log(`[Mock-HCM] Manually setting balance for ${key}: ${days}`);
  balances.set(key, { days, asOf: new Date().toISOString() });
  res.json({ status: 'OK' });
});

app.post('/__mock__/simulate-error', (req, res) => {
  const { nextNCalls, statusCode } = req.body;
  errorSimulation = { nextNCalls, statusCode };
  res.json({ status: 'OK', simulation: errorSimulation });
});

app.post('/__mock__/clear-errors', (req, res) => {
  errorSimulation = { nextNCalls: 0, statusCode: 503 };
  res.json({ status: 'OK' });
});

app.get('/__mock__/get-state', (req, res) => {
  res.json({
    balances: Object.fromEntries(balances),
    requests: Object.fromEntries(requests),
    callLog
  });
});

app.get('/__mock__/call-log', (req, res) => {
  res.json(callLog);
});

app.listen(port, () => {
  console.log(`Mock HCM Service listening at http://localhost:${port}`);
});
