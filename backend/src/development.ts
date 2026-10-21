export interface DevelopmentEnv { LOCAL_DEV?: string }

export function isLocalDevelopment(request: Request, env: DevelopmentEnv): boolean {
	const url = new URL(request.url);
	return env.LOCAL_DEV === 'true' && url.protocol === 'http:' &&
		(url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

export const localOrigins = new Set(
	['localhost', '127.0.0.1'].flatMap((host) =>
		[5500, 3000, 5173, 8767].map((port) => `http://${host}:${port}`)),
);
