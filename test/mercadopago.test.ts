/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Testes do adapter Mercado Pago
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMercadoPagoGateway, mapMercadoPagoStatus, PaymentGatewayError, ValidationError, WebhookSignatureError } from '../src';
import { baseInput, fakeFetch, fixture, fixtureText } from './helpers';

const SECRET = 'mp-secret-xyz';
const PREF_ID = '202809963-920c288b-4ebb-40be-966f-700250fa5370';
const make = (f: ReturnType<typeof fakeFetch>, sandbox = true) =>
    createMercadoPagoGateway({ sandbox, accessToken: 'TEST-123', webhookSecret: SECRET, fetch: f.fetch });

describe('mercadopago: createCharge', () => {
    it('PIX: POST /v1/payments com X-Idempotency-Key, valor decimal e expiração -03:00', async () => {
        const f = fakeFetch({ body: fixture('mercadopago/payment-pix-pending.json') });
        const r = await make(f).createCharge(
            baseInput({ expiresAt: new Date('2026-11-16T13:00:00Z'), notificationUrl: 'https://example.com/wh/mp', metadata: { a: '1' } }),
        );
        const call = f.calls[0];
        expect(call.method).toBe('POST');
        expect(call.url).toBe('https://api.mercadopago.com/v1/payments');
        expect(call.headers.authorization).toBe('Bearer TEST-123');
        expect(call.headers['x-idempotency-key']).toBe('idem-123');
        expect(call.json).toMatchObject({
            transaction_amount: 1,
            payment_method_id: 'pix',
            description: 'Pedido #123',
            external_reference: 'pay_123',
            notification_url: 'https://example.com/wh/mp',
            date_of_expiration: '2026-11-16T10:00:00.000-03:00',
            metadata: { a: '1' },
            payer: { email: 'cliente@example.com', first_name: 'Fulano', last_name: 'de Tal', identification: { type: 'CPF', number: '12345678909' } },
        });
        expect(r).toMatchObject({
            gateway: 'mercadopago',
            externalId: '1325769823',
            status: 'PENDING',
            amountCents: 100,
            externalReference: 'pay_123',
            pix: { qrCodeBase64: 'iVBORw0KGgoAAAANSUhEUgAA' },
        });
        expect(r.pix?.copiaECola).toMatch(/^000201/);
    });

    it('CHECKOUT: preferência (Checkout Pro) com sandbox_init_point', async () => {
        const f = fakeFetch({ body: fixture('mercadopago/preference.json') });
        const r = await make(f).createCharge(
            baseInput({ method: 'CHECKOUT', returnUrls: { success: 'https://example.com/ok', failure: 'https://example.com/fail' } }),
        );
        const call = f.calls[0];
        expect(call.url).toBe('https://api.mercadopago.com/checkout/preferences');
        expect(call.json).toMatchObject({
            items: [{ title: 'Pedido #123', quantity: 1, unit_price: 1, currency_id: 'BRL' }],
            back_urls: { success: 'https://example.com/ok', failure: 'https://example.com/fail' },
            auto_return: 'approved',
            external_reference: 'pay_123',
        });
        expect(call.json.payment_methods).toBeUndefined();
        expect(r).toMatchObject({ externalId: PREF_ID, status: 'PENDING', amountCents: 100 });
        expect(r.checkoutUrl).toContain('sandbox.mercadopago.com.br');
    });

    it('CARD exclui boleto/pix e produção usa init_point', async () => {
        const f = fakeFetch({ body: fixture('mercadopago/preference.json') });
        const r = await make(f, false).createCharge(baseInput({ method: 'CARD' }));
        expect(f.calls[0].json.payment_methods.excluded_payment_types).toEqual([{ id: 'ticket' }, { id: 'bank_transfer' }, { id: 'atm' }]);
        expect(r.checkoutUrl).toContain('www.mercadopago.com.br');
    });

    it('valida itens x total e método não suportado', async () => {
        const g = make(fakeFetch());
        await expect(
            g.createCharge(baseInput({ items: [{ title: 'A', quantity: 2, unitAmountCents: 30 }] })),
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(g.createCharge(baseInput({ method: 'BOLETO' }))).rejects.toThrow(/não suporta/);
    });

    it('erro 400 -> PaymentGatewayError com código do cause', async () => {
        const f = fakeFetch({ status: 400, body: fixture('mercadopago/error-bad-request.json') });
        const err = await make(f).createCharge(baseInput()).catch((e) => e);
        expect(err).toBeInstanceOf(PaymentGatewayError);
        expect(err).toMatchObject({ httpStatus: 400, providerCode: '4050' });
    });
});

describe('mercadopago: getCharge / refund / cancel', () => {
    it('pagamento (id numérico) -> GET /v1/payments/{id}', async () => {
        const f = fakeFetch({ body: fixture('mercadopago/payment-approved.json') });
        const r = await make(f).getCharge('1325769823');
        expect(f.calls[0].url).toBe('https://api.mercadopago.com/v1/payments/1325769823');
        expect(r.status).toBe('PAID');
        expect(r.paidAt).toEqual(new Date('2026-11-15T14:05:00.000Z'));
    });

    it('preferência -> busca pagamentos por external_reference e escolhe o aprovado', async () => {
        const f = fakeFetch({ body: fixture('mercadopago/preference.json') }, { body: fixture('mercadopago/payments-search.json') });
        const r = await make(f).getCharge(PREF_ID);
        expect(f.calls[0].url).toBe(`https://api.mercadopago.com/checkout/preferences/${PREF_ID}`);
        expect(f.calls[1].url).toBe(
            'https://api.mercadopago.com/v1/payments/search?external_reference=pay_123&sort=date_created&criteria=desc',
        );
        expect(r).toMatchObject({ externalId: PREF_ID, status: 'PAID', externalReference: 'pay_123' });
    });

    it('preferência sem pagamento -> PENDING', async () => {
        const f = fakeFetch({ body: fixture('mercadopago/preference.json') }, { body: { results: [] } });
        expect((await make(f).getCharge(PREF_ID)).status).toBe('PENDING');
    });

    it('refund parcial', async () => {
        const f = fakeFetch({ body: fixture('mercadopago/refund.json') });
        const r = await make(f).refund({ externalId: '1325769823', amountCents: 50 });
        expect(f.calls[0]).toMatchObject({ method: 'POST', url: 'https://api.mercadopago.com/v1/payments/1325769823/refunds', json: { amount: 0.5 } });
        expect(f.calls[0].headers['x-idempotency-key']).toBeTruthy();
        expect(r).toMatchObject({ externalRefundId: '1009042015', status: 'DONE', amountCents: 50 });
    });

    it('cancel de pagamento -> PUT status cancelled', async () => {
        const f = fakeFetch({ body: { ...fixture('mercadopago/payment-pix-pending.json'), status: 'cancelled', status_detail: 'by_collector' } });
        const r = await make(f).cancelCharge('1325769823');
        expect(f.calls[0]).toMatchObject({ method: 'PUT', json: { status: 'cancelled' } });
        expect(r.status).toBe('CANCELED');
    });
});

describe('mercadopago: status', () => {
    it.each([
        ['approved', undefined, 'PAID'],
        ['approved', 'partially_refunded', 'PARTIALLY_REFUNDED'],
        ['pending', undefined, 'PENDING'],
        ['in_process', undefined, 'PENDING'],
        ['authorized', undefined, 'AUTHORIZED'],
        ['rejected', undefined, 'FAILED'],
        ['cancelled', undefined, 'CANCELED'],
        ['cancelled', 'expired', 'EXPIRED'],
        ['refunded', undefined, 'REFUNDED'],
        ['charged_back', undefined, 'CHARGEBACK'],
    ])('%s/%s -> %s', (s, d, expected) => {
        expect(mapMercadoPagoStatus(s, d)).toBe(expected);
    });
});

describe('mercadopago: webhook', () => {
    const body = fixtureText('mercadopago/webhook-payment.json');
    const sign = (dataId: string, requestId: string, ts = '1794800000', secret = SECRET) =>
        `ts=${ts},v1=${createHmac('sha256', secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex')}`;

    it('x-signature válido -> evento só com id (sem status)', async () => {
        const ev = await make(fakeFetch()).parseWebhook({
            rawBody: body,
            headers: { 'X-Signature': sign('1325769823', 'req-abc'), 'X-Request-Id': 'req-abc' },
            query: { 'data.id': '1325769823', type: 'payment' },
        });
        expect(ev).toMatchObject({ gateway: 'mercadopago', eventId: '12345678901', type: 'charge.updated', externalId: '1325769823' });
        expect(ev.status).toBeUndefined();
    });

    it('data.id alfanumérico entra em minúsculas no manifesto', async () => {
        const raw = JSON.stringify({ id: 1, type: 'payment', data: { id: 'ABC123' } });
        const ev = await make(fakeFetch()).parseWebhook({
            rawBody: raw,
            headers: { 'x-signature': sign('abc123', 'r1'), 'x-request-id': 'r1' },
            query: { 'data.id': 'ABC123' },
        });
        expect(ev.externalId).toBe('ABC123');
    });

    it('assinatura inválida / ausente / sem segredo -> WebhookSignatureError', async () => {
        const g = make(fakeFetch());
        const query = { 'data.id': '1325769823' };
        await expect(g.parseWebhook({ rawBody: body, headers: {}, query })).rejects.toBeInstanceOf(WebhookSignatureError);
        await expect(
            g.parseWebhook({ rawBody: body, headers: { 'x-signature': sign('1325769823', 'req-abc', undefined, 'errado'), 'x-request-id': 'req-abc' }, query }),
        ).rejects.toBeInstanceOf(WebhookSignatureError);
        await expect(
            g.parseWebhook({ rawBody: body, headers: { 'x-signature': sign('999', 'req-abc'), 'x-request-id': 'req-abc' }, query }),
        ).rejects.toBeInstanceOf(WebhookSignatureError);
        const noSecret = createMercadoPagoGateway({ sandbox: true, accessToken: 'TEST' });
        await expect(noSecret.parseWebhook({ rawBody: body, headers: { 'x-signature': sign('1325769823', 'req-abc') }, query })).rejects.toBeInstanceOf(
            WebhookSignatureError,
        );
    });
});
