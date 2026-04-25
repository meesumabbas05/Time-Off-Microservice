import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import { TimeOffRequest } from '../../entities/time-off-request.entity';

@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(TimeOffRequest)
    private requestRepo: Repository<TimeOffRequest>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const { employeeId, id } = { ...request.query, ...request.params };

    if (!user || !user.userId) {
      throw new ForbiddenException('Missing user or userId in token');
    }
    
    let targetEmployeeId = employeeId;
    if (!targetEmployeeId && id) {
      // If 'id' is present, check if it's a request ID
      const timeOffRequest = await this.requestRepo.findOne({ where: { id } });
      if (timeOffRequest) {
        targetEmployeeId = timeOffRequest.employee_id;
        // Strict tenant check for the request itself
        if (timeOffRequest.tenant_id !== user.tenantId) {
          throw new ForbiddenException('Access denied - Cross-tenant resource');
        }
      } else {
        // If it's a UUID and not found as a request, don't assume it's an employeeId
        // Just let it pass, the controller will 404
        if (id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          return true;
        }
        targetEmployeeId = id;
      }
    }

    if (!targetEmployeeId) {
      return true;
    }

    // Look up the requesting user by their database ID (from JWT)
    const requestingUser = await this.userRepo.findOne({ where: { id: user.userId } });
    if (!requestingUser) {
      throw new ForbiddenException('User record not found');
    }

    // 1. Same user check (Business ID match)
    if (requestingUser.employee_id === targetEmployeeId) {
      return true;
    }

    if (requestingUser.role === 'MANAGER' || requestingUser.role === 'ADMIN') {
      const targetUser = await this.userRepo.findOne({ 
        where: { employee_id: targetEmployeeId, tenant_id: requestingUser.tenant_id } 
      });
      if (!targetUser) {
        throw new ForbiddenException('Employee not found');
      }

      if (targetUser.manager_id === requestingUser.id || requestingUser.role === 'ADMIN') {
         return true;
      }
      
      throw new ForbiddenException('You do not manage this employee');
    }

    throw new ForbiddenException('EMPLOYEE_ID_MISMATCH');
  }
}
