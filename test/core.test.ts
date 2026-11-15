/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Testes do núcleo: registro, fábrica, manual, cortesia, http e utilitários
 */
import { describe, expect, it } from 'vitest';
import {
    BUILTIN_GATEWAY_IDS,
    centsToDecimal,
    createCourtesyGateway,
    createGateway,
    createHttpClient,
    createManualGateway,
    createPaymentRegistry,
    decimalToCents,
    encodeForm,
    PaymentGatewayError,
    UnsupportedOperationError,
    ValidationError,
    type PaymentGateway,
} from '../src';
import { parseBrPhone, toSaoPauloDate, toSaoPauloIso } from '../src/core/util';
import { baseInput, fakeFetch, fixture } from './helpers';

describe('manual', () => {
    const fixed = new Date('2026-11-15T12:00:00Z');
    const g = createManualGateway({ now: () => fixed });

    it('exige receivedBy e devolve PAID com man_<uuid>', async () => {
        await expect(g.createCharge(baseInput({ method: 'CASH' }))).rejects.toBeInstanceOf(ValidationError);
        const r = await g.createCharge(baseInput({ method: 'CASH', manual: { receivedBy: 'Maria', receivedMethod: 'dinheiro' } }));
        expect(r).toMatchObject({ gateway: 'manual', status: 'PAID', amountCents: 100, paidAt: fixed, externalReference: 'pay_123' });
        expect(r.externalId).toMatch(/^man_[0-9a-f-]{36}$/);
    });

    it('método não suportado, getCharge/cancel/webhook não suportados, refund DONE', async () => {
        await expect(g.createCharge(baseInput({ method: 'CHECKOUT', manual: { receivedBy: 'M' } }))).rejects.toBeInstanceOf(UnsupportedOperationError);
        await expect(g.getCharge('man_x')).rejects.toBeInstanceOf(UnsupportedOperationError);
        await expect(g.cancelCharge('man_x')).rejects.toBeInstanceOf(UnsupportedOperationError);
        await expect(g.parseWebhook({ rawBody: '{}', headers: {} })).rejects.toBeInstanceOf(UnsupportedOperationError);
        await expect(g.refund({ externalId: 'man_x' })).rejects.toBeInstanceOf(ValidationError);
        const r = await g.refund({ externalId: 'man_x', amountCents: 40 });
        expect(r).toMatchObject({ status: 'DONE', amountCents: 40 });
    });
});

describe('courtesy', () => {
    const g = createCourtesyGateway();

    it('exige reason e grantedBy; força valor 0', async () => {
        await expect(g.createCharge(baseInput({ method: 'COURTESY', amountCents: 0 }))).rejects.toBeInstanceOf(ValidationError);
        await expect(
            g.createCharge(baseInput({ method: 'COURTESY', amountCents: 0, courtesy: { reason: 'parceiro', grantedBy: '' } })),
        ).rejects.toThrow(/grantedBy/);
        const r = await g.createCharge(baseInput({ method: 'COURTESY', amountCents: 5000, courtesy: { reason: 'parceiro', grantedBy: 'admin' } }));
        expect(r).toMatchObject({ gateway: 'courtesy', status: 'PAID', amountCents: 0, raw: { waivedAmountCents: 5000 } });
        expect(r.externalId).toMatch(/^cty_/);
        await expect(g.createCharge(baseInput({ method: 'COURTESY', amountCents: -1, courtesy: { reason: 'x', grantedBy: 'y' } }))).rejects.toBeInstanceOf(
            ValidationError,
        );
        await expect(g.refund({ externalId: r.externalId })).rejects.toBeInstanceOf(UnsupportedOperationError);
    });
});

describe('registry', () => {
    const fake = (id: string, methods: PaymentGateway['capabilities']['methods'], over: Partial<PaymentGateway> = {}): PaymentGateway => ({
        id,
        capabilities: { methods, refund: true, partialRefund: true, cancel: true, webhooks: true },
        createCharge: async () => {
            throw new Error('n/a');
        },
        getCharge: async (externalId) => ({ gateway: id, externalId, status: 'PAID', amountCents: 100, externalReference: 'pay_9', raw: {} }),
        cancelCharge: async () => {
            throw new Error('n/a');
        },
        refund: async () => {
            throw new Error('n/a');
        },
        parseWebhook: async () => ({ gateway: id, eventId: 'e1', type: 'charge.updated', externalId: 'x1', raw: {} }),
        ...over,
    });

    it('get/has/list/forMethod com prioridade', () => {
        const reg = createPaymentRegistry({ gateways: [fake('a', ['PIX']), fake('b', ['PIX', 'CARD']), createManualGateway()] });
        expect(reg.has('a')).toBe(true);
        expect(reg.has('zzz')).toBe(false);
        expect(() => reg.get('zzz')).toThrow(ValidationError);
        expect(reg.list().map((g) => g.id)).toEqual(['a', 'b', 'manual']);
        expect(reg.forMethod('PIX')?.id).toBe('a');
        expect(reg.forMethod('PIX', ['b'])?.id).toBe('b');
        expect(reg.forMethod('PIX', ['naoexiste', 'manual'])?.id).toBe('manual');
        expect(reg.forMethod('CARD')?.id).toBe('b');
        expect(reg.forMethod('BOLETO')).toBeUndefined();
    });

    it('rejeita ids duplicados', () => {
        expect(() => createPaymentRegistry({ gateways: [fake('a', []), fake('a', [])] })).toThrow(/duas vezes/);
    });

    it('resolveWebhook busca o status quando o evento veio sem', async () => {
        const reg = createPaymentRegistry({ gateways: [fake('a', ['PIX'])] });
        const ev = await reg.resolveWebhook('a', { rawBody: '{}', headers: {} });
        expect(ev).toMatchObject({ status: 'PAID', externalId: 'x1', externalReference: 'pay_9' });
        expect(ev.charge?.status).toBe('PAID');
    });

    it('resolveWebhook não consulta quando o status já veio', async () => {
        let called = false;
        const g = fake('a', ['PIX'], {
            parseWebhook: async () => ({ gateway: 'a', eventId: 'e', type: 'charge.updated', externalId: 'x', status: 'FAILED', raw: {} }),
            getCharge: async () => {
                called = true;
                throw new Error('não deveria');
            },
        });
        const ev = await createPaymentRegistry({ gateways: [g] }).resolveWebhook('a', { rawBody: '{}', headers: {} });
        expect(ev.status).toBe('FAILED');
        expect(called).toBe(false);
    });

    it('resolveWebhook com Mercado Pago real (fetch falso)', async () => {
        const { createHmac } = await import('node:crypto');
        const f = fakeFetch({ body: fixture('mercadopago/payment-approved.json') });
        const mp = createGateway('mercadopago', { sandbox: true, accessToken: 'TEST', webhookSecret: 's', fetch: f.fetch });
        const ts = '1794800000';
        const v1 = createHmac('sha256', 's').update(`id:1325769823;request-id:r;ts:${ts};`).digest('hex');
        const ev = await createPaymentRegistry({ gateways: [mp] }).resolveWebhook('mercadopago', {
            rawBody: JSON.stringify({ id: 99, type: 'payment', data: { id: '1325769823' } }),
            headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'r' },
            query: { 'data.id': '1325769823', type: 'payment' },
        });
        expect(ev).toMatchObject({ status: 'PAID', externalReference: 'pay_123', eventId: '99' });
    });
});

describe('createGateway', () => {
    it('cria todos os embutidos', () => {
        expect(BUILTIN_GATEWAY_IDS).toEqual(['stripe', 'mercadopago', 'pagseguro', 'asaas', 'manual', 'courtesy']);
        expect(createGateway('stripe', { sandbox: true, secretKey: 'sk_test_x' }).id).toBe('stripe');
        expect(createGateway('pagseguro', { sandbox: true, token: 't' }).capabilities.methods).toContain('BOLETO');
        expect(createGateway('asaas', { sandbox: true, apiKey: 'k' }).id).toBe('asaas');
        expect(createGateway('manual', {}).id).toBe('manual');
        expect(createGateway('courtesy', {}).id).toBe('courtesy');
        expect(() => createGateway('nope' as 'manual', {})).toThrow(ValidationError);
        expect(() => createGateway('asaas', { sandbox: true, apiKey: '' })).toThrow(ValidationError);
    });
});

describe('http', () => {
    it('timeout -> PaymentGatewayError sem httpStatus', async () => {
        const slow = ((_url: string, init: RequestInit) =>
            new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof fetch;
        const http = createHttpClient({ gateway: 'x', baseUrl: 'https://x.test', headers: {}, fetch: slow, timeoutMs: 20 });
        const err = (await http({ path: '/a' }).catch((e: unknown) => e)) as PaymentGatewayError;
        expect(err).toBeInstanceOf(PaymentGatewayError);
        expect(err.httpStatus).toBeUndefined();
        expect(err.message).toMatch(/tempo esgotado/);
    });

    it('erro com corpo não-JSON', async () => {
        const f = fakeFetch({ status: 502, text: 'Bad Gateway' });
        const http = createHttpClient({ gateway: 'x', baseUrl: 'https://x.test/v3/', headers: {}, fetch: f.fetch });
        const err = await http({ path: 'a', query: { b: [1, 2], c: undefined } }).catch((e: PaymentGatewayError) => e);
        expect(f.calls[0].url).toBe('https://x.test/v3/a?b=1&b=2');
        expect(err).toMatchObject({ httpStatus: 502, raw: 'Bad Gateway' });
    });

    it('encodeForm no formato da Stripe', () => {
        expect(encodeForm({ a: { b: 1 }, c: ['x', 'y'], d: undefined, e: 'á b' })).toBe('a%5Bb%5D=1&c%5B0%5D=x&c%5B1%5D=y&e=%C3%A1%20b');
    });
});

describe('util', () => {
    it('dinheiro', () => {
        expect(centsToDecimal(100)).toBe(1);
        expect(centsToDecimal(1999)).toBe(19.99);
        expect(decimalToCents(19.99)).toBe(1999);
        expect(decimalToCents('0.1')).toBe(10);
    });
    it('datas São Paulo', () => {
        expect(toSaoPauloIso(new Date('2026-11-16T02:30:00Z'))).toBe('2026-11-15T23:30:00.000-03:00');
        expect(toSaoPauloIso(new Date('2026-11-16T02:30:00Z'), false)).toBe('2026-11-15T23:30:00-03:00');
        expect(toSaoPauloDate(new Date('2026-11-16T02:30:00Z'))).toBe('2026-11-15');
    });
    it('telefone', () => {
        expect(parseBrPhone('+55 (51) 99999-9999')).toEqual({ country: '55', area: '51', number: '999999999' });
        expect(parseBrPhone('5133334444')).toEqual({ country: '55', area: '51', number: '33334444' });
        expect(parseBrPhone('123')).toBeUndefined();
    });
});
