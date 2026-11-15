/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Testes do adapter PagSeguro / PagBank
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    createPagSeguroGateway,
    mapPagSeguroCharge,
    mapPagSeguroCheckoutStatus,
    mapPagSeguroStatus,
    PaymentGatewayError,
    UnsupportedOperationError,
    ValidationError,
    WebhookSignatureError,
} from '../src';
import { baseInput, fakeFetch, fixture, fixtureText } from './helpers';

const TOKEN = 'pagbank-token-abc';
const ORDER_ID = 'ORDE_3E1A4C2B-1D2E-4F5A-9B8C-7D6E5F4A3B2C';
const CHECKOUT_ID = 'CHEC_0D9B5A3C-6E2F-4B7A-8C1D-2E3F4A5B6C7D';
const make = (f: ReturnType<typeof fakeFetch>, sandbox = true) => createPagSeguroGateway({ sandbox, token: TOKEN, fetch: f.fetch });
const address = { street: 'Rua A', number: '10', locality: 'Centro', city: 'Bom Princípio', regionCode: 'rs', postalCode: '95765-000' };

describe('pagseguro: createCharge', () => {
    it('PIX: POST /orders (sandbox) com qr_codes e x-idempotency-key', async () => {
        const f = fakeFetch({ body: fixture('pagseguro/order-pix.json') });
        const r = await make(f).createCharge(
            baseInput({ expiresAt: new Date('2026-11-16T13:00:00Z'), notificationUrl: 'https://example.com/wh/ps' }),
        );
        const call = f.calls[0];
        expect(call.url).toBe('https://sandbox.api.pagseguro.com/orders');
        expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(call.headers['x-idempotency-key']).toBe('idem-123');
        expect(call.json).toMatchObject({
            reference_id: 'pay_123',
            customer: {
                name: 'Fulano de Tal',
                email: 'cliente@example.com',
                tax_id: '12345678909',
                phones: [{ country: '55', area: '51', number: '999999999', type: 'MOBILE' }],
            },
            items: [{ name: 'Pedido #123', quantity: 1, unit_amount: 100 }],
            qr_codes: [{ amount: { value: 100 }, expiration_date: '2026-11-16T10:00:00-03:00' }],
            notification_urls: ['https://example.com/wh/ps'],
        });
        expect(r).toMatchObject({
            gateway: 'pagseguro',
            externalId: ORDER_ID,
            status: 'PENDING',
            amountCents: 100,
            externalReference: 'pay_123',
            pix: { qrCodeUrl: 'https://sandbox.api.pagseguro.com/qrcode/QRCO_1A2B3C4D/png' },
        });
        expect(r.pix?.copiaECola).toMatch(/^000201/);
    });

    it('produção usa api.pagseguro.com; PIX exige CPF', async () => {
        const f = fakeFetch({ body: fixture('pagseguro/order-pix.json') });
        await make(f, false).createCharge(baseInput());
        expect(f.calls[0].url).toBe('https://api.pagseguro.com/orders');
        await expect(make(fakeFetch()).createCharge(baseInput({ customer: { name: 'A', email: 'a@b.c' } }))).rejects.toBeInstanceOf(ValidationError);
    });

    it('BOLETO: charge com holder + endereço; devolve linha e PDF', async () => {
        const f = fakeFetch({ body: fixture('pagseguro/order-boleto.json') });
        const input = baseInput({ method: 'BOLETO', amountCents: 1500, expiresAt: new Date('2026-11-18T15:00:00Z') });
        await expect(make(fakeFetch()).createCharge(input)).rejects.toThrow(/address/);
        const r = await make(f).createCharge({ ...input, customer: { ...input.customer, address } });
        const charge = f.calls[0].json.charges[0];
        expect(charge).toMatchObject({
            amount: { value: 1500, currency: 'BRL' },
            payment_method: {
                type: 'BOLETO',
                boleto: {
                    due_date: '2026-11-18',
                    holder: { tax_id: '12345678909', address: { region_code: 'RS', region: 'Rio Grande do Sul', postal_code: '95765000', country: 'Brasil' } },
                },
            },
        });
        expect(r).toMatchObject({
            status: 'PENDING',
            amountCents: 1500,
            boletoBarcode: '03399853012970000024227020901016278150000015630',
            boletoUrl: 'https://boleto.sandbox.pagseguro.com.br/8d8a1b6c.pdf',
        });
    });

    it('CHECKOUT: POST /checkouts -> link PAY', async () => {
        const f = fakeFetch({ body: fixture('pagseguro/checkout.json') });
        const r = await make(f).createCharge(
            baseInput({ method: 'CHECKOUT', returnUrls: { success: 'https://example.com/ok' }, notificationUrl: 'https://example.com/wh' }),
        );
        expect(f.calls[0].url).toBe('https://sandbox.api.pagseguro.com/checkouts');
        expect(f.calls[0].json).toMatchObject({
            reference_id: 'pay_123',
            redirect_url: 'https://example.com/ok',
            notification_urls: ['https://example.com/wh'],
            payment_notification_urls: ['https://example.com/wh'],
            payment_methods: [{ type: 'CREDIT_CARD' }, { type: 'PIX' }, { type: 'BOLETO' }],
        });
        expect(r).toMatchObject({ externalId: CHECKOUT_ID, status: 'PENDING', amountCents: 100 });
        expect(r.checkoutUrl).toContain('pagamento.sandbox.pagbank.com.br');
    });

    it('erro 400 -> PaymentGatewayError', async () => {
        const f = fakeFetch({ status: 400, body: fixture('pagseguro/error-invalid.json') });
        const err = await make(f).createCharge(baseInput()).catch((e) => e);
        expect(err).toBeInstanceOf(PaymentGatewayError);
        expect(err).toMatchObject({ httpStatus: 400, providerCode: '40002' });
        expect(err.message).toContain('customer.tax_id');
    });
});

describe('pagseguro: getCharge / refund / cancel', () => {
    it('pedido pago', async () => {
        const f = fakeFetch({ body: fixture('pagseguro/order-pix-paid.json') });
        const r = await make(f).getCharge(ORDER_ID);
        expect(f.calls[0].url).toBe(`https://sandbox.api.pagseguro.com/orders/${ORDER_ID}`);
        expect(r.status).toBe('PAID');
        expect(r.paidAt).toEqual(new Date('2026-11-15T13:05:01.000Z'));
    });

    it('checkout sem pedido -> status do checkout; com pedido -> status do pedido', async () => {
        const f1 = fakeFetch({ body: fixture('pagseguro/checkout.json') });
        expect((await make(f1).getCharge(CHECKOUT_ID)).status).toBe('PENDING');

        const f2 = fakeFetch({ body: { ...fixture('pagseguro/checkout.json'), orders: [{ id: ORDER_ID }] } }, { body: fixture('pagseguro/order-pix-paid.json') });
        const r = await make(f2).getCharge(CHECKOUT_ID);
        expect(f2.calls[1].url).toBe(`https://sandbox.api.pagseguro.com/orders/${ORDER_ID}`);
        expect(r).toMatchObject({ externalId: CHECKOUT_ID, status: 'PAID' });
    });

    it('refund -> POST /charges/{id}/cancel com amount', async () => {
        const f = fakeFetch({ body: fixture('pagseguro/order-pix-paid.json') }, { body: fixture('pagseguro/charge-canceled.json') });
        const r = await make(f).refund({ externalId: ORDER_ID, amountCents: 100 });
        expect(f.calls[1]).toMatchObject({
            method: 'POST',
            url: 'https://sandbox.api.pagseguro.com/charges/CHAR_5F6E7D8C-1A2B-3C4D-5E6F-7A8B9C0D1E2F/cancel',
            json: { amount: { value: 100 } },
        });
        expect(r).toMatchObject({ status: 'DONE', amountCents: 100 });
    });

    it('cancel: PIX sem charge -> Unsupported; checkout -> inactivate', async () => {
        await expect(make(fakeFetch({ body: fixture('pagseguro/order-pix.json') })).cancelCharge(ORDER_ID)).rejects.toBeInstanceOf(
            UnsupportedOperationError,
        );
        const f = fakeFetch({ body: fixture('pagseguro/checkout.json') }, { status: 204 });
        const r = await make(f).cancelCharge(CHECKOUT_ID);
        expect(f.calls[1]).toMatchObject({ method: 'POST', url: `https://sandbox.api.pagseguro.com/checkouts/${CHECKOUT_ID}/inactivate` });
        expect(r.status).toBe('CANCELED');
    });
});

describe('pagseguro: status', () => {
    it('charges e checkout', () => {
        expect(mapPagSeguroStatus('PAID')).toBe('PAID');
        expect(mapPagSeguroStatus('AUTHORIZED')).toBe('AUTHORIZED');
        expect(mapPagSeguroStatus('DECLINED')).toBe('FAILED');
        expect(mapPagSeguroStatus('CANCELED')).toBe('CANCELED');
        expect(mapPagSeguroStatus('WAITING')).toBe('PENDING');
        expect(mapPagSeguroStatus('IN_ANALYSIS')).toBe('PENDING');
        expect(mapPagSeguroCharge(fixture('pagseguro/charge-canceled.json'))).toBe('REFUNDED');
        expect(mapPagSeguroCharge({ status: 'PAID', amount: { value: 100, summary: { paid: 100, refunded: 30 } } })).toBe('PARTIALLY_REFUNDED');
        expect(mapPagSeguroCheckoutStatus('EXPIRED')).toBe('EXPIRED');
        expect(mapPagSeguroCheckoutStatus('INACTIVE')).toBe('CANCELED');
    });
});

describe('pagseguro: webhook', () => {
    const body = fixtureText('pagseguro/order-pix-paid.json');
    const sign = (raw: string, token = TOKEN) => createHash('sha256').update(`${token}-${raw}`).digest('hex');

    it('x-authenticity-token válido -> status no próprio evento', async () => {
        const ev = await make(fakeFetch()).parseWebhook({ rawBody: body, headers: { 'X-Authenticity-Token': sign(body) } });
        expect(ev).toMatchObject({ gateway: 'pagseguro', type: 'charge.updated', externalId: ORDER_ID, status: 'PAID', externalReference: 'pay_123' });
        // mesmo corpo -> mesmo eventId (idempotência)
        const again = await make(fakeFetch()).parseWebhook({ rawBody: body, headers: { 'x-authenticity-token': sign(body) } });
        expect(again.eventId).toBe(ev.eventId);
    });

    it('token inválido / corpo alterado / ausente -> WebhookSignatureError', async () => {
        const g = make(fakeFetch());
        await expect(g.parseWebhook({ rawBody: body, headers: {} })).rejects.toBeInstanceOf(WebhookSignatureError);
        await expect(g.parseWebhook({ rawBody: body, headers: { 'x-authenticity-token': sign(body, 'outro') } })).rejects.toBeInstanceOf(
            WebhookSignatureError,
        );
        await expect(g.parseWebhook({ rawBody: body.replace('PAID', 'PAID '), headers: { 'x-authenticity-token': sign(body) } })).rejects.toBeInstanceOf(
            WebhookSignatureError,
        );
    });
});
