import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import CircuitBreaker from 'opossum';
import { Repository } from 'typeorm';
import { Tenant } from '../entities/tenant.entity';

export interface TenantConfig {
  hcm_base_url: string;
  hcm_api_key: string;
}

export class HcmClientService {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly axiosInstance: AxiosInstance;
  private readonly configCache = new Map<string, TenantConfig>();

  constructor(
    private readonly tenantRepo?: Repository<Tenant>
  ) {
    this.axiosInstance = axios.create();
    
    axiosRetry(this.axiosInstance, {
      retries: 3,
      retryDelay: (retryCount) => 500 * Math.pow(2, retryCount - 1),
      retryCondition: (error) => {
        const status = error.response?.status;
        return !status || status >= 500;
      },
    });
  }

  private async getConfig(tenantId: string): Promise<TenantConfig | null> {
    if (this.configCache.has(tenantId)) return this.configCache.get(tenantId)!;
    if (!this.tenantRepo) return null;

    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (tenant) {
      const config = { hcm_base_url: tenant.hcm_base_url, hcm_api_key: tenant.hcm_api_key };
      this.configCache.set(tenantId, config);
      return config;
    }
    return null;
  }

  private getBreaker(tenantId: string): CircuitBreaker {
    let breaker = this.breakers.get(tenantId);
    if (!breaker) {
      const options = {
        timeout: 5000,
        resetTimeout: 30000,
        errorThresholdPercentage: 50,
      };
      
      const callHcm = async (config: any) => {
        const response = await this.axiosInstance(config);
        return response;
      };

      breaker = new CircuitBreaker(callHcm, options);
      this.breakers.set(tenantId, breaker);
    }
    return breaker;
  }

  private ensureProtocol(url: string): string {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return `http://${url}`;
    }
    return url;
  }

  async deduct(tenantId: string, payload: { requestId: string, employeeId: string, locationId: string, leaveType: string, daysRequested: number }, idempotencyKey: string): Promise<any> {
    const config = await this.getConfig(tenantId);
    if (!config) throw new Error(`Config for tenant ${tenantId} not found`);

    const breaker = this.getBreaker(tenantId);
    try {
      return await breaker.fire({
        method: 'post',
        url: '/time-off/deduct',
        baseURL: this.ensureProtocol(config.hcm_base_url),
        data: payload,
        headers: {
          Authorization: config.hcm_api_key,
          'Idempotency-Key': idempotencyKey,
        },
      });
    } catch (error: any) {
      if (error.code === 'EOPENBREAKER') throw new Error('CircuitBreakerOpenError');
      throw error;
    }
  }

  async credit(tenantId: string, payload: { requestId: string, employeeId: string, locationId: string, leaveType: string, daysRequested: number, hcmRequestId: string | null }, idempotencyKey: string): Promise<any> {
    const config = await this.getConfig(tenantId);
    if (!config) throw new Error(`Config for tenant ${tenantId} not found`);

    const breaker = this.getBreaker(tenantId);
    try {
      return await breaker.fire({
        method: 'post',
        url: '/time-off/credit',
        baseURL: this.ensureProtocol(config.hcm_base_url),
        data: payload,
        headers: {
          Authorization: config.hcm_api_key,
          'Idempotency-Key': idempotencyKey,
        },
      });
    } catch (error: any) {
      if (error.code === 'EOPENBREAKER') throw new Error('CircuitBreakerOpenError');
      throw error;
    }
  }

  async getBalance(tenantId: string, employeeId: string, locationId: string, leaveType: string): Promise<{ days: number, asOf: Date }> {
    const config = await this.getConfig(tenantId);
    if (!config) throw new Error(`Config for tenant ${tenantId} not found`);

    const breaker = this.getBreaker(tenantId);
    try {
      const response = await breaker.fire({
        method: 'get',
        url: `/time-off/balance/${employeeId}`,
        baseURL: this.ensureProtocol(config.hcm_base_url),
        params: { locationId, leaveType },
        headers: {
          Authorization: config.hcm_api_key,
        },
      });
      return { 
        days: Number((response as any).data.days), 
        asOf: new Date((response as any).data.asOf) 
      };
    } catch (error: any) {
      if (error.code === 'EOPENBREAKER') throw new Error('CircuitBreakerOpenError');
      throw error;
    }
  }

  async fetchBalances(tenantId: string): Promise<any[]> {
    const config = await this.getConfig(tenantId);
    if (!config) throw new Error(`Config for tenant ${tenantId} not found`);

    const breaker = this.getBreaker(tenantId);
    try {
      const response = await breaker.fire({
        method: 'get',
        url: '/time-off/balances',
        baseURL: this.ensureProtocol(config.hcm_base_url),
        headers: {
          Authorization: config.hcm_api_key,
        },
      });
      return (response as any).data;
    } catch (error: any) {
      if (error.code === 'EOPENBREAKER') throw new Error('CircuitBreakerOpenError');
      throw error;
    }
  }

  getState(tenantId: string): string {
    const breaker = this.breakers.get(tenantId);
    if (!breaker) return 'CLOSED';
    if (breaker.opened) return 'OPEN';
    if (breaker.halfOpen) return 'HALF_OPEN';
    return 'CLOSED';
  }

  resetBreakers(): void {
    for (const breaker of this.breakers.values()) {
      breaker.close();
    }
  }
}
