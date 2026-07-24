import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVER_CONFIG } from '../src/config/server-config.js';

describe('Agent HTTP CORS configuration', () => {
  it('allows the browser methods used by the Session API', () => {
    expect(DEFAULT_SERVER_CONFIG.cors.methods).toEqual([
      'GET',
      'HEAD',
      'POST',
      'DELETE',
      'OPTIONS',
    ]);
    expect(DEFAULT_SERVER_CONFIG.cors.allowedHeaders).toContain('content-type');
  });
});
