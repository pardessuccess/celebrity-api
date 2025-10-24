import type { Env } from './types';
import { handleCorsRequest } from './middleware/cors';
import { jsonResponse } from './utils/response';
import { handleFileStream } from './handlers/stream';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method;

		// CORS preflight
		if (method === 'OPTIONS') {
			return handleCorsRequest();
		}

		// GET 요청 처리
		if (method === 'GET') {
			const pathname = url.pathname;

			// /celebrity/로 시작하는 경로 처리
			if (pathname.startsWith('/celebrity/')) {
				// 맨 앞의 슬래시만 제거하고 전체 경로를 파일 키로 사용
				const fileKey = pathname.substring(1);
				// 이제 fileKey = "celebrity/jyoon/main/jyoon.webp"

				console.log('Attempting to access file with key:', fileKey);
				return handleFileStream(request, env, fileKey);
			}

			// 루트 경로
			if (pathname === '/' || pathname === '') {
				return jsonResponse({ message: 'Celebrity API' }, 200);
			}
		}

		return jsonResponse({ error: 'Not Found' }, 404);
	},
};