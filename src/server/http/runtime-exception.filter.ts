import {
  ArgumentsHost,
  Catch,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import { RuntimeError } from '../../runtime/runtime-errors.js';
import { AgentStoreError } from '../../storage/agent-store.js';

interface HttpReply {
  status(code: number): { send(body: unknown): unknown };
}

@Catch()
export class RuntimeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<HttpReply>();
    const status = httpStatus(exception);
    const error = exception instanceof RuntimeError || exception instanceof AgentStoreError
      ? exception.code
      : status === HttpStatus.BAD_REQUEST ? 'bad_request' : 'internal_error';
    const message = exception instanceof Error ? exception.message : 'Internal server error.';
    void reply.status(status).send({ statusCode: status, error, message });
  }
}

function httpStatus(exception: unknown): number {
  if (exception instanceof TypeError || exception instanceof RangeError) return HttpStatus.BAD_REQUEST;
  if (exception instanceof AgentStoreError) {
    if (exception.code.endsWith('NOT_FOUND')) return HttpStatus.NOT_FOUND;
    if (exception.code.includes('CONFLICT') || exception.code.includes('ALREADY')) {
      return HttpStatus.CONFLICT;
    }
    return HttpStatus.UNPROCESSABLE_ENTITY;
  }
  if (exception instanceof RuntimeError) {
    if (exception.code === 'concurrency_conflict' || exception.code === 'idempotency_conflict') {
      return HttpStatus.CONFLICT;
    }
    if (exception.code === 'invalid_job_state') return HttpStatus.UNPROCESSABLE_ENTITY;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
