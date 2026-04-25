import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class ClsService {
  private static storage = new Map<string, any>();
  
  // Very simplified CLS implementation for this test suite
  // In a real nestjs app we would use `nestjs-cls` or AsyncLocalStorage
  run(cb: () => void) {
    return cb();
  }

  set(key: string, value: any) {
    ClsService.storage.set(key, value);
  }

  static get(key: string) {
    return ClsService.storage.get(key);
  }
}

@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  constructor(private readonly clsService: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    
    // Instead of doing an actual CLS async context for this demo/test purpose, 
    // we use the mock wrapper. In production you'd use AsyncLocalStorage.run()
    let result;
    this.clsService.run(() => {
      if (user && user.tenantId) {
        this.clsService.set('tenantId', user.tenantId);
      }
      result = next.handle();
    });
    return result as unknown as Observable<any>;
  }
}
