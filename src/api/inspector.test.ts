import { describe, expect, it } from 'vitest';

import { normalizeUrl } from './inspector';

describe('normalizeUrl', () => {
  it('defaults the scheme and strips endpoint paths', () => {
    expect(normalizeUrl('localhost:8000/metrics').base).toBe('http://localhost:8000');
    expect(normalizeUrl('http://localhost:8800/vllm/v1/models').base).toBe('http://localhost:8800/vllm');
  });
});
