import { HcmClientService } from './hcm-client.service';

describe('HcmClientModule behavior', () => {
  const http = {
    request: jest.fn(),
  };

  const tenants = {
    tenantA: { hcm_base_url: 'https://a.example.com', hcm_api_key: 'key-a' },
    tenantB: { hcm_base_url: 'https://b.example.com', hcm_api_key: 'key-b' },
  };

  let client: HcmClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    client = new HcmClientService(http, tenants, async () => {});
  });

  it('UT-HCM-001 — circuit breaker opens after 5 consecutive HCM failures for a tenant', async () => {
    http.request.mockRejectedValue({ statusCode: 503 });

    for (let i = 0; i < 5; i += 1) {
      await expect(client.deduct('tenantA', {}, 'k')).rejects.toBeDefined();
    }

    expect(client.getState('tenantA')).toBe('OPEN');
    await expect(client.deduct('tenantA', {}, 'k')).rejects.toThrow('CircuitBreakerOpenError');
  });

  it('UT-HCM-002 — circuit breaker does NOT open on non-5xx errors', async () => {
    http.request.mockRejectedValue({ statusCode: 422 });

    for (let i = 0; i < 5; i += 1) {
      await expect(client.deduct('tenantA', {}, 'k')).rejects.toBeDefined();
    }

    expect(client.getState('tenantA')).toBe('CLOSED');
  });

  it('UT-HCM-003 — circuit breaker half-opens after 30 seconds and allows probe request', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);

    http.request.mockRejectedValue({ statusCode: 503 });
    for (let i = 0; i < 5; i += 1) {
      await expect(client.deduct('tenantA', {}, 'k')).rejects.toBeDefined();
    }

    nowSpy.mockReturnValue(1000 + 30001);
    http.request.mockResolvedValue({ status: 200 });

    await expect(client.deduct('tenantA', {}, 'k')).resolves.toEqual({ status: 200 });
    expect(client.getState('tenantA')).toBe('CLOSED');
    nowSpy.mockRestore();
  });

  it('UT-HCM-004 — circuit breaker closes after successful probe in HALF_OPEN state', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(5000);

    http.request.mockRejectedValue({ statusCode: 503 });
    for (let i = 0; i < 5; i += 1) {
      await expect(client.deduct('tenantA', {}, 'k')).rejects.toBeDefined();
    }

    nowSpy.mockReturnValue(5000 + 30001);
    http.request.mockResolvedValue({ status: 200 });

    await client.deduct('tenantA', {}, 'k');
    expect(client.getState('tenantA')).toBe('CLOSED');
    nowSpy.mockRestore();
  });

  it('UT-HCM-005 — retries 3 times with exponential backoff on 5xx before success', async () => {
    const delays: number[] = [];
    client = new HcmClientService(http, tenants, async (ms) => {
      delays.push(ms);
    });

    http.request
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValueOnce({ status: 200 });

    await expect(client.deduct('tenantA', {}, 'k')).resolves.toEqual({ status: 200 });
    expect(http.request).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it('UT-HCM-006 — injects per-tenant credentials from tenant config', async () => {
    http.request.mockResolvedValue({ status: 200 });

    await client.deduct('tenantA', { a: 1 }, 'k1');
    await client.deduct('tenantB', { b: 2 }, 'k2');

    expect(http.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        baseURL: tenants.tenantA.hcm_base_url,
        headers: expect.objectContaining({ Authorization: tenants.tenantA.hcm_api_key }),
      }),
    );
    expect(http.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        baseURL: tenants.tenantB.hcm_base_url,
        headers: expect.objectContaining({ Authorization: tenants.tenantB.hcm_api_key }),
      }),
    );
  });

  it('UT-HCM-007 — all outbound HCM calls include X-Idempotency-Key header', async () => {
    http.request.mockResolvedValue({ status: 200 });

    await client.deduct('tenantA', {}, 'KEY-ABC');

    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Idempotency-Key': 'KEY-ABC' }),
      }),
    );
  });
});
