import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeError } from '../src/runtime/errors/runtime-error.js';
import { RuntimeExceptionFilter } from '../src/server/http/runtime-exception.filter.js';

describe('RuntimeExceptionFilter', () => {
  it.each(['invalid_session_state', 'invalid_plan_state'] as const)(
    'maps %s to an actionable 422 response',
    code => {
      const response = captureResponse();

      new RuntimeExceptionFilter().catch(new RuntimeError(code, 'Invalid state.', {
        details: { entityId: 'entity_1' },
      }), response.host);

      expect(response.status).toHaveBeenCalledWith(422);
      expect(response.send).toHaveBeenCalledWith({
        statusCode: 422,
        error: code,
        message: 'Invalid state.',
        details: { entityId: 'entity_1' },
      });
    }
  );

  it('does not expose internal exception messages or details', () => {
    const response = captureResponse();

    new RuntimeExceptionFilter().catch(
      new RuntimeError('storage_error', 'password=secret', {
        details: { connectionString: 'postgres://secret' },
      }),
      response.host
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.send).toHaveBeenCalledWith({
      statusCode: 500,
      error: 'storage_error',
      message: 'Internal server error.',
    });
  });
});

function captureResponse() {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  return {
    send,
    status,
    host: {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost,
  };
}
