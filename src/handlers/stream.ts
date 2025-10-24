import type { Env } from '../types';
import { jsonResponse } from '../utils/response';
import { corsHeaders } from '../middleware/cors';

// ===== 캐시 설정 =====
const CACHE_CONFIGS = {
    image: {
        browserCache: 'public, max-age=31536000, immutable', // 1년
        kvTTL: 31536000, // 1년
        shouldCacheInKV: true,
        maxKVSize: 5 * 1024 * 1024 // 5MB
    },
    video: {
        browserCache: 'public, max-age=31536000, immutable', // 1년
        kvTTL: 604800, // 7일 (비디오는 크기 때문에 KV에는 짧게)
        shouldCacheInKV: false, // 비디오는 KV 스킵
        maxKVSize: 0
    },
    audio: {
        browserCache: 'public, max-age=31536000, immutable', // 1년
        kvTTL: 2592000, // 30일
        shouldCacheInKV: true,
        maxKVSize: 10 * 1024 * 1024 // 10MB
    }
};

// 청크 크기 설정
const VIDEO_CHUNK_SIZE = 2 * 1024 * 1024; // 2MB
const AUDIO_CHUNK_SIZE = 512 * 1024; // 512KB
const DEFAULT_CHUNK_SIZE = 1 * 1024 * 1024; // 1MB

// KV 네임스페이스
const KV_NAMESPACE = 'celebrity:media:';

// ===== 유틸리티 함수 =====

// Workers Cache 키 생성
function getCacheKey(fileKey: string): Request {
    return new Request(
        `https://cache.local/celebrity/${fileKey}`,
        { method: 'GET' }
    );
}

// KV 키 생성
function getKVKey(fileKey: string): string {
    return `${KV_NAMESPACE}${fileKey}`;
}

// 캐시 설정 가져오기
function getCacheConfig(contentType: string) {
    if (contentType.startsWith('image/')) return CACHE_CONFIGS.image;
    if (contentType.startsWith('video/')) return CACHE_CONFIGS.video;
    if (contentType.startsWith('audio/')) return CACHE_CONFIGS.audio;
    return CACHE_CONFIGS.image; // 기본값
}

// 응답 헤더 생성
function buildResponseHeaders(
    contentType: string,
    contentLength: number,
    cacheControl: string,
    cacheStatus: string
): Headers {
    return new Headers({
        'Content-Type': contentType,
        'Content-Length': contentLength.toString(),
        'Cache-Control': cacheControl,
        'X-Cache': cacheStatus,
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'inline',
        ...corsHeaders
    });
}

// Range 응답 헤더 생성
function buildRangeHeaders(
    contentType: string,
    start: number,
    end: number,
    total: number,
    cacheControl: string
): Headers {
    return new Headers({
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': (end - start + 1).toString(),
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
        ...corsHeaders
    });
}

// ===== 메인 핸들러 =====

export async function handleFileStream(
    request: Request,
    env: Env,
    fileKey: string
): Promise<Response> {
    console.log('handleFileStream called with fileKey:', fileKey);

    try {
        // 파일 키 검증
        if (!fileKey || fileKey.includes('..')) {
            console.error('Invalid file key:', fileKey);
            return jsonResponse({ error: 'Invalid file key' }, 400);
        }

        // R2 bucket 확인
        if (!env.bucket) {
            console.error('env.bucket is undefined');
            return jsonResponse({
                error: 'R2 bucket not configured',
                debug: 'env.bucket is undefined in handleFileStream'
            }, 500);
        }

        // 1. Workers Cache 확인 (가장 빠름)
        const cacheKey = getCacheKey(fileKey);
        const cachedResponse = await caches.default.match(cacheKey);

        if (cachedResponse && !request.headers.get('range')) {
            console.log(`[CACHE HIT] Workers Cache: ${fileKey}`);
            // 캐시된 응답 복제하여 X-Cache 헤더 추가
            const headers = new Headers(cachedResponse.headers);
            headers.set('X-Cache', 'HIT-WORKERS');
            return new Response(cachedResponse.body, {
                status: cachedResponse.status,
                headers
            });
        }

        // 2. HEAD 요청으로 메타데이터 확인
        const objectInfo = await env.bucket.head(fileKey);
        if (!objectInfo) {
            console.error('File not found in R2:', fileKey);
            return jsonResponse({ error: 'File not found' }, 404);
        }

        const contentType = objectInfo.httpMetadata?.contentType || 'application/octet-stream';
        const isImage = contentType.startsWith('image/');
        const isVideo = contentType.startsWith('video/');
        const isAudio = contentType.startsWith('audio/');

        // 미디어 파일만 허용
        if (!isImage && !isVideo && !isAudio) {
            return jsonResponse({
                error: 'This endpoint is for media files only. Use /download/ for other files.',
                downloadUrl: `/download/${fileKey}`,
                contentType: contentType
            }, 400);
        }

        const fileSize = objectInfo.size;
        const config = getCacheConfig(contentType);

        // 3. Range 요청 처리
        const rangeHeader = request.headers.get('range');
        if (rangeHeader && (isVideo || isAudio)) {
            return handleRangeRequest(
                request, env, fileKey, rangeHeader,
                contentType, fileSize, config.browserCache
            );
        }

        // 4. KV Cache 확인 (작은 파일만)
        if (config.shouldCacheInKV && fileSize <= config.maxKVSize && env.KV) {
            try {
                const kvKey = getKVKey(fileKey);
                const kvData = await env.KV.get(kvKey, 'arrayBuffer');

                if (kvData) {
                    console.log(`[CACHE HIT] KV: ${fileKey}`);
                    const response = new Response(kvData, {
                        headers: buildResponseHeaders(
                            contentType,
                            kvData.byteLength,
                            config.browserCache,
                            'HIT-KV'
                        )
                    });

                    // Workers Cache에도 저장 (백그라운드)
                    caches.default.put(cacheKey, response.clone()).catch(err =>
                        console.error('[Workers Cache Error]', err)
                    );

                    return response;
                }
            } catch (error) {
                console.error('[KV Error]', error);
            }
        }

        // 5. R2에서 파일 가져오기
        console.log('Fetching from R2...');
        const object = await env.bucket.get(fileKey);
        if (!object || !object.body) {
            return jsonResponse({ error: 'File not found' }, 404);
        }

        // 6. 응답 생성
        const headers = buildResponseHeaders(
            contentType,
            fileSize,
            config.browserCache,
            'MISS'
        );

        // 작은 파일은 버퍼링하여 캐싱
        if (fileSize <= config.maxKVSize) {
            const arrayBuffer = await object.arrayBuffer();
            const response = new Response(arrayBuffer, { headers });

            // 백그라운드에서 캐싱
            const cachePromises = [];

            // Workers Cache 저장
            cachePromises.push(
                caches.default.put(cacheKey, response.clone())
                    .then(() => console.log(`[CACHED] Workers Cache: ${fileKey}`))
                    .catch(err => console.error('[Workers Cache Error]', err))
            );

            // KV 저장
            if (config.shouldCacheInKV && env.KV) {
                const kvKey = getKVKey(fileKey);
                cachePromises.push(
                    env.KV.put(kvKey, arrayBuffer, { expirationTtl: config.kvTTL })
                        .then(() => console.log(`[CACHED] KV: ${fileKey} (TTL: ${config.kvTTL}s)`))
                        .catch(err => console.error('[KV Error]', err))
                );
            }

            // 캐싱은 백그라운드에서 진행
            Promise.all(cachePromises).catch(() => { });

            return response;
        }

        // 큰 파일은 스트리밍
        return new Response(object.body, { headers });

    } catch (error) {
        console.error('File stream error:', error);
        return jsonResponse({
            error: 'Internal server error',
            details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
}

// ===== Range 요청 처리 =====
async function handleRangeRequest(
    request: Request,
    env: Env,
    fileKey: string,
    rangeHeader: string,
    contentType: string,
    totalSize: number,
    cacheControl: string
): Promise<Response> {
    // Range 파싱
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
        return new Response('Invalid range', { status: 400 });
    }

    // 청크 크기 결정
    const chunkSize = contentType.startsWith('video/') ? VIDEO_CHUNK_SIZE :
        contentType.startsWith('audio/') ? AUDIO_CHUNK_SIZE :
            DEFAULT_CHUNK_SIZE;

    let start: number;
    let end: number;

    if (match[1] === '' && match[2] !== '') {
        // suffix-range: bytes=-N
        const suffix = parseInt(match[2], 10);
        start = Math.max(totalSize - suffix, 0);
        end = totalSize - 1;
    } else {
        // normal range: bytes=N-M
        start = parseInt(match[1], 10);
        end = match[2] ? parseInt(match[2], 10) : Math.min(start + chunkSize - 1, totalSize - 1);
    }

    // Range 유효성 검증
    if (start >= totalSize || start < 0 || end < start) {
        return new Response(null, {
            status: 416,
            headers: {
                'Content-Range': `bytes */${totalSize}`,
                ...corsHeaders
            }
        });
    }

    // Range 캐시 키 (첫 번째 청크만 캐싱)
    const isFirstChunk = start === 0;
    const rangeCacheKey = isFirstChunk ? new Request(
        `https://cache.local/range/${fileKey}?chunk=0-${end}`,
        { method: 'GET' }
    ) : null;

    // 첫 번째 청크 캐시 확인
    if (rangeCacheKey) {
        const cachedChunk = await caches.default.match(rangeCacheKey);
        if (cachedChunk) {
            console.log(`[CACHE HIT] Range chunk: ${fileKey}`);
            return cachedChunk;
        }
    }

    // R2에서 Range 데이터 가져오기
    const rangedObject = await env.bucket.get(fileKey, {
        range: { offset: start, length: end - start + 1 }
    });

    if (!rangedObject || !rangedObject.body) {
        return new Response('Failed to get range', { status: 500 });
    }

    // 응답 생성
    const response = new Response(rangedObject.body, {
        status: 206,
        headers: buildRangeHeaders(
            contentType, start, end, totalSize, cacheControl
        )
    });

    // 첫 번째 청크 캐싱 (백그라운드)
    if (rangeCacheKey && (end - start + 1) <= 512 * 1024) { // 512KB 이하만
        caches.default.put(rangeCacheKey, response.clone()).catch(err =>
            console.error('[Range Cache Error]', err)
        );
    }

    return response;
}