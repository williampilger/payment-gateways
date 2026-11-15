/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Cliente HTTP interno (fetch nativo + timeout + JSON/form + mapeamento de erros)
 *
 * - Respostas != 2xx viram `PaymentGatewayError` com httpStatus, providerCode (extraído por cada adapter) e raw.
 * - Timeout via AbortSignal.timeout -> `PaymentGatewayError` sem httpStatus.
 */
import { PaymentGatewayError } from './errors';
import type { GatewayId } from './types';

export type QueryValue = string | number | boolean | null | undefined | (string | number)[];

export interface HttpRequest {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    query?: Record<string, QueryValue>;
    headers?: Record<string, string | undefined>;
    /** Corpo JSON */
    json?: unknown;
    /** Corpo application/x-www-form-urlencoded (já codificado — ver `encodeForm`) */
    form?: string;
}

export interface HttpClientOptions {
    gateway: GatewayId;
    baseUrl: string;
    headers: Record<string, string>;
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** Extrai { message, code } do corpo de erro do provedor */
    parseError?: (body: unknown) => { message?: string; code?: string } | undefined;
}

export type HttpClient = <T = unknown>(req: HttpRequest) => Promise<T>;

export const DEFAULT_TIMEOUT_MS = 30_000;

export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
        else url.searchParams.set(k, String(v));
    }
    return url.toString();
}

/**
 * Codificação "bracket" usada pela Stripe:
 * { a: { b: 1 }, c: ['x','y'] } -> "a[b]=1&c[0]=x&c[1]=y"
 */
export function encodeForm(obj: Record<string, unknown>): string {
    const pairs: string[] = [];
    const walk = (prefix: string, v: unknown): void => {
        if (v === undefined || v === null) return;
        if (Array.isArray(v)) v.forEach((item, i) => walk(`${prefix}[${i}]`, item));
        else if (v instanceof Date) pairs.push(`${encodeURIComponent(prefix)}=${Math.floor(v.getTime() / 1000)}`);
        else if (typeof v === 'object') for (const [k, sub] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, sub);
        else pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
    };
    walk('', obj);
    return pairs.join('&');
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return async <T>(req: HttpRequest): Promise<T> => {
        const method = req.method ?? 'GET';
        const url = buildUrl(opts.baseUrl, req.path, req.query);
        const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
        for (const [k, v] of Object.entries(req.headers ?? {})) if (v !== undefined) headers[k] = v;

        let body: string | undefined;
        if (req.json !== undefined) {
            body = JSON.stringify(req.json);
            headers['Content-Type'] = 'application/json';
        } else if (req.form !== undefined) {
            body = req.form;
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        let res: Response;
        try {
            res = await doFetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
            throw new PaymentGatewayError(
                isTimeout ? `${opts.gateway}: tempo esgotado (${timeoutMs} ms) em ${method} ${req.path}` : `${opts.gateway}: falha de rede em ${method} ${req.path}`,
                { gateway: opts.gateway, cause: err },
            );
        }

        const text = await res.text();
        let data: unknown = undefined;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = text;
            }
        }

        if (!res.ok) {
            const parsed = safeParseError(opts.parseError, data);
            throw new PaymentGatewayError(
                `${opts.gateway}: HTTP ${res.status} em ${method} ${req.path}${parsed?.message ? ` - ${parsed.message}` : ''}`,
                { gateway: opts.gateway, httpStatus: res.status, providerCode: parsed?.code, raw: data },
            );
        }
        return data as T;
    };
}

function safeParseError(fn: HttpClientOptions['parseError'], data: unknown) {
    if (!fn) return undefined;
    try {
        return fn(data);
    } catch {
        return undefined;
    }
}
