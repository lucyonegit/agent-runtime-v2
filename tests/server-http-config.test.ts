import { describe, expect, it } from 'vitest';
import { AGENT_CORS_OPTIONS } from '../src/server/http/cors-options.js';

describe('Agent HTTP CORS configuration', () => {
  it('allows the browser methods used by the Session API', () => {
    expect(AGENT_CORS_OPTIONS.methods).toEqual([
      'GET',
      'HEAD',
      'POST',
      'DELETE',
      'OPTIONS',
    ]);
    expect(AGENT_CORS_OPTIONS.allowedHeaders).toContain('content-type');
  });
});
