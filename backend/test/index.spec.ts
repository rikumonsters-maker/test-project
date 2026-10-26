import { env, SELF, createExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { PUBLIC_APP_ORIGIN } from '../src/app-origin';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import migration1 from '../migrations/0001_shared_calendar.sql?raw';
import migration2 from '../migrations/0002_member_calendar_entries.sql?raw';
import migration3 from '../migrations/0003_auth_users.sql?raw';
import migration4 from '../migrations/0004_profile_push.sql?raw';
import migration5 from '../migrations/0005_push_delivery_queue.sql?raw';
import migration6 from '../migrations/0006_ephemeral_status.sql?raw';
import migration7 from '../migrations/0007_group_availability_wishes.sql?raw';
import migration8 from '../migrations/0008_group_images_and_tentative_events.sql?raw';
import migration9 from '../migrations/0009_group_preset_icons.sql?raw';
import migration10 from '../migrations/0010_group_icon_ids.sql?raw';
import migration12 from '../migrations/0012_personal_event_sync.sql?raw';
import migration13 from '../migrations/0013_push_reminders.sql?raw';
import migration14 from '../migrations/0014_in_app_notifications.sql?raw';
import migration14a from '../migrations/0014a_group_leave_guard.sql?raw';
import migration15 from '../migrations/0015_group_departures.sql?raw';
import migration16 from '../migrations/0016_common_availability_coverage.sql?raw';
import { applySQL } from './migration-helper';
import { drainPushQueue, encryptPushPayload, handlePushRequest, notifyGroup, queueGroupNotice, type PushEnv } from '../src/push';
import { handleSharedRequest } from '../src/shared';
import { handleWishRequest } from '../src/wishes';
import { drainReminderQueue, localDateTimeToInstant } from '../src/reminders';

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function testKeys() {
  const vapid = await crypto.subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey) as ArrayBuffer));
  const privateKey = (await crypto.subtle.exportKey('jwk', vapid.privateKey) as JsonWebKey).d!;
  const receiver = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const p256dh = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey) as ArrayBuffer));
  const auth = base64url(crypto.getRandomValues(new Uint8Array(16)));
  return { publicKey, privateKey, p256dh, auth, receiver };
}

let accountNumber = 0;

describe('reminder time zones', () => {
  it('converts Japan midnight across the UTC date boundary', () => {
    expect(localDateTimeToInstant('2026-01-01','00:10','Asia/Tokyo')).toBe('2025-12-31T15:10:00.000Z');
  });

  it('rejects daylight-saving gaps and chooses the earlier occurrence for an ambiguous local time', () => {
    expect(localDateTimeToInstant('2026-03-08','02:30','America/New_York')).toBeNull();
    expect(localDateTimeToInstant('2026-11-01','01:30','America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  });
});

describe('in-app notification center', () => {
  it('stores generic group and wish notices without Push, scopes reads, and deduplicates events', async () => {
    const owner=await register('募集の作成者');
    const member=await register('募集を見る人');
    const outsider=await register('グループ外');
    const group=(await api('/api/groups/create',{name:'通知テスト'},owner.cookie)).data.membership;
    await api('/api/groups/join',{inviteCode:group.inviteCode},member.cookie);
    await api('/api/notifications/read-all',{},owner.cookie);

    const created=await api('/api/groups/wishes/create',{groupId:group.groupId,wishDate:'2026-11-15',
      isAllDay:true,message:'PRIVATE_WISH_MESSAGE'},owner.cookie);
    expect(created.status).toBe(201);
    const memberList=await api('/api/notifications',undefined,member.cookie);
    expect(memberList.status).toBe(200);
    expect(memberList.data.unreadCount).toBe(1);
    expect(memberList.data.notifications).toHaveLength(1);
    const notice=memberList.data.notifications[0];
    expect(notice.kind).toBe('wish_created');
    expect(notice.message).toBe('新しい「遊びたい日」の募集があります');
    expect(notice.targetPath).toContain('wishId='+created.data.id);
    expect(JSON.stringify(memberList.data)).not.toContain('PRIVATE_WISH_MESSAGE');
    expect((await api('/api/notifications',undefined,outsider.cookie)).data.notifications).toEqual([]);
    expect((await api('/api/notifications',undefined)).status).toBe(401);

    await api('/api/groups/wishes/react',{groupId:group.groupId,wishId:created.data.id},member.cookie);
    const ownerList=await api('/api/notifications',undefined,owner.cookie);
    expect(ownerList.data.notifications.some((item:any)=>item.kind==='wish_interested' &&
      item.targetPath.includes('wishId='+created.data.id))).toBe(true);
    expect(JSON.stringify(ownerList.data)).not.toContain('PRIVATE_WISH_MESSAGE');

    await queueGroupNotice({DB:env.DB},group.groupId,owner.user.id,
      {kind:'wish_created',body:'PRIVATE_NOTICE_BODY'},'duplicate-notice:'+created.data.id);
    await queueGroupNotice({DB:env.DB},group.groupId,owner.user.id,
      {kind:'wish_created',body:'PRIVATE_NOTICE_BODY'},'duplicate-notice:'+created.data.id);
    expect((await api('/api/notifications/count',undefined,member.cookie)).data.unreadCount).toBe(2);
    const outsiderRead=await api('/api/notifications/read',{id:notice.id},outsider.cookie);
    expect(outsiderRead.data.unreadCount).toBe(0);
    expect((await api('/api/notifications/count',undefined,member.cookie)).data.unreadCount).toBe(2);
    expect((await api('/api/notifications/read',{id:notice.id},member.cookie)).data.unreadCount).toBe(1);
    expect((await api('/api/notifications/read-all',{},member.cookie)).data.unreadCount).toBe(0);
    expect((await api('/api/notifications',undefined,member.cookie)).data.notifications.every((item:any)=>item.readAt)).toBe(true);

    expect((await api('/api/groups/leave',{groupId:group.groupId},member.cookie)).status).toBe(200);
    expect((await api('/api/notifications',undefined,member.cookie)).data.notifications).toEqual([]);
    expect((await api('/api/notifications/count',undefined,member.cookie)).data.unreadCount).toBe(0);
  });

  it('keeps a personal reminder in D1 without Push permission or private content', async () => {
    const owner=await register('個人リマインド本人');
    const other=await register('別の利用者');
    expect((await api('/api/personal/events/activate',{freshStart:true},owner.cookie)).status).toBe(200);
    const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
    const created=await api('/api/personal/events/create',{syncProtocol:2,id:'inbox-personal-event',
      operationId:'inbox-personal-create',event:{date,title:'PRIVATE_EVENT_TITLE',start:'10:00',end:'11:00',
        allDay:false,note:'PRIVATE_EVENT_NOTE',extra:{daySyncReminders:{offsetMinutes:[10],timeZone:'Asia/Tokyo'}}}},owner.cookie);
    expect(created.status).toBe(200);
    await env.DB.prepare('UPDATE event_reminders SET due_at=?1 WHERE user_id=?2 AND personal_event_id=?3')
      .bind('2000-01-01T00:00:00.000Z',owner.user.id,'inbox-personal-event').run();
    await drainReminderQueue({DB:env.DB});
    await drainReminderQueue({DB:env.DB});
    const list=await api('/api/notifications',undefined,owner.cookie);
    expect(list.data.unreadCount).toBe(1);
    expect(list.data.notifications).toHaveLength(1);
    expect(list.data.notifications[0].kind).toBe('event_reminder');
    expect(list.data.notifications[0].targetPath).toContain('eventId=inbox-personal-event');
    expect(JSON.stringify(list.data)).not.toContain('PRIVATE_EVENT_TITLE');
    expect(JSON.stringify(list.data)).not.toContain('PRIVATE_EVENT_NOTE');
    expect((await api('/api/notifications',undefined,other.cookie)).data.notifications).toEqual([]);
    const persisted=await env.DB.prepare('SELECT * FROM in_app_notifications WHERE user_id=?1')
      .bind(owner.user.id).all<any>();
    expect(JSON.stringify(persisted.results)).not.toContain('PRIVATE_EVENT_TITLE');
    expect(JSON.stringify(persisted.results)).not.toContain('PRIVATE_EVENT_NOTE');
    expect((await env.DB.prepare(`SELECT id FROM push_deliveries WHERE reminder_id IN
      (SELECT id FROM event_reminders WHERE personal_event_id='inbox-personal-event')`).all()).results).toHaveLength(0);
  });

  it('paginates history and retains it when a Push delivery fails', async () => {
    const owner=await register('通知送信者');
    const member=await register('通知受信者');
    const group=(await api('/api/groups/create',{name:'履歴一覧'},owner.cookie)).data.membership;
    await api('/api/groups/join',{inviteCode:group.inviteCode},member.cookie);
    for (let index=0;index<32;index++) await queueGroupNotice({DB:env.DB},group.groupId,owner.user.id,
      {kind:'group_event_created',body:'共有予定'},'page:'+group.groupId+':'+index);
    const first=await api('/api/notifications',undefined,member.cookie);
    expect(first.data.notifications).toHaveLength(30);
    expect(first.data.unreadCount).toBe(32);
    expect(first.data.nextCursor).not.toBeNull();
    const {beforeAt,beforeId}=first.data.nextCursor;
    const second=await api('/api/notifications?beforeAt='+encodeURIComponent(beforeAt)+'&beforeId='+beforeId,
      undefined,member.cookie);
    expect(second.data.notifications).toHaveLength(2);
    expect(new Set([...first.data.notifications,...second.data.notifications].map((item:any)=>item.id)).size).toBe(32);
    expect((await api('/api/notifications?beforeAt=bad&beforeId=bad',undefined,member.cookie)).status).toBe(400);

    const keys=await testKeys();
    const pushEnv:PushEnv={DB:env.DB,VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,
      VAPID_SUBJECT:'mailto:test@example.com'};
    const endpoint='https://fcm.googleapis.com/fcm/send/inbox-failure';
    expect((await handlePushRequest(new Request('https://example.com/api/push/subscribe',{method:'POST',body:JSON.stringify({
      endpoint,p256dh:keys.p256dh,auth:keys.auth,
    })}),pushEnv,'/api/push/subscribe',member.user)).status).toBe(200);
    await queueGroupNotice(pushEnv,group.groupId,owner.user.id,
      {kind:'group_event_updated',body:'更新'},'push-failure:'+group.groupId);
    vi.stubGlobal('fetch',async()=>new Response(null,{status:503}));
    try { await drainPushQueue(pushEnv); } finally { vi.unstubAllGlobals(); }
    expect((await api('/api/notifications/count',undefined,member.cookie)).data.unreadCount).toBe(33);
expect((await env.DB.prepare(`SELECT id FROM push_deliveries WHERE subscription_id IN
      (SELECT id FROM push_subscriptions WHERE user_id=?1)`).bind(member.user.id).all()).results.length).toBeGreaterThan(0);
  });
});

async function api(path: string, body?: Record<string, unknown>, cookie = '', origin = PUBLIC_APP_ORIGIN) {
  const headers: Record<string, string> = { Origin:origin };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const response = await SELF.fetch(`https://example.com${path}`, {
    method:body ? 'POST' : 'GET', headers, body:body ? JSON.stringify(body) : undefined,
  });
  return {
    status:response.status,
    data:await response.json() as Record<string, any>,
    cookie:response.headers.get('set-cookie')?.split(';')[0] || '',
    setCookie:response.headers.get('set-cookie') || '',
    headers:response.headers,
  };
}

async function register(name = '予定 太郎') {
  const email = `tester${++accountNumber}@example.com`;
  const result = await api('/api/auth/register', { displayName:name, email, password:'Very-safe-password-123', passwordConfirm:'Very-safe-password-123' });
  expect(result.status).toBe(200);
  return { email, cookie:result.cookie, setCookie:result.setCookie, user:result.data.user };
}

beforeAll(async () => {
  for (const file of [migration1, migration2, migration3, migration4, migration5, migration6, migration7, migration8, migration9, migration10]) {
    for (const statement of file.split(';').map((part) => part.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
  }
  await applySQL(env.DB, migration12);
  await applySQL(env.DB, migration13);
  await applySQL(env.DB, migration14);
  await applySQL(env.DB, migration14a);
  await applySQL(env.DB, migration15);
  await applySQL(env.DB, migration16);
});

describe('DaySync authentication', () => {
  it('keeps authenticated non-group APIs available in emergency pause and stops group APIs and Cron', async () => {
    const owner=await register('一時停止の確認');
    const group=(await api('/api/groups/create',{name:'一時停止テスト'},owner.cookie)).data.membership;
    const paused={...env,GROUP_ACCESS_PAUSED:'true'};
    const call=async(path:string,body?:Record<string,unknown>)=>worker.fetch(new Request('https://example.com'+path,{
      method:body?'POST':'GET',headers:{Origin:PUBLIC_APP_ORIGIN,Cookie:owner.cookie,'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,
    }),paused,createExecutionContext());
    expect((await call('/api/auth/me')).status).toBe(200);
    expect((await call('/api/personal/events/status')).status).toBe(200);
    for(const [path,body] of [
      ['/api/groups/mine',{}],['/api/groups/leave',{groupId:group.groupId}],
      ['/api/shared/events/list',{groupId:group.groupId,month:'2030-10'}],
      ['/api/reminders/shared/get',{groupId:group.groupId,eventId:'none'}],
    ] as Array<[string,Record<string,unknown>]>) {
      const response=await call(path,body);
      expect(response.status).toBe(503);
      expect((await response.json() as any).error).toContain('一時停止中');
    }
    const waitUntil=vi.fn();
    await worker.scheduled({} as ScheduledController,paused,{waitUntil} as unknown as ExecutionContext);
    expect(waitUntil).not.toHaveBeenCalled();
  });
  it('enables local CORS only with the development flag and a loopback HTTP Worker', async () => {
    for (const host of ['localhost', '127.0.0.1']) {
      for (const port of [5500, 3000, 5173, 8767]) {
        const origin = `http://${host}:${port}`;
        const request = new Request(`http://${host}:8787/api/auth/register`, { method:'OPTIONS', headers:{ Origin:origin } });
        const local = await worker.fetch(request, { ...env, LOCAL_DEV:'true' }, createExecutionContext());
        expect(local.status).toBe(204);
        expect(local.headers.get('access-control-allow-origin')).toBe(origin);
        expect(local.headers.get('access-control-allow-credentials')).toBe('true');
        expect((await worker.fetch(request, { ...env, LOCAL_DEV:undefined }, createExecutionContext())).status).toBe(403);
        const production = new Request('https://example.com/api/auth/register', request);
        expect((await worker.fetch(production, { ...env, LOCAL_DEV:'true' }, createExecutionContext())).status).toBe(403);
      }
    }
    for (const origin of ['http://localhost:5501', 'http://localhost.evil.test:5500', 'http://192.168.1.1:5500', 'null']) {
      const denied = await worker.fetch(new Request('http://localhost:8787/api/auth/me', { headers:{ Origin:origin } }), { ...env, LOCAL_DEV:'true' }, createExecutionContext());
      expect(denied.status).toBe(403);
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('omits Secure only in local development and clears the same cookie on logout', async () => {
    for (const [url, flag, secure] of [
      ['http://localhost:8787', 'true', false],
      ['http://127.0.0.1:8787', 'true', false],
      ['http://localhost:8787', undefined, true],
      ['http://example.com', 'true', true],
      ['https://localhost:8787', 'true', true],
      ['https://example.com', undefined, true],
    ] as const) {
      const bindings = { ...env, LOCAL_DEV:flag };
      const origin = PUBLIC_APP_ORIGIN;
      const response = await worker.fetch(new Request(`${url}/api/auth/register`, {
        method:'POST', headers:{ Origin:origin, 'Content-Type':'application/json' },
        body:JSON.stringify({ displayName:'Cookie確認', email:`cookie${++accountNumber}@example.com`, password:'test-password-123', passwordConfirm:'test-password-123' }),
      }), bindings, createExecutionContext());
      expect(response.status).toBe(200);
      const cookie = response.headers.get('set-cookie')!;
      expect(cookie.includes('; Secure')).toBe(secure);
      expect(cookie).toContain('HttpOnly; SameSite=Lax');
      const logout = await worker.fetch(new Request(`${url}/api/auth/logout`, {
        method:'POST', headers:{ Origin:origin, Cookie:cookie.split(';')[0] }, body:'{}',
      }), bindings, createExecutionContext());
      expect(logout.headers.get('set-cookie')!.includes('; Secure')).toBe(secure);
      expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    }
  });

  it('requires login and preserves sessions in an HttpOnly cookie', async () => {
    expect((await api('/api/auth/me')).status).toBe(401);
    expect((await api('/api/wage', { hourly:1200, hours:8 })).status).toBe(401);
    const account = await register();
    expect(account.cookie).toMatch(/^daysync_session=/);
    expect(account.setCookie).toContain('HttpOnly');
    expect(account.setCookie).toContain('Secure');
    expect(account.setCookie).toContain('SameSite=Lax');
    expect(account.setCookie).toContain('Max-Age=31536000');
    const session = await env.DB.prepare('SELECT expires_at FROM auth_sessions WHERE user_id = ?1').bind(account.user.id).first<{ expires_at:string }>();
    expect(Date.parse(session!.expires_at) - Date.now()).toBeGreaterThan(364 * 86400_000);
    const me = await api('/api/auth/me', undefined, account.cookie);
    expect(me.data.user.id).toBe(account.user.id);
    expect(me.setCookie).toBe('');
    const wage = await api('/api/wage', { hourly:1200, hours:8 }, account.cookie);
    expect(wage.data.wage).toBe(9600);
    const budget = await api('/api/budget', { income:80000, fixed:20000, saving:10000, spent:5000 }, account.cookie);
    expect(budget.data.remaining).toBe(45000);
    const logout = await api('/api/auth/logout', {}, account.cookie);
    expect(logout.status).toBe(200);
    expect(logout.setCookie).toContain('Max-Age=0');
    expect(await env.DB.prepare('SELECT id_hash FROM auth_sessions WHERE user_id = ?1').bind(account.user.id).first()).toBeNull();
    expect((await api('/api/auth/me', undefined, account.cookie)).status).toBe(401);
  });

  it('calculates the selected budget month using the device date, including leap years', async () => {
    const account = await register();
    const amounts = { income:90000, fixed:10000, saving:10000, spent:30000 };
    const current = await api('/api/budget', { ...amounts, month:'2028-02', today:'2028-02-10' }, account.cookie);
    expect(current.data).toMatchObject({ remaining:40000, daily:2000, status:'caution' });
    const future = await api('/api/budget', { ...amounts, month:'2028-03', today:'2028-02-10' }, account.cookie);
    expect(future.data).toMatchObject({ remaining:40000, daily:Math.round(40000/31), status:'safe' });
    const past = await api('/api/budget', { ...amounts, month:'2028-01', today:'2028-02-10' }, account.cookie);
    expect(past.data).toMatchObject({ remaining:40000, daily:null, status:'safe' });
    expect(past.data.message).toContain('この月');
    for (const invalid of [{month:'2028-13',today:'2028-02-10'}, {month:'2028-02',today:'2028-02-30'},
      {month:'2028-02'}]) {
      expect((await api('/api/budget', { ...amounts, ...invalid }, account.cookie)).status).toBe(400);
    }
  });

  it('does not expose another user budget or wage data', async () => {
    const owner = await register();
    const other = await register();
    const budget = await api('/api/budget', {
      userId:owner.user.id, income:80000, fixed:20000, saving:10000, spent:5000,
      expenseNote:'PRIVATE_EXPENSE_NOTE', expenses:[{ amount:5000, note:'PRIVATE_EXPENSE_NOTE' }],
    }, other.cookie);
    expect(budget.status).toBe(200);
    expect(Object.keys(budget.data).sort()).toEqual(['daily', 'message', 'remaining', 'status']);
    expect(JSON.stringify(budget.data)).not.toContain('PRIVATE_EXPENSE_NOTE');
    const wage = await api('/api/wage', { userId:owner.user.id, hourly:1200, hours:8 }, other.cookie);
    expect(wage.data).toEqual({ wage:9600 });
    expect((await api(`/api/budget?userId=${owner.user.id}`, undefined, other.cookie)).status).toBe(405);
    expect((await api(`/api/budget/${owner.user.id}`, undefined, other.cookie)).status).toBe(404);
  });
  it('extends an existing unexpired 30-day session on the next /me request', async () => {
    const account = await register();
    const oldExpiry = new Date(Date.now() + 29 * 86400_000).toISOString();
    await env.DB.prepare('UPDATE auth_sessions SET expires_at = ?1 WHERE user_id = ?2').bind(oldExpiry, account.user.id).run();
    const me = await api('/api/auth/me', undefined, account.cookie);
    expect(me.status).toBe(200);
    expect(me.data.user.id).toBe(account.user.id);
    expect(me.setCookie).toContain('Max-Age=31536000');
    expect(me.cookie).toBe(account.cookie);
    const renewed = await env.DB.prepare('SELECT expires_at FROM auth_sessions WHERE user_id = ?1').bind(account.user.id).first<{ expires_at:string }>();
    expect(Date.parse(renewed!.expires_at) - Date.now()).toBeGreaterThan(364 * 86400_000);
  });

  it('rejects duplicate email, mismatched confirmation and incorrect login', async () => {
    const account = await register();
    const duplicate = await api('/api/auth/register', { displayName:'別人', email:account.email.toUpperCase(), password:'Very-safe-password-123', passwordConfirm:'Very-safe-password-123' });
    expect(duplicate.status).toBe(409);
    const mismatch = await api('/api/auth/register', { displayName:'別人', email:'other@example.com', password:'Very-safe-password-123', passwordConfirm:'different' });
    expect(mismatch.status).toBe(400);
    expect((await api('/api/auth/login', { email:account.email, password:'wrong-password' })).status).toBe(401);
    const login = await api('/api/auth/login', { email:account.email, password:'Very-safe-password-123' });
    expect(login.status).toBe(200);
    expect((await api('/api/auth/me', undefined, login.cookie)).data.user.id).toBe(account.user.id);
    const row = await env.DB.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?1').bind(account.user.id).first<{ password_hash:string; password_salt:string }>();
    expect(row?.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(row?.password_hash).not.toContain('Very-safe-password-123');
    expect(row?.password_salt).toHaveLength(32);
  });

  it('allows only the configured frontend origin with credentials', async () => {
    const account = await register();
    const allowed = await api('/api/auth/me', undefined, account.cookie);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(PUBLIC_APP_ORIGIN);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    const denied = await api('/api/auth/me', undefined, account.cookie, 'https://evil.example');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('supports authentication and protected APIs from the production frontend origin', async () => {
    const origin = PUBLIC_APP_ORIGIN;
    const expectCors = (headers: Headers) => {
      expect(headers.get('access-control-allow-origin')).toBe(origin);
      expect(headers.get('access-control-allow-origin')).not.toBe('*');
      expect(headers.get('access-control-allow-credentials')).toBe('true');
    };

    const me = await api('/api/auth/me', undefined, '', origin);
    expect(me.status).toBe(401);
    expectCors(me.headers);

    for (const path of ['/api/profile', '/api/groups/mine', '/api/push/config']) {
      const response = await api(path, undefined, '', origin);
      expect(response.status).toBe(401);
      expectCors(response.headers);
    }

    const credentials = {
      displayName:'本番Origin利用者',
      email:`origin${++accountNumber}@example.com`,
      password:'Very-safe-password-123',
      passwordConfirm:'Very-safe-password-123',
    };
    const registered = await api('/api/auth/register', credentials, '', origin);
    expect(registered.status).toBe(200);
    expectCors(registered.headers);
    expect(registered.setCookie).toContain('HttpOnly');
    const registeredMe = await api('/api/auth/me', undefined, registered.cookie, origin);
    expect(registeredMe.status).toBe(200);
    expectCors(registeredMe.headers);

    const login = await api('/api/auth/login', { email:credentials.email, password:credentials.password }, '', origin);
    expect(login.status).toBe(200);
    expectCors(login.headers);
    const authenticatedMe = await api('/api/auth/me', undefined, login.cookie, origin);
    expect(authenticatedMe.status).toBe(200);
    expectCors(authenticatedMe.headers);

    const logout = await api('/api/auth/logout', {}, login.cookie, origin);
    expect(logout.status).toBe(200);
    expectCors(logout.headers);
    expect((await api('/api/auth/me', undefined, login.cookie, origin)).status).toBe(401);

    const relogin = await api('/api/auth/login', { email:credentials.email, password:credentials.password }, '', origin);
    expect(relogin.status).toBe(200);
    expectCors(relogin.headers);
    expect((await api('/api/auth/me', undefined, relogin.cookie, origin)).status).toBe(200);

    const preflight = await SELF.fetch('https://example.com/api/auth/register', {
      method:'OPTIONS',
      headers:{
        Origin:origin,
        'Access-Control-Request-Method':'POST',
        'Access-Control-Request-Headers':'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expectCors(preflight.headers);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('rejects expired sessions', async () => {
    const account = await register();
    await env.DB.prepare('UPDATE auth_sessions SET expires_at = ?1 WHERE user_id = ?2')
      .bind('2000-01-01T00:00:00.000Z', account.user.id).run();
    expect((await api('/api/auth/me', undefined, account.cookie)).status).toBe(401);
  });
});

describe('account-bound groups', () => {
	it('shares preset icons with members, keeps groups isolated, and rejects non-members', async () => {
		const owner = await register('アイコン管理者');
		const member = await register('アイコン参加者');
		const outsider = await register('アイコン外部');
		const first = (await api('/api/groups/create', { name:'旅行仲間' }, owner.cookie)).data.membership;
		const second = (await api('/api/groups/create', { name:'大学' }, owner.cookie)).data.membership;
		await api('/api/groups/join', { inviteCode:first.inviteCode }, member.cookie);
		await env.DB.prepare("UPDATE groups SET avatar_key = 'legacy/groups/test.webp', avatar_updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1")
			.bind(first.groupId).run();

		expect((await api('/api/groups/icon', { groupId:first.groupId, groupIcon:'travel', groupIconColor:'blue' }, owner.cookie)).data)
			.toMatchObject({ ok:true, groupIcon:'travel', groupIconColor:'blue' });
		expect((await api('/api/groups/mine', {}, member.cookie)).data.groups[0])
			.toMatchObject({ groupId:first.groupId, groupIcon:'travel', groupIconColor:'blue' });
		expect(await env.DB.prepare('SELECT avatar_key FROM groups WHERE id = ?1').bind(first.groupId).first())
			.toMatchObject({ avatar_key:'legacy/groups/test.webp' });
		expect((await api('/api/groups/mine', {}, owner.cookie)).data.groups.find((group:any) => group.groupId === second.groupId))
			.toMatchObject({ groupIcon:'friends', groupIconColor:'green' });
		expect((await api('/api/groups/icon', { groupId:second.groupId, groupIcon:'food', groupIconColor:'orange' }, owner.cookie)).status).toBe(200);
		expect((await api('/api/groups/mine', {}, owner.cookie)).data.groups.find((group:any) => group.groupId === first.groupId))
			.toMatchObject({ groupIcon:'travel', groupIconColor:'blue' });
		expect((await api('/api/groups/icon', { groupId:first.groupId, groupIcon:'invalid', groupIconColor:'blue' }, owner.cookie)).status).toBe(400);
		expect((await api('/api/groups/icon', { groupId:first.groupId, groupIcon:'travel', groupIconColor:'url(javascript:alert(1))' }, owner.cookie)).status).toBe(400);
		expect((await api('/api/groups/icon', { groupId:first.groupId, groupIcon:'game', groupIconColor:'pink', userId:owner.user.id }, outsider.cookie)).status).toBe(404);
		expect((await api('/api/groups/icon', { groupId:first.groupId, groupIcon:null, groupIconColor:'blue' }, owner.cookie)).status).toBe(400);
		expect(await env.DB.prepare('SELECT avatar_key FROM groups WHERE id = ?1').bind(first.groupId).first())
			.toMatchObject({ avatar_key:'legacy/groups/test.webp' });
		expect((await api('/api/groups/icon', { groupId:first.groupId, groupIcon:'game', groupIconColor:'pink' })).status).toBe(401);
	});

	it('renames a group for its members and rejects invalid or unauthorized changes', async () => {
		const owner = await register();
		const member = await register();
		const outsider = await register();
		const group = (await api('/api/groups/create', { name:'いつメン' }, owner.cookie)).data.membership;
		await api('/api/groups/join', { inviteCode:group.inviteCode }, member.cookie);

		expect((await api('/api/groups/rename', { groupId:group.groupId, name:'  大学の友だち  ' }, owner.cookie)).data)
			.toMatchObject({ ok:true, groupName:'大学の友だち' });
		expect((await api('/api/groups/mine', {}, member.cookie)).data.groups[0].groupName).toBe('大学の友だち');
		expect((await api('/api/groups/rename', { groupId:group.groupId, name:'大学の友だち' }, member.cookie)).status).toBe(200);
		expect((await api('/api/groups/rename', { groupId:group.groupId, name:'   ' }, owner.cookie)).status).toBe(400);
		expect((await api('/api/groups/rename', { groupId:group.groupId, name:'あ'.repeat(61) }, owner.cookie)).status).toBe(400);
		expect((await api('/api/groups/rename', { groupId:group.groupId, name:'不正な変更', userId:owner.user.id }, outsider.cookie)).status).toBe(404);
		expect((await api('/api/groups/rename', { groupId:group.groupId, name:'未認証の変更' })).status).toBe(401);
	});

  it('supports duplicate display names without sharing private membership', async () => {
    const first = await register('同じ名前');
    const second = await register('同じ名前');
    const created = await api('/api/groups/create', { name:'家族', memberName:'同じ名前' }, first.cookie);
    expect(created.status).toBe(201);
    const group = created.data.membership;
    expect(group.memberToken).toBeUndefined();
    const joined = await api('/api/groups/join', { inviteCode:group.inviteCode, memberName:'同じ名前' }, second.cookie);
    expect(joined.status).toBe(201);
    expect(joined.data.membership.memberId).not.toBe(group.memberId);
    expect((await api('/api/groups/mine', {}, first.cookie)).data.groups).toHaveLength(1);
    const members = await api('/api/groups/members/list', { groupId:group.groupId }, first.cookie);
    expect(members.data.members).toHaveLength(2);
    expect(members.data.members.map((member: any) => member.userId).sort()).toEqual([first.user.id, second.user.id].sort());
    expect((await api('/api/groups/members/list', { groupId:group.groupId })).status).toBe(401);
    const third = await register();
    expect((await api('/api/groups/members/list', { groupId:group.groupId }, third.cookie)).status).toBe(401);
  });

  it('never mirrors personal entries while sharing shift intervals and isolating other groups', async () => {
    const first = await register();
    const second = await register();
    const outsider = await register();
    const group = (await api('/api/groups/create', { name:'schedule privacy group' }, first.cookie)).data.membership;
    const other = (await api('/api/groups/create', { name:'isolated group' }, first.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:group.inviteCode }, second.cookie);
    const entries = [
      { sourceType:'personal', sourceId:'private-personal-source', eventDate:'2026-10-10', title:'PRIVATE_PERSONAL_TITLE', start:'18:00', end:'20:00', allDay:false, note:'PRIVATE_PERSONAL_NOTE' },
      { sourceType:'shift', sourceId:'private-shift-source', eventDate:'2026-10-10', title:'PRIVATE_WORKPLACE_AND_PAY', start:'19:00', end:'21:00', allDay:false, note:'PRIVATE_SHIFT_MEMO' },
      { sourceType:'shift', sourceId:'overnight-private-shift', eventDate:'2026-10-10', title:'PRIVATE_OVERNIGHT_SHIFT', start:'22:00', end:'06:00', allDay:false, note:'PRIVATE_OVERNIGHT_MEMO' },
    ];
    expect((await api('/api/shared/calendar/sync', { groupId:group.groupId, month:'2026-10', userId:second.user.id, entries }, first.cookie)).status).toBe(200);
    const ownerEvents = (await api('/api/shared/events/list', { groupId:group.groupId, month:'2026-10' }, first.cookie)).data.events;
    expect(ownerEvents).toHaveLength(2);
    expect(JSON.stringify(ownerEvents)).not.toContain('PRIVATE_PERSONAL_TITLE');
    expect(JSON.stringify(ownerEvents)).not.toContain('PRIVATE_PERSONAL_NOTE');
    expect(ownerEvents.find((event:any) => event.sourceType === 'shift')).toMatchObject({
      title:'PRIVATE_WORKPLACE_AND_PAY', note:'PRIVATE_SHIFT_MEMO', createdByUserId:first.user.id,
    });
    const memberResponse = await api('/api/shared/events/list', { groupId:group.groupId, month:'2026-10' }, second.cookie);
    expect(memberResponse.data.events).toHaveLength(2);
    for (const event of memberResponse.data.events) {
      expect(event).toMatchObject({ title:'\u4e88\u5b9a\u3042\u308a', eventDate:'2026-10-10', sourceType:'busy' });
      expect(Object.keys(event).sort()).toEqual(['allDay', 'end', 'eventDate', 'id', 'sourceType', 'start', 'title']);
    }
    for (const secret of [
      'PRIVATE_PERSONAL_TITLE', 'PRIVATE_PERSONAL_NOTE', 'PRIVATE_WORKPLACE_AND_PAY', 'PRIVATE_SHIFT_MEMO',
      'private-personal-source', 'private-shift-source', first.user.id, group.memberId,
    ]) expect(JSON.stringify(memberResponse.data)).not.toContain(secret);
    const availability = await api('/api/shared/availability', {
      groupId:group.groupId, userId:first.user.id, date:'2026-10-10',
    }, second.cookie);
    expect(availability.data.busy).toEqual([
      { start:'19:00', end:'21:00', label:'\u4e88\u5b9a\u3042\u308a' },
      { start:'22:00', end:'24:00', label:'\u4e88\u5b9a\u3042\u308a' },
    ]);
    expect(JSON.stringify(availability.data)).not.toContain('PRIVATE_');
    const nextDayAvailability = await api('/api/shared/availability', {
      groupId:group.groupId, userId:first.user.id, date:'2026-10-11',
    }, second.cookie);
    expect(nextDayAvailability.data.busy).toEqual([{ start:'00:00', end:'06:00', label:'\u4e88\u5b9a\u3042\u308a' }]);
    expect(nextDayAvailability.data.free).toEqual([{ start:'09:00', end:'22:00' }]);
    expect((await api('/api/shared/events/list', { groupId:group.groupId, month:'2026-10' }, outsider.cookie)).status).toBe(401);
    expect((await api('/api/shared/events/list', { groupId:group.groupId, month:'2026-10' })).status).toBe(401);
    expect((await api('/api/shared/calendar/sync', { groupId:group.groupId, month:'2026-10', userId:first.user.id, entries:[] }, outsider.cookie)).status).toBe(401);
    expect((await api('/api/shared/events/list', { groupId:other.groupId, month:'2026-10' }, first.cookie)).data.events).toHaveLength(0);
    expect((await api('/api/shared/calendar/sync', { groupId:group.groupId, month:'2026-10', entries:[], syncShifts:true }, first.cookie)).status).toBe(200);
    expect((await api('/api/shared/events/list', { groupId:group.groupId, month:'2026-10' }, second.cookie)).data.events).toHaveLength(0);
  });

  it('does not rewrite unchanged shift mirror rows on a retry', async () => {
    const owner = await register();
    const group = (await api('/api/groups/create', { name:'shift retry' }, owner.cookie)).data.membership;
    await env.DB.prepare('CREATE TABLE test_shift_sync_audit (id INTEGER PRIMARY KEY)').run();
    await env.DB.prepare(`CREATE TRIGGER test_shift_sync_insert AFTER INSERT ON member_calendar_entries
      BEGIN INSERT INTO test_shift_sync_audit(id) VALUES (NULL); END`).run();
    await env.DB.prepare(`CREATE TRIGGER test_shift_sync_delete AFTER DELETE ON member_calendar_entries
      BEGIN INSERT INTO test_shift_sync_audit(id) VALUES (NULL); END`).run();
    const entry = {sourceType:'shift',sourceId:'2026-10-12',eventDate:'2026-10-12',
      title:'シフト',start:'18:00',end:'22:00',allDay:false,note:''};
    const sync = (entries:typeof entry[]) => api('/api/shared/calendar/sync',
      {groupId:group.groupId,month:'2026-10',entries,syncShifts:true},owner.cookie);
    expect((await sync([entry])).data).toMatchObject({ok:true,count:1});
    const count = async () => Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM test_shift_sync_audit')
      .first<{n:number}>())?.n);
    const initial = await count();
    expect((await sync([entry])).data).toMatchObject({ok:true,count:1});
    expect(await count()).toBe(initial);
    expect((await sync([{...entry,end:'23:00'}])).data).toMatchObject({ok:true,count:1});
    expect(await count()).toBeGreaterThan(initial);
  });

  it('keeps existing shared-event edit permissions', async () => {
    const owner = await register();
    const guest = await register();
    const outsider = await register();
    const group = (await api('/api/groups/create', { name:'shared event group' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:group.inviteCode }, guest.cookie);
    const event = { groupId:group.groupId, title:'SHARED_EVENT_TITLE', eventDate:'2026-10-01', allDay:true, start:'', end:'', note:'SHARED_EVENT_NOTE' };
    const created = await api('/api/shared/events/create', event, owner.cookie);
    expect(created.status).toBe(201);
    const sharedEvent = (await api('/api/shared/events/list', { groupId:group.groupId, month:'2026-10' }, guest.cookie)).data.events[0];
    expect(sharedEvent).toMatchObject({ title:'SHARED_EVENT_TITLE', note:'SHARED_EVENT_NOTE', createdByUserId:owner.user.id });
    const blocked = await api('/api/shared/events/update', { ...event, id:created.data.id, userId:owner.user.id, title:'unauthorized edit' }, guest.cookie);
    expect(blocked.status).toBe(403);
    expect((await api('/api/shared/events/delete', { groupId:group.groupId, id:created.data.id, userId:owner.user.id }, guest.cookie)).status).toBe(403);
    expect((await api('/api/shared/events/delete', { groupId:group.groupId, id:created.data.id }, outsider.cookie)).status).toBe(401);
    expect((await api('/api/shared/events/delete', { groupId:group.groupId, id:created.data.id }, owner.cookie)).status).toBe(200);
  });

  it('claims an old member token for exactly one logged-in user', async () => {
    const owner = await register();
    const other = await register();
    const group = (await api('/api/groups/create', { name:'旧グループ' }, owner.cookie)).data.membership;
    const memberId = crypto.randomUUID();
    const oldToken = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO group_members (id, group_id, display_name, access_token, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(memberId, group.groupId, '旧メンバー', oldToken, new Date().toISOString()).run();
    const claim = { groupId:group.groupId, memberId, memberToken:oldToken };
    expect((await api('/api/groups/claim', claim, other.cookie)).status).toBe(200);
    expect((await api('/api/groups/claim', claim, other.cookie)).status).toBe(200);
    expect((await api('/api/groups/claim', claim, owner.cookie)).status).toBe(403);
    expect((await api('/api/groups/mine', {}, other.cookie)).data.groups[0].memberId).toBe(memberId);
  });

  it('uses users.display_name for shared events and synced shifts, not group aliases', async () => {
    const owner = await register('りく');
    const guest = await register('あ');
    const group = (await api('/api/groups/create', { name:'研究室', memberName:'a' }, owner.cookie)).data.membership;
    const joined = (await api('/api/groups/join', { inviteCode:group.inviteCode, memberName:'b' }, guest.cookie)).data.membership;
    const event = await api('/api/shared/events/create', {
      groupId:group.groupId, title:'集合', eventDate:'2026-10-10', allDay:true, start:'', end:'', note:'',
    }, owner.cookie);
    expect(event.status).toBe(201);
    expect((await api('/api/shared/calendar/sync', { groupId:group.groupId, month:'2026-10', entries:[{
      sourceType:'shift', sourceId:'guest-shift', eventDate:'2026-10-10', title:'シフト',
      allDay:false, start:'18:00', end:'23:00', note:'',
    }] }, guest.cookie)).status).toBe(200);
    const events = (await api('/api/shared/events/list', { groupId:group.groupId, month:'2026-10' }, guest.cookie)).data.events;
    expect(events.find((item:any) => item.sourceType === 'shared')).toMatchObject({
      createdByName:'りく', createdByUserId:owner.user.id, createdByMemberId:group.memberId,
    });
    expect(events.find((item:any) => item.sourceType === 'shift')).toMatchObject({
      createdByName:'あ', createdByUserId:guest.user.id, createdByMemberId:joined.memberId,
    });
    await api('/api/profile/update', { displayName:'りく新', profileIcon:'🌿' }, owner.cookie);
    const renamed = (await api('/api/shared/events/list', { groupId:group.groupId, month:'2026-10' }, guest.cookie)).data.events;
    expect(renamed.find((item:any) => item.sourceType === 'shared').createdByName).toBe('りく新');
    const ownerView = (await api('/api/shared/events/list', { groupId:group.groupId, month:'2026-10' }, owner.cookie)).data.events;
    expect(ownerView.find((item:any) => item.sourceType === 'busy')).toMatchObject({
      title:'\u4e88\u5b9a\u3042\u308a', start:'18:00', end:'23:00', sourceType:'busy',
    });
    expect(JSON.stringify(ownerView)).not.toContain('guest-shift');
  });

  it('isolates play-day wishes by group and enforces owner edits and member reactions', async () => {
    const owner = await register('りく');
    const guest = await register('あ');
    const outsider = await register('部外者');
    const group = (await api('/api/groups/create', { name:'友達', memberName:'仮名' }, owner.cookie)).data.membership;
    const other = (await api('/api/groups/create', { name:'研究室' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:group.inviteCode }, guest.cookie);
    const wish = { groupId:group.groupId, wishDate:'2026-10-10', isAllDay:false,
      start:'13:00', end:'', message:'誰か空いてたら遊びたい' };
    expect((await api('/api/groups/wishes/create', { ...wish, wishDate:'2026-02-30' }, owner.cookie)).status).toBe(400);
    expect((await api('/api/groups/wishes/create', { ...wish, end:'12:00' }, owner.cookie)).status).toBe(400);
    const created = await api('/api/groups/wishes/create', wish, owner.cookie);
    expect(created.status).toBe(201);
    const wishId = created.data.id;
    expect((await api('/api/groups/wishes/create', { groupId:other.groupId, wishDate:'2026-10-15', isAllDay:true }, owner.cookie)).status).toBe(201);
    const visible = await api('/api/groups/wishes/list', { groupId:group.groupId }, guest.cookie);
    expect(visible.data.wishes).toHaveLength(1);
    expect(visible.data.wishes[0]).toMatchObject({
      id:wishId, userId:owner.user.id, ownerName:'りく', ownerIcon:'🌿',
      isOwn:false, reactionCount:0, reacted:false, start:'13:00', end:'',
    });
    expect((await api('/api/groups/wishes/list', { groupId:other.groupId }, guest.cookie)).status).toBe(401);
    expect((await api('/api/groups/wishes/list', { groupId:group.groupId }, outsider.cookie)).status).toBe(401);
    expect((await api('/api/groups/wishes/react', { groupId:group.groupId, wishId }, outsider.cookie)).status).toBe(401);
    expect((await api('/api/groups/wishes/react', { groupId:group.groupId, wishId }, owner.cookie)).status).toBe(400);
    expect((await api('/api/groups/wishes/react', { groupId:other.groupId, wishId }, owner.cookie)).status).toBe(404);
    expect((await api('/api/groups/wishes/react', { groupId:group.groupId, wishId }, guest.cookie)).status).toBe(200);
    expect((await api('/api/groups/wishes/react', { groupId:group.groupId, wishId }, guest.cookie)).status).toBe(200);
    expect((await api('/api/groups/wishes/list', { groupId:group.groupId }, owner.cookie)).data.wishes[0].reactionCount).toBe(1);
    expect((await api('/api/groups/wishes/list', { groupId:group.groupId }, guest.cookie)).data.wishes[0].reacted).toBe(true);
    expect((await api('/api/groups/wishes/unreact', { groupId:group.groupId, wishId }, guest.cookie)).status).toBe(200);
    expect((await api('/api/groups/wishes/list', { groupId:group.groupId }, owner.cookie)).data.wishes[0].reactionCount).toBe(0);
    expect((await api('/api/groups/wishes/update', { ...wish, wishId, message:'勝手な編集' }, guest.cookie)).status).toBe(403);
    expect((await api('/api/groups/wishes/delete', { groupId:group.groupId, wishId }, guest.cookie)).status).toBe(403);
    expect((await api('/api/groups/wishes/update', { ...wish, wishId, message:'ご飯行きたい', isAllDay:true }, owner.cookie)).status).toBe(200);
    expect((await api('/api/groups/wishes/list', { groupId:group.groupId }, guest.cookie)).data.wishes[0]).toMatchObject({ message:'ご飯行きたい', isAllDay:true });
    expect((await api('/api/groups/wishes/delete', { groupId:group.groupId, wishId }, owner.cookie)).status).toBe(200);
    expect((await api('/api/groups/wishes/list', { groupId:group.groupId }, guest.cookie)).data.wishes).toHaveLength(0);
    const departing = await api('/api/groups/wishes/create', wish, owner.cookie);
    await api('/api/groups/wishes/react', { groupId:group.groupId, wishId:departing.data.id }, guest.cookie);
    expect((await api('/api/groups/leave', { groupId:group.groupId }, owner.cookie)).status).toBe(409);
    expect((await api('/api/groups/wishes/list', { groupId:group.groupId }, guest.cookie)).data.wishes).toHaveLength(1);
  });

  it('notifies current group members on wish creation and alerts the owner once for each new reaction', async () => {
    const owner=await register('募集主');
    const guest=await register('行きたい人');
    const outsider=await register('別の人');
    const group=(await api('/api/groups/create',{name:'通知先検証'},owner.cookie)).data.membership;
    await api('/api/groups/join',{inviteCode:group.inviteCode},guest.cookie);
    const keys=await testKeys();
    const pushEnv:PushEnv={DB:env.DB,VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:'mailto:test@example.com'};
    const endpoints={owner:'https://fcm.googleapis.com/fcm/send/wish-owner',guest:'https://fcm.googleapis.com/fcm/send/wish-guest',outsider:'https://fcm.googleapis.com/fcm/send/wish-outsider'};
    for (const [name,user] of Object.entries({owner:owner.user,guest:guest.user,outsider:outsider.user})) {
      expect((await handlePushRequest(new Request('https://example.com/api/push/subscribe',{method:'POST',body:JSON.stringify({
        endpoint:endpoints[name as keyof typeof endpoints],p256dh:keys.p256dh,auth:keys.auth,
      })}),pushEnv,'/api/push/subscribe',user)).status).toBe(200);
    }
    const sends:string[]=[];
    let release!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    vi.stubGlobal('fetch',async(url:string)=>{sends.push(url);await gate;return new Response(null,{status:201});});
    const pending:Promise<unknown>[]=[];
    const ctx={waitUntil:(task:Promise<unknown>)=>{pending.push(task);}} as unknown as ExecutionContext;
    try {
      const body={groupId:group.groupId,wishDate:'2026-10-20',isAllDay:true,message:'PRIVATE_WISH_TEXT',clientRequestId:'wish-create-retry-token'};
      const created=await handleWishRequest(pushEnv,ctx,'/api/groups/wishes/create',body,owner.user);
      expect(created.status).toBe(201);
      const wishId=(await created.json() as any).id;
      await new Promise((resolve)=>setTimeout(resolve,0));
      const createdDeliveries=await env.DB.prepare('SELECT kind,scope,recipient_user_id,body FROM push_deliveries WHERE group_id=?1')
        .bind(group.groupId).all<any>();
      expect(createdDeliveries.results).toHaveLength(1);
      expect(createdDeliveries.results[0]).toMatchObject({kind:'wish_created',scope:'group',recipient_user_id:null});
      expect(createdDeliveries.results[0].body).not.toContain('PRIVATE_WISH_TEXT');

      const retry=await handleWishRequest(pushEnv,ctx,'/api/groups/wishes/create',body,owner.user);
      expect(retry.status).toBe(200);
      expect((await retry.json() as any).id).toBe(wishId);
      expect((await env.DB.prepare('SELECT id FROM group_availability_wishes WHERE client_request_id=?1').bind(body.clientRequestId).all()).results).toHaveLength(1);

      expect((await handleWishRequest(pushEnv,ctx,'/api/groups/wishes/react',{groupId:group.groupId,wishId},guest.user)).status).toBe(200);
      await new Promise((resolve)=>setTimeout(resolve,0));
      const reactionDelivery=await env.DB.prepare('SELECT kind,scope,recipient_user_id,body FROM push_deliveries WHERE group_id=?1 AND recipient_user_id IS NOT NULL')
        .bind(group.groupId).all<any>();
      expect(reactionDelivery.results).toHaveLength(1);
      expect(reactionDelivery.results[0]).toMatchObject({kind:'wish_interested',scope:'group',recipient_user_id:owner.user.id});
      expect(reactionDelivery.results[0].body).toContain('行きたい人');

		await env.DB.prepare('DELETE FROM shared_events WHERE wish_id=?1 AND status=\'tentative\'').bind(wishId).run();
		await handleWishRequest(pushEnv,ctx,'/api/groups/wishes/react',{groupId:group.groupId,wishId},guest.user);
      await new Promise((resolve)=>setTimeout(resolve,0));
      expect((await env.DB.prepare('SELECT id FROM push_deliveries WHERE recipient_user_id=?1 AND group_id=?2')
        .bind(owner.user.id,group.groupId).all()).results).toHaveLength(1);
		expect((await env.DB.prepare('SELECT id FROM shared_events WHERE wish_id=?1 AND status=\'tentative\'').bind(wishId).all()).results).toHaveLength(1);
      release();
      await Promise.all(pending);
      expect(sends.sort()).toEqual([endpoints.guest,endpoints.owner].sort());
      expect(sends).not.toContain(endpoints.outsider);
    } finally { release();vi.unstubAllGlobals(); }
  });

  it('shows distinct interested members and keeps a tentative event until explicit confirmation', async () => {
    const owner = await register('同じ名前');
    const guest = await register('同じ名前');
    const third = await register('3人目');
    const group = (await api('/api/groups/create', { name:'遊び仲間' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:group.inviteCode }, guest.cookie);
    await api('/api/groups/join', { inviteCode:group.inviteCode }, third.cookie);
    const created = await api('/api/groups/wishes/create', { groupId:group.groupId, wishDate:'2026-10-15', isAllDay:false,
      start:'15:00', end:'18:00', message:'ボウリング' }, owner.cookie);
    const wishId = created.data.id;
    const list = () => api('/api/groups/wishes/list', { groupId:group.groupId }, owner.cookie);
    expect((await list()).data.wishes[0]).toMatchObject({ participantCount:1, eventStatus:null });
    await api('/api/groups/wishes/react', { groupId:group.groupId, wishId }, guest.cookie);
    let wish = (await list()).data.wishes[0];
    expect(wish).toMatchObject({ participantCount:2, eventStatus:'tentative', participantsInsufficient:false });
    expect(wish.interestedUsers.map((person:any) => person.userId)).toEqual([owner.user.id, guest.user.id]);
    expect(wish.interestedUsers.map((person:any) => person.displayName)).toEqual(['同じ名前', '同じ名前']);
    await api('/api/groups/wishes/react', { groupId:group.groupId, wishId }, third.cookie);
    expect((await list()).data.wishes[0].participantCount).toBe(3);
    await api('/api/groups/wishes/unreact', { groupId:group.groupId, wishId }, guest.cookie);
    await api('/api/groups/wishes/unreact', { groupId:group.groupId, wishId }, third.cookie);
    wish = (await list()).data.wishes[0];
    expect(wish).toMatchObject({ participantCount:1, eventStatus:'tentative', participantsInsufficient:true });
    expect((await api('/api/groups/wishes/confirm', { groupId:group.groupId, wishId, title:'確定', eventDate:'2026-10-15',
      allDay:true, participantUserIds:[owner.user.id, guest.user.id] }, owner.cookie)).status).toBe(409);
    expect((await api('/api/shared/events/list', { groupId:group.groupId, month:'2026-10' }, owner.cookie)).data.events
      .find((event:any) => event.wishId === wishId).status).toBe('tentative');
    expect((await api('/api/groups/wishes/confirm', { groupId:group.groupId, wishId, title:'確定', eventDate:'2026-10-15',
      allDay:true, participantUserIds:[owner.user.id, guest.user.id] }, guest.cookie)).status).toBe(403);
    await api('/api/groups/wishes/react', { groupId:group.groupId, wishId }, guest.cookie);
    expect((await api('/api/groups/wishes/confirm', { groupId:group.groupId, wishId, title:'確定', eventDate:'2026-10-15',
      allDay:true, participantUserIds:[owner.user.id, guest.user.id] }, owner.cookie)).status).toBe(200);
    await api('/api/groups/wishes/unreact', { groupId:group.groupId, wishId }, guest.cookie);
    expect((await list()).data.wishes[0].eventStatus).toBe('confirmed');
  });

  it('redacts other-group events and computes busy/free without names or titles', async () => {
    const owner = await register('りく');
    const guest = await register('あ');
    const groupA = (await api('/api/groups/create', { name:'秘密のグループ' }, owner.cookie)).data.membership;
    const groupB = (await api('/api/groups/create', { name:'研究室' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:groupB.inviteCode }, guest.cookie);
    await api('/api/shared/events/create', { groupId:groupA.groupId, title:'秘密の焼肉', eventDate:'2026-10-16',
      start:'18:00', end:'20:00', allDay:false, note:'非公開メモ' }, owner.cookie);
    const response = await api('/api/shared/events/list', { groupId:groupB.groupId, month:'2026-10' }, guest.cookie);
    expect(response.data.events).toHaveLength(1);
    expect(response.data.events[0]).toMatchObject({ title:'予定あり', start:'18:00', end:'20:00', sourceType:'busy' });
    for (const secret of ['秘密の焼肉', '秘密のグループ', '非公開メモ', owner.user.id]) {
      expect(JSON.stringify(response.data)).not.toContain(secret);
    }
    const availability = await api('/api/shared/availability', { groupId:groupB.groupId, userId:owner.user.id, date:'2026-10-16' }, guest.cookie);
    expect(availability.data.busy).toEqual([{ start:'18:00', end:'20:00', label:'予定あり' }]);
    expect(availability.data.free).toEqual([{ start:'09:00', end:'18:00' }, { start:'20:00', end:'22:00' }]);
    expect(JSON.stringify(availability.data)).not.toContain('秘密');
    expect((await api('/api/shared/availability', { groupId:groupB.groupId, userId:guest.user.id, date:'2026-10-16' }, owner.cookie)).status).toBe(200);
    expect((await api('/api/shared/availability', { groupId:groupA.groupId, userId:guest.user.id, date:'2026-10-16' }, owner.cookie)).status).toBe(403);
  });

  it('does not expose a legacy R2 group image route', async () => {
    const owner = await register('icon-test');
    const response = await SELF.fetch('https://example.com/api/groups/image?groupId=anything', {
      method:'POST', headers:{ Origin:PUBLIC_APP_ORIGIN, Cookie:owner.cookie, 'Content-Type':'application/json' }, body:'{}',
    });
    expect(response.status).toBe(404);
  });
});

describe('profile and device notifications', () => {
  it('keeps a status for seven days from every edit, hides expired values, and clears on blank', async () => {
    const owner = await register('りく');
    const other = await register('あ');
    expect((await api('/api/profile/status', { statusMessage:'服を買いに行きたい' })).status).toBe(401);
    expect((await api('/api/profile/status', { statusMessage:'長'.repeat(51) }, owner.cookie)).status).toBe(400);
    const first = await api('/api/profile/status', { statusMessage:'服を買いに行きたい' }, owner.cookie);
    expect(first.status).toBe(200);
    expect(first.data.profile.statusMessage).toBe('服を買いに行きたい');
    expect(Date.parse(first.data.profile.statusExpiresAt) - Date.parse(first.data.profile.statusUpdatedAt)).toBe(7 * 86400_000);
    await env.DB.prepare('UPDATE users SET status_updated_at = ?1, status_expires_at = ?2 WHERE id = ?3')
      .bind('2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z', owner.user.id).run();
    const changed = await api('/api/profile/status', { statusMessage:'焼肉行きたい', userId:other.user.id }, owner.cookie);
    expect(changed.status).toBe(200);
    expect(changed.data.profile.statusMessage).toBe('焼肉行きたい');
    expect(Date.parse(changed.data.profile.statusExpiresAt)).toBeGreaterThan(Date.parse('2026-01-08T00:00:00.000Z'));
    expect(Date.parse(changed.data.profile.statusExpiresAt) - Date.parse(changed.data.profile.statusUpdatedAt)).toBe(7 * 86400_000);
    expect((await api('/api/profile', undefined, other.cookie)).data.profile.statusMessage).toBe('');
    await env.DB.prepare('UPDATE users SET status_expires_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), owner.user.id).run();
    const expired = (await api('/api/profile', undefined, owner.cookie)).data.profile;
    expect(expired.statusMessage).toBe('');
    expect(expired.statusExpiresAt).toBeNull();
    expect((await api('/api/profile/status', { statusMessage:'また更新' }, owner.cookie)).data.profile.statusMessage).toBe('また更新');
    const cleared = await api('/api/profile/status', { statusMessage:'   ' }, owner.cookie);
    expect(cleared.data.profile.statusMessage).toBe('');
    expect(cleared.data.profile.statusExpiresAt).toBeNull();
    const stored = await env.DB.prepare('SELECT status_message, status_expires_at FROM users WHERE id = ?1').bind(owner.user.id)
      .first<{ status_message:string; status_expires_at:string | null }>();
    expect(stored).toEqual({ status_message:'', status_expires_at:null });
  });

  it('shows active statuses only to fellow members in every shared group', async () => {
    const owner = await register('りく');
    const guest = await register('あ');
    const outsider = await register('部外者');
    const firstGroup = (await api('/api/groups/create', { name:'サークル' }, owner.cookie)).data.membership;
    const secondGroup = (await api('/api/groups/create', { name:'研究室' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:firstGroup.inviteCode }, guest.cookie);
    await api('/api/groups/join', { inviteCode:secondGroup.inviteCode }, guest.cookie);
    await api('/api/profile/status', { statusMessage:'ボウリングに行きたい' }, owner.cookie);
    for (const group of [firstGroup, secondGroup]) {
      const list = await api('/api/groups/members/list', { groupId:group.groupId }, guest.cookie);
      expect(list.status).toBe(200);
      expect(list.data.members.find((item:any) => item.userId === owner.user.id)).toMatchObject({
        memberName:'りく', profileIcon:'🌿', statusMessage:'ボウリングに行きたい',
      });
      expect((await api('/api/groups/members/list', { groupId:group.groupId }, outsider.cookie)).status).toBe(401);
    }
    await env.DB.prepare('UPDATE users SET status_expires_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), owner.user.id).run();
    const expired = await api('/api/groups/members/list', { groupId:firstGroup.groupId }, guest.cookie);
    expect(expired.data.members.find((item:any) => item.userId === owner.user.id).statusMessage).toBe('');
  });

  it('edits only the signed-in profile with a 50-character bio limit', async () => {
    const first = await register('最初の名前');
    const second = await register('別ユーザー');
    expect((await api('/api/profile')).status).toBe(401);
    const initial = await api('/api/profile', undefined, first.cookie);
    expect(initial.data.profile.displayName).toBe('最初の名前');
    expect(initial.data.profile.profileIcon).toBe('🌿');
    const changed = await api('/api/profile/update', { displayName:'更新した名前', profileIcon:'🌸', bio:'今月もがんばる' }, first.cookie);
    expect(changed.status).toBe(200);
    expect(changed.data.profile.bio).toBe('今月もがんばる');
    const iconOnly = await api('/api/profile/update', { displayName:'更新した名前', profileIcon:'🌿' }, first.cookie);
    expect(iconOnly.data.profile.bio).toBe('今月もがんばる');
    expect(iconOnly.data.profile.statusMessage).toBe('');
    expect((await api('/api/auth/me', undefined, first.cookie)).data.user.displayName).toBe('更新した名前');
    expect((await api('/api/profile', undefined, second.cookie)).data.profile.displayName).toBe('別ユーザー');
    expect((await api('/api/profile/update', { displayName:'x', profileIcon:'🌿', bio:'長'.repeat(51) }, first.cookie)).status).toBe(400);
  });

  it('keeps multiple devices and prevents another user from claiming or deleting one', async () => {
    const first = await register();
    const second = await register();
    const keys = await testKeys();
    const pushEnv: PushEnv = { DB:env.DB, VAPID_PUBLIC_KEY:keys.publicKey, VAPID_PRIVATE_KEY:keys.privateKey, VAPID_SUBJECT:'mailto:test@example.com' };
    const userOne = first.user;
    const userTwo = second.user;
    const request = (path:string, endpoint:string, keyUser = userOne) => handlePushRequest(new Request(`https://example.com${path}`, {
      method:'POST', body:JSON.stringify({ endpoint, p256dh:keys.p256dh, auth:keys.auth }),
    }), pushEnv, path, keyUser);
    const a = 'https://fcm.googleapis.com/fcm/send/device-a';
    const b = 'https://fcm.googleapis.com/fcm/send/device-b';
    expect((await request('/api/push/subscribe', a)).status).toBe(200);
    expect((await request('/api/push/subscribe', b)).status).toBe(200);
    expect((await request('/api/push/subscribe', a, userTwo)).status).toBe(409);
    expect((await request('/api/push/unsubscribe', a, userTwo)).status).toBe(200);
    expect((await request('/api/push/status', a, userOne)).status).toBe(200);
    expect((await (await request('/api/push/status', a, userOne)).json() as any).enabled).toBe(true);
    expect((await (await request('/api/push/status', a, userTwo)).json() as any).enabled).toBe(false);
    expect((await api('/api/push/status', { endpoint:a })).status).toBe(401);
    const logout = await api('/api/auth/logout', { endpoint:a }, first.cookie);
    expect(logout.status).toBe(200);
    const remaining = await env.DB.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?1').bind(userOne.id).all<{ endpoint:string }>();
    expect(remaining.results.map((row) => row.endpoint)).toEqual([b]);
    expect((await request('/api/push/subscribe', 'http://127.0.0.1/private')).status).toBe(400);
  });

  it('encrypts and sends group notifications only to other members with subscriptions', async () => {
    const owner = await register('作成者');
    const guest = await register('参加者');
    const group = (await api('/api/groups/create', { name:'サークル' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:group.inviteCode }, guest.cookie);
    const keys = await testKeys();
    const pushEnv: PushEnv = { DB:env.DB, VAPID_PUBLIC_KEY:keys.publicKey, VAPID_PRIVATE_KEY:keys.privateKey, VAPID_SUBJECT:'mailto:test@example.com' };
    const endpoint = 'https://fcm.googleapis.com/fcm/send/guest';
    const subscribed = await handlePushRequest(new Request('https://example.com/api/push/subscribe', { method:'POST', body:JSON.stringify({ endpoint, p256dh:keys.p256dh, auth:keys.auth }) }), pushEnv, '/api/push/subscribe', guest.user);
    expect(subscribed.status).toBe(200);
    const sends: { url:string; request:RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url:string, request:RequestInit) => {
      sends.push({ url, request });
      return new Response(null, { status:201 });
    });
    try {
      await notifyGroup(pushEnv, group.groupId, owner.user.id, { kind:'group_event_created', body:'「サークル」に新しい予定が追加されました' });
      expect(sends).toHaveLength(1);
      expect(sends[0].url).toBe(endpoint);
      expect(sends[0].request.redirect).toBe('manual');
      expect((sends[0].request.headers as Record<string,string>).Authorization).toMatch(/^vapid t=/);
      const authorization = (sends[0].request.headers as Record<string,string>).Authorization;
      const token = authorization.match(/^vapid t=([^,]+), k=(.+)$/);
      expect(token).not.toBeNull();
      expect(token![2]).toBe(keys.publicKey);
      const [header, claims, signature] = token![1].split('.');
      const decodeToken = (value:string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));
      expect(JSON.parse(new TextDecoder().decode(decodeToken(claims))).aud).toBe('https://fcm.googleapis.com');
      const vapidPublic = await crypto.subtle.importKey('raw', decodeToken(keys.publicKey), {name:'ECDSA', namedCurve:'P-256'}, false, ['verify']);
      expect(await crypto.subtle.verify({name:'ECDSA', hash:'SHA-256'}, vapidPublic,
        decodeToken(signature), new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
      expect((sends[0].request.headers as Record<string,string>).TTL).toBe('3600');
      expect((sends[0].request.headers as Record<string,string>)['Content-Encoding']).toBe('aes128gcm');
      expect((sends[0].request.body as Uint8Array).length).toBeGreaterThan(100);
      const encrypted = sends[0].request.body as Uint8Array;
      const senderPublic = await crypto.subtle.importKey('raw', encrypted.slice(21, 86), { name:'ECDH', namedCurve:'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name:'ECDH', public:senderPublic } as unknown as SubtleCryptoDeriveKeyAlgorithm, keys.receiver.privateKey, 256));
      const receiverRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.receiver.publicKey) as ArrayBuffer);
      const decode = (value:string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));
      const derive = async (ikm:Uint8Array, salt:Uint8Array, info:Uint8Array, length:number) => {
        const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
        return new Uint8Array(await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info }, key, length));
      };
      const encoded = new TextEncoder();
      const ikm = await derive(shared, decode(keys.auth), new Uint8Array([...encoded.encode('WebPush: info'), 0, ...receiverRaw, ...encrypted.slice(21, 86)]), 256);
      const contentKey = await derive(ikm, encrypted.slice(0, 16), new Uint8Array([...encoded.encode('Content-Encoding: aes128gcm'), 0]), 128);
      const nonce = await derive(ikm, encrypted.slice(0, 16), new Uint8Array([...encoded.encode('Content-Encoding: nonce'), 0]), 96);
      const aes = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['decrypt']);
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv:nonce }, aes, encrypted.slice(86)));
      expect(plaintext.at(-1)).toBe(2);
      expect(JSON.parse(new TextDecoder().decode(plaintext.slice(0, -1))).url).toBe(`${PUBLIC_APP_ORIGIN}/?group=${group.groupId}`);
      await notifyGroup(pushEnv, group.groupId, guest.user.id, { kind:'group_event_updated', body:'変更' });
      expect(sends).toHaveLength(1);
      const payload = await encryptPushPayload(keys.p256dh, keys.auth, JSON.stringify({ title:'DaySync', url:'/?group=x' }));
      expect(payload[20]).toBe(65);
    } finally { vi.unstubAllGlobals(); }
  });

  it('notifies on a new shared entry and change, but not on an unchanged sync', async () => {
    const owner = await register('作成者');
    const guest = await register('参加者');
    const group = (await api('/api/groups/create', { name:'研究室' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:group.inviteCode }, guest.cookie);
    const keys = await testKeys();
    const pushEnv: PushEnv = { DB:env.DB, VAPID_PUBLIC_KEY:keys.publicKey, VAPID_PRIVATE_KEY:keys.privateKey, VAPID_SUBJECT:'mailto:test@example.com' };
    await handlePushRequest(new Request('https://example.com/api/push/subscribe', { method:'POST', body:JSON.stringify({ endpoint:'https://fcm.googleapis.com/fcm/send/guest-event', p256dh:keys.p256dh, auth:keys.auth }) }), pushEnv, '/api/push/subscribe', guest.user);
    const sends: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url:string, request:RequestInit) => { sends.push(request); return new Response(null, { status:201 }); });
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil:(task:Promise<unknown>) => { pending.push(task); } } as unknown as ExecutionContext;
    const sync = async (title:string) => {
      const response = await handleSharedRequest(new Request('https://example.com/api/shared/calendar/sync', { method:'POST', body:JSON.stringify({
        groupId:group.groupId, month:'2026-10', entries:[{ sourceType:'shift', sourceId:'shift-note', eventDate:'2026-10-04', title, allDay:true, note:'' }],
      }) }), pushEnv, ctx, '/api/shared/calendar/sync', owner.user);
      expect(response.status).toBe(200);
      await Promise.all(pending.splice(0));
    };
    try {
      await sync('新しい予定');
      expect(sends).toHaveLength(1);
      await sync('新しい予定');
      expect(sends).toHaveLength(1);
      await sync('変更した予定');
      expect(sends).toHaveLength(2);
      const created = await handleSharedRequest(new Request('https://example.com/api/shared/events/create', { method:'POST', body:JSON.stringify({ groupId:group.groupId, title:'会議', eventDate:'2026-10-05', allDay:true, note:'' }) }), pushEnv, ctx, '/api/shared/events/create', owner.user);
      expect(created.status).toBe(201);
      await Promise.all(pending.splice(0));
      expect(sends).toHaveLength(3);
    } finally { vi.unstubAllGlobals(); }
  });

  it('ignores personal-only legacy syncs in every group without changing rows or notifying', async () => {
    const owner = await register();
    const guest = await register();
    const firstGroup = (await api('/api/groups/create', { name:'personal mirror guard A' }, owner.cookie)).data.membership;
    const secondGroup = (await api('/api/groups/create', { name:'personal mirror guard B' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:firstGroup.inviteCode }, guest.cookie);

    const seedMemberRows = async (group:typeof firstGroup, suffix:string) => {
      await env.DB.prepare(`INSERT INTO member_calendar_entries
        (group_id,member_id,source_type,source_id,event_date,title,starts_at,ends_at,all_day,note)
        VALUES (?1,?2,'personal',?3,'2026-10-04',?4,'12:00','13:00',0,?5),
               (?1,?2,'shift',?6,'2026-10-04',?7,'09:00','10:00',0,'')`)
        .bind(group.groupId,group.memberId,`legacy-personal-${suffix}`,`legacy title ${suffix}`,`legacy note ${suffix}`,
          `keep-shift-${suffix}`,`existing shift ${suffix}`).run();
    };
    const readMemberRows = async (group:typeof firstGroup) => (await env.DB.prepare(`SELECT source_type,source_id,event_date,title,starts_at,ends_at,all_day,note
      FROM member_calendar_entries WHERE group_id=?1 AND member_id=?2 ORDER BY source_type,source_id`)
      .bind(group.groupId,group.memberId).all()).results;
    await seedMemberRows(firstGroup,'a');
    await seedMemberRows(secondGroup,'b');
    const beforeFirst = await readMemberRows(firstGroup);
    const beforeSecond = await readMemberRows(secondGroup);

    const keys = await testKeys();
    const pushEnv:PushEnv = { DB:env.DB, VAPID_PUBLIC_KEY:keys.publicKey, VAPID_PRIVATE_KEY:keys.privateKey, VAPID_SUBJECT:'mailto:test@example.com' };
    expect((await handlePushRequest(new Request('https://example.com/api/push/subscribe', { method:'POST', body:JSON.stringify({
      endpoint:'https://fcm.googleapis.com/fcm/send/personal-mirror-guard', p256dh:keys.p256dh, auth:keys.auth,
    }) }), pushEnv, '/api/push/subscribe', guest.user)).status).toBe(200);

    const sends:RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url:string, request:RequestInit) => { sends.push(request); return new Response(null, { status:201 }); });
    const pending:Promise<unknown>[] = [];
    const ctx = { waitUntil:(task:Promise<unknown>) => { pending.push(task); } } as unknown as ExecutionContext;
    const sync = async (groupId:string, entries:unknown[], flags:Record<string,unknown> = {}) => {
      const response = await handleSharedRequest(new Request('https://example.com/api/shared/calendar/sync', { method:'POST', body:JSON.stringify({
        groupId, month:'2026-10', entries, ...flags,
      }) }), pushEnv, ctx, '/api/shared/calendar/sync', owner.user);
      const data = await response.json() as Record<string,unknown>;
      await Promise.all(pending.splice(0));
      return { status:response.status, data };
    };
    const oldPersonal = {
      sourceType:'personal', sourceId:'legacy-personal-a', eventDate:'2026-10-04',
      title:'PRIVATE_OLD_PERSONAL_TITLE', start:'17:00', end:'18:00', allDay:false, note:'PRIVATE_OLD_PERSONAL_NOTE',
    };
    const newShift = {
      sourceType:'shift', sourceId:'new-shift-a', eventDate:'2026-10-04',
      title:'シフト', start:'14:00', end:'16:00', allDay:false, note:'',
    };

    try {
      // Unflagged legacy requests and retries contain no shift snapshot; personal details
      // therefore cannot update/delete either existing row or enqueue a group notice.
      for (let retry=0; retry<2; retry+=1) {
        expect(await sync(firstGroup.groupId,[oldPersonal])).toEqual({ status:200, data:{ ok:true, count:0 } });
      }
      // Even an explicit shift flag cannot turn a personal-only request into an empty snapshot.
      expect(await sync(secondGroup.groupId,[{ ...oldPersonal, sourceId:'legacy-personal-b' }], { syncPersonal:true, syncShifts:true })).toEqual({
        status:200, data:{ ok:true, count:0 },
      });
      expect(await readMemberRows(firstGroup)).toEqual(beforeFirst);
      expect(await readMemberRows(secondGroup)).toEqual(beforeSecond);
      expect(sends).toHaveLength(0);
      expect((await env.DB.prepare('SELECT id FROM push_deliveries WHERE group_id=?1').bind(firstGroup.groupId).all()).results).toHaveLength(0);

      // A legacy mixed payload still syncs the exact shift entry, but leaves the older
      // personal mirror byte-for-byte intact and the personal fields do not affect retries.
      expect((await sync(firstGroup.groupId,[oldPersonal,newShift])).data).toEqual({ ok:true, count:1 });
      const afterMixed = await readMemberRows(firstGroup);
      expect(afterMixed).toHaveLength(2);
      expect(afterMixed).toContainEqual(expect.objectContaining({
        source_type:'personal', source_id:'legacy-personal-a', title:'legacy title a', note:'legacy note a',
      }));
      expect(afterMixed).toContainEqual(expect.objectContaining({
        source_type:'shift', source_id:'new-shift-a', title:'シフト', starts_at:'14:00', ends_at:'16:00',
      }));
      expect(sends).toHaveLength(1);
      expect((await sync(firstGroup.groupId,[oldPersonal,newShift])).data).toEqual({ ok:true, count:1 });
      expect(sends).toHaveLength(1);

      expect((await api('/api/personal/events/activate', { freshStart:true }, owner.cookie)).status).toBe(200);
      expect(await sync(firstGroup.groupId,[oldPersonal],{ syncPersonal:false })).toEqual({ status:200, data:{ ok:true, count:0 } });
      expect(await readMemberRows(firstGroup)).toEqual(afterMixed);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM personal_events WHERE user_id=?1').bind(owner.user.id).first<any>())?.count).toBe(0);
      expect(sends).toHaveLength(1);

      // Missing and unknown source types are rejected (even with syncing disabled) rather
      // than being inferred as shifts from their fields.
      for (const invalidEntry of [
        { sourceId:'missing-source-type', eventDate:'2026-10-04', title:'シフト', start:'18:00', end:'19:00', allDay:false, note:'' },
        { sourceType:'other', sourceId:'invalid-source-type', eventDate:'2026-10-04', title:'シフト', start:'18:00', end:'19:00', allDay:false, note:'' },
      ]) {
        expect((await sync(firstGroup.groupId,[invalidEntry],{ syncShifts:false })).status).toBe(400);
      }
      expect(await readMemberRows(firstGroup)).toEqual(afterMixed);
      expect(sends).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps deliveries beyond the immediate free-tier batch until the next drain', async () => {
    const owner = await register();
    const guest = await register();
    const group = (await api('/api/groups/create', { name:'大きなグループ' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:group.inviteCode }, guest.cookie);
    const keys = await testKeys();
    const pushEnv: PushEnv = { DB:env.DB, VAPID_PUBLIC_KEY:keys.publicKey, VAPID_PRIVATE_KEY:keys.privateKey, VAPID_SUBJECT:'mailto:test@example.com' };
    for (let index = 0; index < 10; index += 1) {
      const endpoint = `https://fcm.googleapis.com/fcm/send/multi-${index}`;
      expect((await handlePushRequest(new Request('https://example.com/api/push/subscribe', { method:'POST', body:JSON.stringify({ endpoint, p256dh:keys.p256dh, auth:keys.auth }) }), pushEnv, '/api/push/subscribe', guest.user)).status).toBe(200);
    }
    let deliveries = 0;
    vi.stubGlobal('fetch', async () => { deliveries += 1; return new Response(null, { status:201 }); });
    try {
      await notifyGroup(pushEnv, group.groupId, owner.user.id, { kind:'group_event_created', body:'新しい予定' });
      expect(deliveries).toBe(8);
      const queued = await env.DB.prepare('SELECT id FROM push_deliveries WHERE group_id = ?1').bind(group.groupId).all();
      expect(queued.results).toHaveLength(2);
      await drainPushQueue(pushEnv);
      expect(deliveries).toBe(10);
      expect((await env.DB.prepare('SELECT id FROM push_deliveries WHERE group_id = ?1').bind(group.groupId).all()).results).toHaveLength(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it('Cron resumes a queued Push delivery after a transient failure', async () => {
    const owner = await register();
    const guest = await register();
    const group = (await api('/api/groups/create', { name:'scheduled push retry' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:group.inviteCode }, guest.cookie);
    const keys = await testKeys();
    const pushEnv:PushEnv = { DB:env.DB, VAPID_PUBLIC_KEY:keys.publicKey, VAPID_PRIVATE_KEY:keys.privateKey, VAPID_SUBJECT:'mailto:test@example.com' };
    expect((await handlePushRequest(new Request('https://example.com/api/push/subscribe', { method:'POST', body:JSON.stringify({
      endpoint:'https://fcm.googleapis.com/fcm/send/scheduled-retry', p256dh:keys.p256dh, auth:keys.auth,
    }) }), pushEnv, '/api/push/subscribe', guest.user)).status).toBe(200);
    await queueGroupNotice(pushEnv, group.groupId, owner.user.id, { kind:'group_event_created', body:'共有予定' });

    let sends = 0;
    vi.stubGlobal('fetch', async () => {
      sends += 1;
      return new Response(null, { status:sends === 1 ? 503 : 201 });
    });
    try {
      await drainPushQueue(pushEnv);
      expect(sends).toBe(1);
      const retry = await env.DB.prepare('SELECT attempts FROM push_deliveries WHERE group_id=?1')
        .bind(group.groupId).first<{attempts:number}>();
      expect(retry?.attempts).toBe(1);

      // Advance the retry time in the isolated test D1 so the scheduled handler
      // can exercise the same due-delivery path without waiting for wall-clock backoff.
      await env.DB.prepare('UPDATE push_deliveries SET next_attempt_at=?1 WHERE group_id=?2')
        .bind('2000-01-01T00:00:00.000Z', group.groupId).run();
      const pending:Promise<unknown>[] = [];
      const ctx = { waitUntil:(task:Promise<unknown>) => { pending.push(task); } } as unknown as ExecutionContext;
      await worker.scheduled({ cron:'* * * * *' } as ScheduledController, pushEnv, ctx);
      await Promise.all(pending);

      expect(sends).toBe(2);
      expect((await env.DB.prepare('SELECT id FROM push_deliveries WHERE group_id=?1').bind(group.groupId).all()).results).toHaveLength(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it('removes an expired Push subscription after the provider returns 410', async () => {
    const owner=await register();
    const guest=await register();
    const group=(await api('/api/groups/create',{name:'期限切れ購読'},owner.cookie)).data.membership;
    await api('/api/groups/join',{inviteCode:group.inviteCode},guest.cookie);
    const keys=await testKeys();
    const pushEnv:PushEnv={DB:env.DB,VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:'mailto:test@example.com'};
    const endpoint='https://fcm.googleapis.com/fcm/send/expired-subscription';
    expect((await handlePushRequest(new Request('https://example.com/api/push/subscribe',{method:'POST',body:JSON.stringify({
      endpoint,p256dh:keys.p256dh,auth:keys.auth,
    })}),pushEnv,'/api/push/subscribe',guest.user)).status).toBe(200);
    await queueGroupNotice(pushEnv,group.groupId,owner.user.id,{kind:'group_event_created',body:'共有予定'});
    vi.stubGlobal('fetch',async()=>new Response(null,{status:410}));
    try { await drainPushQueue(pushEnv); } finally { vi.unstubAllGlobals(); }
    expect((await env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint=?1').bind(endpoint).all()).results).toHaveLength(0);
    expect((await env.DB.prepare('SELECT id FROM push_deliveries WHERE group_id=?1').bind(group.groupId).all()).results).toHaveLength(0);
  });

  it('classifies an Apple rejection without logging endpoints or keys', async () => {
    const owner = await register();
    const guest = await register();
    const group = (await api('/api/groups/create', { name:'Apple delivery diagnosis' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:group.inviteCode }, guest.cookie);
    const keys = await testKeys();
    const pushEnv:PushEnv = { DB:env.DB, VAPID_PUBLIC_KEY:keys.publicKey,
      VAPID_PRIVATE_KEY:keys.privateKey, VAPID_SUBJECT:'mailto:test@example.com' };
    const endpoint = 'https://web.push.apple.com/private-token';
    expect((await handlePushRequest(new Request('https://example.com/api/push/subscribe', { method:'POST', body:JSON.stringify({
      endpoint, p256dh:keys.p256dh, auth:keys.auth,
    }) }), pushEnv, '/api/push/subscribe', guest.user)).status).toBe(200);
    await queueGroupNotice(pushEnv, group.groupId, owner.user.id, { kind:'group_event_created', body:'共有予定' });
    const warnings:unknown[][] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...values:unknown[]) => { warnings.push(values); });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ reason:'VapidPkHashMismatch', endpoint }), {
      status:403, headers:{ 'Content-Type':'application/json' },
    }));
    try { await drainPushQueue(pushEnv); }
    finally { vi.unstubAllGlobals(); warn.mockRestore(); }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(['Push delivery attempt failed', {
      provider:'apple', status:403, reason:'VapidPkHashMismatch', attempt:1,
    }]);
    const rendered = JSON.stringify(warnings);
    expect(rendered).not.toContain(endpoint);
    expect(rendered).not.toContain(keys.p256dh);
    expect(rendered).not.toContain(keys.auth);
    expect((await env.DB.prepare('SELECT attempts FROM push_deliveries WHERE group_id=?1')
      .bind(group.groupId).first<{attempts:number}>())?.attempts).toBe(1);
  });

  it('does not treat a redirected Push endpoint as a successful delivery', async () => {
    const owner = await register();
    const guest = await register();
    const group = (await api('/api/groups/create', { name:'Push redirect diagnosis' }, owner.cookie)).data.membership;
    await api('/api/groups/join', { inviteCode:group.inviteCode }, guest.cookie);
    const keys = await testKeys();
    const pushEnv:PushEnv = { DB:env.DB, VAPID_PUBLIC_KEY:keys.publicKey,
      VAPID_PRIVATE_KEY:keys.privateKey, VAPID_SUBJECT:'mailto:test@example.com' };
    const endpoint = 'https://web.push.apple.com/redirect-test';
    expect((await handlePushRequest(new Request('https://example.com/api/push/subscribe', { method:'POST', body:JSON.stringify({
      endpoint, p256dh:keys.p256dh, auth:keys.auth,
    }) }), pushEnv, '/api/push/subscribe', guest.user)).status).toBe(200);
    await queueGroupNotice(pushEnv, group.groupId, owner.user.id, { kind:'group_event_created', body:'共有予定' });
    let redirectMode = '';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', async (_url:string, request:RequestInit) => {
      redirectMode = request.redirect || '';
      return new Response(null, { status:302, headers:{ Location:'https://other.example/' } });
    });
    try { await drainPushQueue(pushEnv); }
    finally { vi.unstubAllGlobals(); warn.mockRestore(); }
    expect(redirectMode).toBe('manual');
    expect((await env.DB.prepare('SELECT attempts FROM push_deliveries WHERE group_id=?1')
      .bind(group.groupId).first<{attempts:number}>())?.attempts).toBe(1);
  });

  it('schedules personal reminders only to that user, recalculates on edit, and cancels on delete', async () => {
    const owner=await register('個人予定の本人');
    const other=await register('別ユーザー');
    expect((await api('/api/personal/events/activate',{freshStart:true},owner.cookie)).status).toBe(200);
    const keys=await testKeys();
    const pushEnv:PushEnv={DB:env.DB,VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:'mailto:test@example.com'};
    const subscribe=async(user:typeof owner.user,endpoint:string)=>handlePushRequest(new Request('https://example.com/api/push/subscribe',{
      method:'POST',body:JSON.stringify({endpoint,p256dh:keys.p256dh,auth:keys.auth}),
    }),pushEnv,'/api/push/subscribe',user);
    const ownerEndpoint='https://fcm.googleapis.com/fcm/send/personal-reminder-owner';
    const otherEndpoint='https://fcm.googleapis.com/fcm/send/personal-reminder-other';
    expect((await subscribe(owner.user,ownerEndpoint)).status).toBe(200);
    expect((await subscribe(other.user,otherEndpoint)).status).toBe(200);
    const eventDate=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
    const nextEventDate=new Date(Date.now()+8*86400000).toISOString().slice(0,10);
    const event={date:eventDate,title:'PRIVATE_PERSONAL_TITLE',start:'10:00',end:'11:00',allDay:false,note:'PRIVATE_PERSONAL_NOTE',
      extra:{daySyncReminders:{offsetMinutes:[10,45,1440],timeZone:'Asia/Tokyo'}}};
    const created=await api('/api/personal/events/create',{syncProtocol:2,id:'reminder-personal',operationId:'personal-reminder-create',event},owner.cookie);
    expect(created.status).toBe(200);
    let rows=await env.DB.prepare(`SELECT id,scope,user_id,group_id,offset_minutes,time_zone,event_start_at,due_at,queued_at,generation
      FROM event_reminders WHERE user_id=?1 AND personal_event_id=?2 ORDER BY offset_minutes`).bind(owner.user.id,'reminder-personal').all<any>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results[0]).toMatchObject({scope:'personal',group_id:null,time_zone:'Asia/Tokyo',event_start_at:eventDate+'T01:00:00.000Z'});
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM event_reminders WHERE user_id=?1 AND scope=\'shared\'').bind(other.user.id).first<any>())?.n).toBe(0);

    await env.DB.prepare('UPDATE event_reminders SET due_at=?1 WHERE user_id=?2 AND personal_event_id=?3')
      .bind('2000-01-01T00:00:00.000Z',owner.user.id,'reminder-personal').run();
    await drainReminderQueue(pushEnv);
    let pending=await env.DB.prepare(`SELECT d.kind,d.scope,d.group_id,d.recipient_user_id,d.body,d.target_path,s.endpoint,r.event_start_at
      FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id
      JOIN event_reminders r ON r.id=d.reminder_id WHERE d.reminder_id IN (SELECT id FROM event_reminders WHERE personal_event_id=?1)`)
      .bind('reminder-personal').all<any>();
    expect(pending.results).toHaveLength(3);
    expect(pending.results.every((row:any)=>row.scope==='personal'&&row.group_id===''&&row.recipient_user_id===owner.user.id&&row.endpoint===ownerEndpoint)).toBe(true);
    expect(pending.results.every((row:any)=>row.body==='予定の開始時刻が近づいています'&&!row.body.includes('PRIVATE_PERSONAL'))).toBe(true);
    expect(pending.results[0].target_path).toContain('eventId=reminder-personal');
    await drainReminderQueue(pushEnv);
    expect((await env.DB.prepare('SELECT id FROM push_deliveries WHERE reminder_id IS NOT NULL').all()).results).toHaveLength(3);

    const sent:Array<{url:string;request:RequestInit}>=[];
    vi.stubGlobal('fetch',async(url:string,request:RequestInit)=>{sent.push({url,request});return new Response(null,{status:201});});
    try { await drainPushQueue(pushEnv); } finally { vi.unstubAllGlobals(); }
    expect(sent.map((item)=>item.url)).toEqual([ownerEndpoint,ownerEndpoint,ownerEndpoint]);
    expect(sent.every((item)=>(item.request.headers as Record<string,string>).Urgency==='high')).toBe(true);

    const updatedEvent={...event,date:nextEventDate,title:'PRIVATE_PERSONAL_TITLE_CHANGED'};
    expect((await api('/api/personal/events/update',{syncProtocol:2,id:'reminder-personal',operationId:'personal-reminder-update',version:1,event:updatedEvent},owner.cookie)).status).toBe(200);
    rows=await env.DB.prepare('SELECT event_start_at,due_at,generation,queued_at FROM event_reminders WHERE user_id=?1 AND personal_event_id=?2 ORDER BY offset_minutes')
      .bind(owner.user.id,'reminder-personal').all<any>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results[0].event_start_at).toBe(nextEventDate+'T01:00:00.000Z');
    expect(rows.results.every((row:any)=>row.generation===2&&row.queued_at===null)).toBe(true);
    await env.DB.prepare('UPDATE event_reminders SET due_at=?1 WHERE personal_event_id=?2').bind('2000-01-01T00:00:00.000Z','reminder-personal').run();
    const cronSends:string[]=[];
    vi.stubGlobal('fetch',async(url:string)=>{cronSends.push(url);return new Response(null,{status:201});});
    try {
      const cronTasks:Promise<unknown>[]=[];
      await worker.scheduled({cron:'* * * * *'} as ScheduledController,pushEnv,{waitUntil:(task:Promise<unknown>)=>{cronTasks.push(task);}} as unknown as ExecutionContext);
      await Promise.all(cronTasks);
    } finally { vi.unstubAllGlobals(); }
    expect(cronSends).toEqual([ownerEndpoint,ownerEndpoint,ownerEndpoint]);
    expect((await env.DB.prepare('SELECT id FROM push_deliveries WHERE reminder_id IS NOT NULL').all()).results).toHaveLength(0);
    expect((await api('/api/personal/events/update',{syncProtocol:2,id:'reminder-personal',operationId:'personal-reminder-update',version:1,event:updatedEvent},owner.cookie)).status).toBe(200);
    expect((await env.DB.prepare('SELECT generation FROM event_reminders WHERE personal_event_id=?1').bind('reminder-personal').all<any>()).results.every((row:any)=>row.generation===2)).toBe(true);

    expect((await api('/api/personal/events/delete',{syncProtocol:2,id:'reminder-personal',operationId:'personal-reminder-delete',version:2},owner.cookie)).status).toBe(200);
    expect((await env.DB.prepare('SELECT id FROM event_reminders WHERE user_id=?1 AND personal_event_id=?2').bind(owner.user.id,'reminder-personal').all()).results).toHaveLength(0);
    expect((await env.DB.prepare('SELECT id FROM push_deliveries WHERE reminder_id IS NOT NULL').all()).results).toHaveLength(0);

    const past={...event,date:'2026-10-01'};
    expect((await api('/api/personal/events/create',{syncProtocol:2,id:'reminder-past',operationId:'personal-reminder-past',event:past},owner.cookie)).status).toBe(200);
    await drainReminderQueue(pushEnv);
    expect((await env.DB.prepare('SELECT id FROM push_deliveries WHERE reminder_id IN (SELECT id FROM event_reminders WHERE personal_event_id=\'reminder-past\')').all()).results).toHaveLength(0);
  });

  it('keeps shared reminders private, rejects tentative wishes, and only delivers to the saved member', async () => {
    const owner=await register('共有予定の作成者');
    const guest=await register('通知を受ける人');
    const outsider=await register('対象外');
    const group=(await api('/api/groups/create',{name:'共有リマインド検証'},owner.cookie)).data.membership;
    await api('/api/groups/join',{inviteCode:group.inviteCode},guest.cookie);
    const keys=await testKeys();
    const pushEnv:PushEnv={DB:env.DB,VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:'mailto:test@example.com'};
    const endpoints={owner:'https://fcm.googleapis.com/fcm/send/shared-reminder-owner',guest:'https://fcm.googleapis.com/fcm/send/shared-reminder-guest',outsider:'https://fcm.googleapis.com/fcm/send/shared-reminder-outsider'};
    for (const [name,user] of Object.entries({owner:owner.user,guest:guest.user,outsider:outsider.user})) {
      expect((await handlePushRequest(new Request('https://example.com/api/push/subscribe',{method:'POST',body:JSON.stringify({
        endpoint:endpoints[name as keyof typeof endpoints],p256dh:keys.p256dh,auth:keys.auth,
      })}),pushEnv,'/api/push/subscribe',user)).status).toBe(200);
    }
    const event=(await api('/api/shared/events/create',{groupId:group.groupId,title:'PRIVATE_SHARED_TITLE',eventDate:'2030-10-20',start:'13:00',end:'14:00',allDay:false,note:'PRIVATE_SHARED_NOTE'},owner.cookie)).data;
    const set=await api('/api/reminders/shared/set',{groupId:group.groupId,eventId:event.id,offsetMinutes:[10,1440],timeZone:'Asia/Tokyo'},guest.cookie);
    expect(set.status).toBe(200);
    expect((await api('/api/reminders/shared/get',{groupId:group.groupId,eventId:event.id},owner.cookie)).data.offsetMinutes).toEqual([]);
    expect((await api('/api/reminders/shared/get',{groupId:group.groupId,eventId:event.id},outsider.cookie)).status).toBe(404);
    expect((await env.DB.prepare('SELECT user_id,scope,group_id,offset_minutes FROM event_reminders WHERE shared_event_id=?1 ORDER BY offset_minutes')
      .bind(event.id).all<any>()).results).toEqual([
        {user_id:guest.user.id,scope:'shared',group_id:group.groupId,offset_minutes:10},
        {user_id:guest.user.id,scope:'shared',group_id:group.groupId,offset_minutes:1440},
      ]);
    await env.DB.prepare('UPDATE event_reminders SET due_at=?1 WHERE shared_event_id=?2').bind('2000-01-01T00:00:00.000Z',event.id).run();
    await drainReminderQueue(pushEnv);
    const queued=await env.DB.prepare(`SELECT d.kind,d.scope,d.recipient_user_id,d.body,d.target_path,s.endpoint
      FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE d.reminder_id IN
      (SELECT id FROM event_reminders WHERE shared_event_id=?1)`).bind(event.id).all<any>();
    expect(queued.results).toHaveLength(2);
    expect(queued.results.every((row:any)=>row.scope==='group'&&row.recipient_user_id===guest.user.id&&row.endpoint===endpoints.guest)).toBe(true);
    expect(queued.results.every((row:any)=>row.body==='予定の開始時刻が近づいています'&&!row.body.includes('PRIVATE_SHARED'))).toBe(true);
    expect(queued.results[0].target_path).toContain('group='+group.groupId);
    const sent:string[]=[];
    vi.stubGlobal('fetch',async(url:string)=>{sent.push(url);return new Response(null,{status:201});});
    try { await drainPushQueue(pushEnv); } finally { vi.unstubAllGlobals(); }
    expect(sent).toEqual([endpoints.guest,endpoints.guest]);

    expect((await api('/api/shared/events/update',{groupId:group.groupId,id:event.id,title:'変更',eventDate:'2030-10-21',start:'13:30',end:'14:30',allDay:false,note:''},owner.cookie)).status).toBe(200);
    const moved=await env.DB.prepare('SELECT event_start_at,generation,queued_at FROM event_reminders WHERE shared_event_id=?1').bind(event.id).all<any>();
    expect(moved.results).toHaveLength(2);
    expect(moved.results.every((row:any)=>row.event_start_at==='2030-10-21T04:30:00.000Z'&&row.generation===2&&row.queued_at===null)).toBe(true);

    const wish=(await api('/api/groups/wishes/create',{groupId:group.groupId,wishDate:'2030-10-22',isAllDay:true},owner.cookie)).data;
    await api('/api/groups/wishes/react',{groupId:group.groupId,wishId:wish.id},guest.cookie);
    const tentative=(await api('/api/shared/events/list',{groupId:group.groupId,month:'2030-10'},guest.cookie)).data.events.find((item:any)=>item.wishId===wish.id);
    expect(tentative.status).toBe('tentative');
    expect((await api('/api/reminders/shared/get',{groupId:group.groupId,eventId:tentative.id},guest.cookie)).status).toBe(404);
    expect((await api('/api/reminders/shared/set',{groupId:group.groupId,eventId:event.id,offsetMinutes:[10],timeZone:'Asia/Tokyo'},outsider.cookie)).status).toBe(404);

    expect((await api('/api/shared/events/delete',{groupId:group.groupId,id:event.id},owner.cookie)).status).toBe(200);
    expect((await env.DB.prepare('SELECT id FROM event_reminders WHERE shared_event_id=?1').bind(event.id).all()).results).toHaveLength(0);
    expect((await env.DB.prepare('SELECT id FROM push_deliveries WHERE reminder_id IS NOT NULL').all()).results).toHaveLength(0);
    expect((await env.DB.prepare('SELECT id FROM event_reminders WHERE user_id=?1 AND scope=\'personal\'').bind(owner.user.id).all()).results).toHaveLength(0);
    expect(endpoints.outsider).not.toBe(endpoints.guest);
  });

  it('alerts existing members when a new member joins', async () => {
    const owner = await register('作成者');
    const guest = await register('参加者');
    const group = (await api('/api/groups/create', { name:'サークル' }, owner.cookie)).data.membership;
    const keys = await testKeys();
    const pushEnv: PushEnv = { DB:env.DB, VAPID_PUBLIC_KEY:keys.publicKey, VAPID_PRIVATE_KEY:keys.privateKey, VAPID_SUBJECT:'mailto:test@example.com' };
    const endpoint = 'https://fcm.googleapis.com/fcm/send/join-alert';
    await handlePushRequest(new Request('https://example.com/api/push/subscribe', { method:'POST', body:JSON.stringify({ endpoint, p256dh:keys.p256dh, auth:keys.auth }) }), pushEnv, '/api/push/subscribe', owner.user);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil:(task:Promise<unknown>) => { pending.push(task); } } as unknown as ExecutionContext;
    const endpoints: string[] = [];
    vi.stubGlobal('fetch', async (url:string) => { endpoints.push(url); return new Response(null, { status:201 }); });
    try {
      const response = await handleSharedRequest(new Request('https://example.com/api/groups/join', { method:'POST', body:JSON.stringify({ inviteCode:group.inviteCode }) }), pushEnv, ctx, '/api/groups/join', guest.user);
      expect(response.status).toBe(201);
      await Promise.all(pending);
      expect(endpoints).toEqual([endpoint]);
    } finally { vi.unstubAllGlobals(); }
  });
});
