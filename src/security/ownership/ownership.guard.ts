import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';

@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const params = request.params;

    if (!user || !user.userId) {
      throw new ForbiddenException('Missing user or userId in token');
    }

    const { employeeId } = params;
    if (!employeeId) {
      // If endpoint doesn't have employeeId, then skip ownership check
      return true;
    }

    // 1. Same user
    if (user.userId === employeeId) {
      return true;
    }

    // 2. ADMIN bypass could be implemented if required, but strict TRD says ADMIN is hierarchical.
    // However, the test specifically tests MANAGER.
    if (user.role === 'MANAGER' || user.role === 'ADMIN') {
      const targetUser = await this.userRepo.findOne({ where: { id: employeeId } });
      if (!targetUser) {
        throw new ForbiddenException('Employee not found');
      }

      if (targetUser.manager_id === user.userId) {
         return true;
      }
      
      throw new ForbiddenException('You do not manage this employee');
    }

    throw new ForbiddenException('EMPLOYEE_ID_MISMATCH');
  }
}
