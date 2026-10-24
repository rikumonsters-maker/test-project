import { handleSharedRequest } from './shared';
import { handlePersonalEvents } from './personal-events';
import { getSessionUser, handleAuthRequest } from './auth';
import { handleProfileRequest } from './profile';
import { drainPushQueue, handlePushRequest } from './push';
import { drainReminderQueue, handleReminderRequest } from './reminders';
import { handleNotificationRequest } from './notifications';
import { PUBLIC_APP_ORIGIN } from './app-origin';
import { isLocalDevelopment, localOrigins, type DevelopmentEnv } from './development';

const allowedOrigins = new Set([
	PUBLIC_APP_ORIGIN,
	'https://test-project-fff-7e58.vercel.app',
	'https://test-project-nu-one-12.vercel.app',
]);

// Emergency recovery stays on the migration-compatible Worker code. Older
// Worker versions do not understand departed memberships and cannot be restored.
function groupAccessPaused(env: Env): boolean {
	return (env as Env & { GROUP_ACCESS_PAUSED?: string }).GROUP_ACCESS_PAUSED === 'true';
}

function withCors(response: Response, origin: string | null): Response {
	const headers = new Headers(response.headers);
	headers.set('vary', 'Origin');
	if (origin) {
		headers.set('access-control-allow-origin', origin);
		headers.set('access-control-allow-credentials', 'true');
		headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
		headers.set('access-control-allow-headers', 'Content-Type');
	}
	return new Response(response.body, { status:response.status, headers });
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
		},
	});
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validCalendarDate(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function readJson(request: Request): Promise<unknown> {
	return request.json();
}

export default {
	async scheduled(_controller, env, ctx): Promise<void> {
		if (groupAccessPaused(env)) return;
		ctx.waitUntil((async () => {
			await drainReminderQueue(env);
			await drainPushQueue(env);
		})());
	},
	async fetch(request, env, ctx): Promise<Response> {
		const origin = request.headers.get('origin');
		if (origin && !allowedOrigins.has(origin) &&
			!(isLocalDevelopment(request, env) && localOrigins.has(origin))) {
			return jsonResponse({ error:'このサイトからはアクセスできません' }, 403);
		}
		if (request.method === 'OPTIONS') {
			return withCors(new Response(null, { status:204 }), origin);
		}

		const { pathname } = new URL(request.url);
		if (pathname.startsWith('/api/auth/')) return withCors(await handleAuthRequest(request, env, pathname), origin);
		const user = await getSessionUser(request, env.DB);
		if (!user) return withCors(jsonResponse({ error:'ログインが必要です' }, 401), origin);
		if (groupAccessPaused(env) &&
			(pathname.startsWith('/api/groups/') || pathname.startsWith('/api/shared/') || pathname.startsWith('/api/reminders/shared/'))) {
			return withCors(jsonResponse({ error:'グループ機能は安全確認のため一時停止中です。しばらくしてからお試しください。' }, 503), origin);
		}
		if (pathname.startsWith('/api/notifications')) return withCors(await handleNotificationRequest(request, env.DB, pathname, user), origin);
		if (pathname.startsWith('/api/personal/events')) return withCors(await handlePersonalEvents(request, env.DB, pathname, user), origin);
		if (pathname.startsWith('/api/reminders/')) return withCors(await handleReminderRequest(request, env.DB, pathname, user), origin);
		if (pathname.startsWith('/api/profile')) return withCors(await handleProfileRequest(request, env.DB, pathname, user), origin);
		if (pathname.startsWith('/api/push/')) return withCors(await handlePushRequest(request, env, pathname, user), origin);
		if (pathname.startsWith('/api/groups/') || pathname.startsWith('/api/shared/')) {
			return withCors(await handleSharedRequest(request, env, ctx, pathname, user), origin);
		}
		if (pathname !== '/api/budget' && pathname !== '/api/wage') {
			return withCors(jsonResponse({ error: 'APIが見つかりません' }, 404), origin);
		}

		if (request.method !== 'POST') {
			return withCors(jsonResponse({ error: 'POSTメソッドを使用してください' }, 405), origin);
		}

		let body: unknown;
		try {
			body = await readJson(request);
		} catch {
			return withCors(jsonResponse({ error: 'リクエスト本文は有効なJSONである必要があります' }, 400), origin);
		}

		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			return withCors(jsonResponse({ error: 'JSONオブジェクトを送信してください' }, 400), origin);
		}

		const values = body as Record<string, unknown>;

		if (pathname === '/api/budget') {
			const { income, fixed, saving, spent, month, today } = values;
			if (!isNonNegativeNumber(income) || !isNonNegativeNumber(fixed) || !isNonNegativeNumber(saving) || !isNonNegativeNumber(spent)) {
				return withCors(jsonResponse(
					{ error: 'income、fixed、saving、spentには0以上の数値を指定してください' },
					400,
				), origin);
			}
			if ((month !== undefined || today !== undefined) &&
				(typeof month !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) ||
				 !validCalendarDate(today))) {
				return withCors(jsonResponse({ error:'対象月と今日の日付を確認してください' }, 400), origin);
			}

			const remaining = income - fixed - saving - spent;
			const currentDate = today ?? new Date().toISOString().slice(0, 10);
			const selectedMonth = month ?? currentDate.slice(0, 7);
			const [year, monthNumber] = selectedMonth.split('-').map(Number);
			const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
			const currentMonth = currentDate.slice(0, 7);
			const currentDay = Number(currentDate.slice(8, 10));
			const daysLeft = selectedMonth < currentMonth ? 0
				: selectedMonth > currentMonth ? daysInMonth : daysInMonth - currentDay + 1;
			const daily = daysLeft ? Math.round(remaining / daysLeft) : null;

			const spendingBudget = income - fixed - saving;
			const onPaceBudget = spendingBudget * currentDay / daysInMonth;
			let status: 'safe' | 'caution' | 'danger' = 'safe';
			let message = selectedMonth < currentMonth ? 'この月の支出は予算内です'
				: selectedMonth > currentMonth ? '予定した支出は予算内です' : 'このペースなら目標貯金を達成できます';

			if (spendingBudget < 0 || spent > spendingBudget) {
				status = 'danger';
				message = selectedMonth < currentMonth ? 'この月は目標貯金を下回りました'
					: 'このままだと目標貯金を下回る可能性があります';
			} else if (selectedMonth === currentMonth && spent > onPaceBudget) {
				status = 'caution';
				message = '少し支出ペースが高めです';
			}

			return withCors(jsonResponse({ remaining, daily, status, message }), origin);
		}

		const { hourly, hours } = values;
		if (!isNonNegativeNumber(hourly) || !isNonNegativeNumber(hours)) {
			return withCors(jsonResponse(
				{ error: 'hourlyとhoursには0以上の数値を指定してください' },
				400,
			), origin);
		}

		return withCors(jsonResponse({ wage: hourly * hours }), origin);
	},
} satisfies ExportedHandler<Env & DevelopmentEnv>;
