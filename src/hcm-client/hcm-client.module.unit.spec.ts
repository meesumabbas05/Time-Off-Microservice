import { HcmClientService } from './hcm-client.service';
import axios from 'axios';

jest.mock('axios', () => {
  const mInstance = jest.fn((config) => Promise.resolve({ status: 200, data: {} }));
  (mInstance as any).interceptors = {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  };
  (mInstance as any).request = mInstance;
  
  return {
    create: jest.fn(() => mInstance),
  };
});

describe('HcmClientModule behavior', () => {
  const tenants = {
    tenantA: { hcm_base_url: 'https://a.example.com', hcm_api_key: 'key-a' },
    tenantB: { hcm_base_url: 'https://b.example.com', hcm_api_key: 'key-b' },
  };

  let client: HcmClientService;
  let mockRepo: any;
  let mockedInstance: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedInstance = (axios.create as jest.Mock)();
    
    mockRepo = {
      findOne: jest.fn().mockImplementation(({ where: { id } }) => Promise.resolve(tenants[id])),
    };
    client = new HcmClientService(mockRepo);
  });

  it('UT-HCM-001 — circuit breaker opens after failures', async () => {
    mockedInstance.mockRejectedValue({ response: { status: 503 } });

    for (let i = 0; i < 15; i += 1) {
      try { await client.deduct('tenantA', { requestId: 'r' }, 'k'); } catch(e) {}
    }

    expect(client.getState('tenantA')).toBe('OPEN');
    await expect(client.deduct('tenantA', { requestId: 'r' }, 'k')).rejects.toThrow('CircuitBreakerOpenError');
  });

  it('UT-HCM-006 — injects per-tenant credentials from tenant config', async () => {
    mockedInstance.mockResolvedValue({ status: 200, data: {} });

    await client.deduct('tenantA', { requestId: 'r1' }, 'k1');

    expect(mockedInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://a.example.com',
        headers: expect.objectContaining({ Authorization: 'key-a' }),
      }),
    );
  });

  it('UT-HCM-007 — all outbound HCM calls include Idempotency-Key header', async () => {
    mockedInstance.mockResolvedValue({ status: 200, data: {} });

    await client.deduct('tenantA', { requestId: 'r' }, 'KEY-ABC');

    expect(mockedInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'KEY-ABC' }),
      }),
    );
  });
});
