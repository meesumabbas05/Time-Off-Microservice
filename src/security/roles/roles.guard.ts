import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';

/**
 * Role hierarchy (higher can act as lower):
 * ADMIN > MANAGER > EMPLOYEE
 */
const ROLE_HIERARCHY = ['EMPLOYEE', 'MANAGER', 'ADMIN'];

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const requiredRoles = this.reflector.get<string[]>('roles', context.getHandler()) || [];
    if (requiredRoles.length === 0) {
      // No role restriction
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || !user.role) {
      throw new ForbiddenException('Missing user role');
    }
    const userRoleIndex = ROLE_HIERARCHY.indexOf(user.role.toUpperCase());
    if (userRoleIndex === -1) {
      throw new ForbiddenException('Invalid user role');
    }
    // Guard passes if user's role is equal or higher than any required role
    const passes = requiredRoles.some((role) => {
      const requiredIndex = ROLE_HIERARCHY.indexOf(role.toUpperCase());
      return userRoleIndex >= requiredIndex;
    });
    if (!passes) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
