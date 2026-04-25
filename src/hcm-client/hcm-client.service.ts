export interface TenantConfig {
  hcm_base_url: string;
  hcm_api_key: string;
}

export interface HttpLike {
  request(config: {
    baseURL: string;
    headers: Record<string, string>;
    data?: Record<string, any>;
  }): Promise<{ status: number; data?: any }>;
}

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class HcmClientService {
  private readonly failures = new Map<string, number>();
  private readonly states = new Map<string, BreakerState>();
  private readonly openedAt = new Map<string, number>();

  constructor(
    private readonly http: HttpLike,
    private readonly tenantConfig: Record<string, TenantConfig>,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  getState(tenantId: string): BreakerState {
    return this.states.get(tenantId) ?? 'CLOSED';
  }

  async deduct(tenantId: string, payload: Record<string, any>, idempotencyKey: string): Promise<{ status: number }> {
    const state = this.getState(tenantId);

    if (state === 'OPEN') {
      const openedAt = this.openedAt.get(tenantId) ?? 0;
      if (Date.now() - openedAt >= 30000) {
        this.states.set(tenantId, 'HALF_OPEN');
      } else {
        throw new Error('CircuitBreakerOpenError');
      }
    }

    const config = this.tenantConfig[tenantId];
    const headers = {
      Authorization: config.hcm_api_key,
      'X-Idempotency-Key': idempotencyKey,
    };

    let attempt = 0;
    while (attempt < 4) {
      try {
        const response = await this.http.request({
          baseURL: config.hcm_base_url,
          headers,
          data: payload,
        });

        this.failures.set(tenantId, 0);
        this.states.set(tenantId, 'CLOSED');
        return { status: response.status };
      } catch (error: any) {
        const status = error?.statusCode ?? error?.response?.status;
        const is5xx = !status || status >= 500;
        const is4xx = status && status >= 400 && status < 500;

        if (is4xx) {
          throw error;
        }

        attempt += 1;
        if (attempt >= 4) {
          const failures = (this.failures.get(tenantId) ?? 0) + 1;
          this.failures.set(tenantId, failures);
          if (failures >= 5) {
            this.states.set(tenantId, 'OPEN');
            this.openedAt.set(tenantId, Date.now());
          }
          throw error;
        }

        const delayMs = 500 * Math.pow(2, attempt - 1);
        await this.sleep(delayMs);

        if (!is5xx) {
          throw error;
        }
      }
    }

    throw new Error('Unexpected retry exit');
  }
}
