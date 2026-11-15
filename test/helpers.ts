/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Utilitários dos testes: fetch falso (fila de respostas + gravação das chamadas) e fixtures
 */
import { readFileSync } from 'node:fs';
import type { CreateChargeInput } from '../src';

export interface RecordedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    /** body como JSON (quando for JSON) */
    json?: any;
}

export type FakeResponse = { status?: number; body?: unknown; text?: string };

/** fetch falso: devolve as respostas na ordem; falha se acabarem */
export function fakeFetch(...responses: FakeResponse[]) {
    const calls: RecordedCall[] = [];
    const queue = [...responses];
    const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
        const body = typeof init?.body === 'string' ? init.body : undefined;
        let json: unknown;
        try {
            json = body ? JSON.parse(body) : undefined;
        } catch {
            json = undefined;
        }
        calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body, json });
        const r = queue.shift();
        if (!r) throw new Error(`fakeFetch: chamada inesperada ${init?.method ?? 'GET'} ${String(input)}`);
        const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
        const status = r.status ?? 200;
        return new Response(status === 204 || status === 304 ? null : text, { status, headers: { 'Content-Type': 'application/json' } });
    };
    return { fetch: fn as typeof fetch, calls, pending: () => queue.length };
}

const FIXTURES = new URL('./fixtures/', import.meta.url);

export const fixtureText = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fixture = (name: string): any => JSON.parse(fixtureText(name));

export const baseInput = (over: Partial<CreateChargeInput> = {}): CreateChargeInput => ({
    amountCents: 100,
    method: 'PIX',
    description: 'Pedido #123',
    customer: { name: 'Fulano de Tal', email: 'cliente@example.com', cpf: '123.456.789-09', phone: '+55 (51) 99999-9999' },
    externalReference: 'pay_123',
    idempotencyKey: 'idem-123',
    ...over,
});
