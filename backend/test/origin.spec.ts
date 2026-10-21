import { env, createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { PUBLIC_APP_ORIGIN } from '../src/app-origin';

describe('public URL migration', () => {
  it('allows the new public URL and preserves the previous public URL with credentials', async () => {
    for (const origin of [PUBLIC_APP_ORIGIN, 'https://test-project-nu-one-12.vercel.app']) {
      for (const path of ['/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/profile', '/api/groups/mine', '/api/groups/rename', '/api/groups/icon', '/api/groups/wishes/list', '/api/groups/wishes/react', '/api/shared/events/list', '/api/push/config']) {
        const response = await worker.fetch(new Request(`https://example.com${path}`, {
          method:'OPTIONS', headers:{ Origin:origin, 'Access-Control-Request-Method':'POST' },
        }), { ...env, LOCAL_DEV:undefined }, createExecutionContext());
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe(origin);
        expect(response.headers.get('access-control-allow-credentials')).toBe('true');
      }
      const me = await worker.fetch(new Request('https://example.com/api/auth/me', { headers:{ Origin:origin } }), env, createExecutionContext());
      expect(me.status).toBe(401);
      expect(me.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });

  it('rejects unapproved preview origins without wildcard credentials', async () => {
    const response = await worker.fetch(new Request('https://example.com/api/auth/me', { headers:{ Origin:'https://daysync-preview.example' } }), env, createExecutionContext());
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('does not include the out-of-scope password recovery API', async () => {
    for (const path of ['/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/change-password']) {
      const response = await worker.fetch(new Request(`https://example.com${path}`, {
        method:'POST',
        headers:{ Origin:PUBLIC_APP_ORIGIN, 'Content-Type':'application/json' },
        body:JSON.stringify({ email:'rc-test@example.test', password:'Not-a-real-password-123' }),
      }), env, createExecutionContext());
      expect(response.status).toBe(404);
    }
  });
});
