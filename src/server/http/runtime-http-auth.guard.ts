import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

export const RUNTIME_HTTP_AUTH_TOKEN = Symbol('RUNTIME_HTTP_AUTH_TOKEN');

export function requireRuntimeHttpAuthToken(value: string): string {
  const token = value.trim();
  if (token.length < 32) {
    throw new Error(
      'AGENT_SERVER_AUTH_TOKEN must be configured with at least 32 characters before starting HTTP.'
    );
  }
  return token;
}

@Injectable()
export class RuntimeHttpAuthGuard implements CanActivate {
  constructor(@Inject(RUNTIME_HTTP_AUTH_TOKEN) private readonly token: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string | string[] };
    }>();
    const authorization = request.headers.authorization;
    const value = Array.isArray(authorization) ? undefined : authorization;
    const candidate = value?.startsWith('Bearer ') ? value.slice(7) : undefined;
    if (!candidate || !constantTimeEqual(candidate, this.token)) {
      throw new UnauthorizedException('A valid Runtime bearer token is required.');
    }
    return true;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
