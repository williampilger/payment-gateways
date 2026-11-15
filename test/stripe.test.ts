/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Testes do adapter Stripe
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    createStripeGateway,
    mapStripePaymentIntentStatus,
    mapStripeSessionStatus,
    PaymentGatewayError,
    UnsupportedOperationError,
    ValidationError,
    WebhookSignatureError,
} from '../src';
import { baseInput, fakeFetch, fixture, fixtureText } from './helpers';

const SECRET = 'whsec_test_123';
const make = (f: ReturnType<typeof fakeFetch>) =>
    createStripeGateway({ sandbox: true, secretKey: 'sk_test_abc', webhookSecret: SECRET, fetch: f.fetch });

const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')},v0=deadbeef`;

describe('stripe: createCharge', () => {
    it('cria Checkout Session PIX form-encoded com Idempotency-Key', async () => {
        const f = fakeFetch({ body: fixture('stripe/checkout-session-open.json') });
        const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
        const r = await make(f).createCharge(
            baseInput({ expiresAt, returnUrls: { success: 'https://example.com/ok', failure: 'https://example.com/fail' }, metadata: { origem: 'teste' } }),
        );

        const call = f.calls[0];
        expect(call.method).toBe('POST');
        expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
        expect(call.headers.authorization).toBe('Bearer sk_test_abc');
        expect(call.headers['idempotency-key']).toBe('idem-123');
        expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
        const p = new URLSearchParams(call.body);
        expect(p.get('mode')).toBe('payment');
        expect(p.get('payment_method_types[0]')).toBe('pix');
        expect(p.get('client_reference_id')).toBe('pay_123');
        expect(p.get('customer_email')).toBe('cliente@example.com');
        expect(p.get('line_items[0][price_data][currency]')).toBe('brl');
        expect(p.get('line_items[0][price_data][unit_amount]')).toBe('100');
        expect(p.get('line_items[0][price_data][product_data][name]')).toBe('Pedido #123');
        expect(p.get('line_items[0][quantity]')).toBe('1');
        expect(p.get('success_url')).toBe('https://example.com/ok');
        expect(p.get('cancel_url')).toBe('https://example.com/fail');
        expect(p.get('expires_at')).toBe(String(Math.floor(expiresAt.getTime() / 1000)));
        expect(p.get('metadata[externalReference]')).toBe('pay_123');
        expect(p.get('metadata[origem]')).toBe('teste');
        expect(p.get('payment_intent_data[metadata][externalReference]')).toBe('pay_123');
        expect(Number(p.get('payment_method_options[pix][expires_after_seconds]'))).toBeGreaterThan(7000);

        expect(r).toMatchObject({
            gateway: 'stripe',
            externalId: 'cs_test_a1B2c3D4e5',
            status: 'PENDING',
            amountCents: 100,
            externalReference: 'pay_123',
            checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5',
        });
        expect(r.pix).toBeUndefined();
    });

    it('CHECKOUT não fixa payment_method_types; CARD usa card; expires_at é ajustado para >= 30 min', async () => {
        const f = fakeFetch({ body: fixture('stripe/checkout-session-open.json') }, { body: fixture('stripe/checkout-session-open.json') });
        const g = make(f);
        await g.createCharge(baseInput({ method: 'CHECKOUT', returnUrls: { success: 'https://x.com' } }));
        await g.createCharge(baseInput({ method: 'CARD', returnUrls: { success: 'https://x.com' }, expiresAt: new Date(Date.now() + 60_000) }));
        expect(new URLSearchParams(f.calls[0].body).has('payment_method_types[0]')).toBe(false);
        const p = new URLSearchParams(f.calls[1].body);
        expect(p.get('payment_method_types[0]')).toBe('card');
        expect(Number(p.get('expires_at')) - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60);
    });

    it('valida entrada (success_url, método, chave live em sandbox)', async () => {
        const g = make(fakeFetch());
        await expect(g.createCharge(baseInput())).rejects.toBeInstanceOf(ValidationError);
        await expect(g.createCharge(baseInput({ method: 'BOLETO', returnUrls: { success: 'x' } }))).rejects.toBeInstanceOf(UnsupportedOperationError);
        expect(() => createStripeGateway({ sandbox: true, secretKey: 'sk_live_x' })).toThrow(ValidationError);
    });
});

describe('stripe: getCharge / refund / cancel', () => {
    it('getCharge expande payment_intent.latest_charge e mapeia PAID', async () => {
        const f = fakeFetch({ body: fixture('stripe/checkout-session-paid.json') });
        const r = await make(f).getCharge('cs_test_a1B2c3D4e5');
        expect(f.calls[0].url).toBe(
            'https://api.stripe.com/v1/checkout/sessions/cs_test_a1B2c3D4e5?expand%5B%5D=payment_intent.latest_charge',
        );
        expect(r.status).toBe('PAID');
        expect(r.paidAt).toEqual(new Date(1794800000 * 1000));
    });

    it('refund busca a sessão e estorna o payment_intent', async () => {
        const f = fakeFetch({ body: fixture('stripe/checkout-session-paid.json') }, { body: fixture('stripe/refund.json') });
        const r = await make(f).refund({ externalId: 'cs_test_a1B2c3D4e5', amountCents: 50, reason: 'desistência' });
        const call = f.calls[1];
        expect(call.url).toBe('https://api.stripe.com/v1/refunds');
        const p = new URLSearchParams(call.body);
        expect(p.get('payment_intent')).toBe('pi_3Pabc');
        expect(p.get('amount')).toBe('50');
        expect(p.get('metadata[reason]')).toBe('desistência');
        expect(call.headers['idempotency-key']).toBeTruthy();
        expect(r).toMatchObject({ externalRefundId: 're_3Pabc', status: 'DONE', amountCents: 50 });
    });

    it('refund sem pagamento -> ValidationError', async () => {
        const f = fakeFetch({ body: fixture('stripe/checkout-session-open.json') });
        await expect(make(f).refund({ externalId: 'cs_test_a1B2c3D4e5' })).rejects.toBeInstanceOf(ValidationError);
    });

    it('cancelCharge expira a sessão', async () => {
        const f = fakeFetch({ body: { ...fixture('stripe/checkout-session-open.json'), status: 'expired', url: null } });
        const r = await make(f).cancelCharge('cs_test_a1B2c3D4e5');
        expect(f.calls[0]).toMatchObject({ method: 'POST', url: 'https://api.stripe.com/v1/checkout/sessions/cs_test_a1B2c3D4e5/expire' });
        expect(r.status).toBe('EXPIRED');
    });

    it('erro HTTP vira PaymentGatewayError com providerCode', async () => {
        const f = fakeFetch({ status: 404, body: fixture('stripe/error-resource-missing.json') });
        const err = await make(f).getCharge('cs_test_nope').catch((e) => e);
        expect(err).toBeInstanceOf(PaymentGatewayError);
        expect(err).toMatchObject({ gateway: 'stripe', httpStatus: 404, providerCode: 'resource_missing' });
        expect(err.message).toContain('No such checkout.session');
    });
});

describe('stripe: mapeamento de status', () => {
    it('payment intent', () => {
        expect(mapStripePaymentIntentStatus('succeeded')).toBe('PAID');
        expect(mapStripePaymentIntentStatus('requires_capture')).toBe('AUTHORIZED');
        expect(mapStripePaymentIntentStatus('canceled')).toBe('CANCELED');
        expect(mapStripePaymentIntentStatus('processing')).toBe('PENDING');
    });
    it('sessão', () => {
        const paid = fixture('stripe/checkout-session-paid.json');
        expect(mapStripeSessionStatus({ status: 'expired', payment_status: 'unpaid' })).toBe('EXPIRED');
        expect(mapStripeSessionStatus({ status: 'complete', payment_status: 'unpaid' })).toBe('PENDING');
        paid.payment_intent.latest_charge.amount_refunded = 40;
        expect(mapStripeSessionStatus(paid)).toBe('PARTIALLY_REFUNDED');
        paid.payment_intent.latest_charge.refunded = true;
        expect(mapStripeSessionStatus(paid)).toBe('REFUNDED');
        paid.payment_intent.latest_charge.disputed = true;
        expect(mapStripeSessionStatus(paid)).toBe('CHARGEBACK');
    });
});

describe('stripe: webhook', () => {
    const body = fixtureText('stripe/event-checkout-completed.json');

    it('assinatura válida -> evento mapeado', async () => {
        const ev = await make(fakeFetch()).parseWebhook({ rawBody: body, headers: { 'Stripe-Signature': sign(body) } });
        expect(ev).toMatchObject({
            gateway: 'stripe',
            eventId: 'evt_1PxYz',
            type: 'charge.updated',
            externalId: 'cs_test_a1B2c3D4e5',
            status: 'PAID',
            externalReference: 'pay_123',
        });
    });

    it('assinatura inválida, segredo errado, corpo alterado ou timestamp velho -> WebhookSignatureError', async () => {
        const g = make(fakeFetch());
        await expect(g.parseWebhook({ rawBody: body, headers: {} })).rejects.toBeInstanceOf(WebhookSignatureError);
        await expect(g.parseWebhook({ rawBody: body, headers: { 'stripe-signature': sign(body, undefined, 'whsec_outro') } })).rejects.toBeInstanceOf(
            WebhookSignatureError,
        );
        await expect(g.parseWebhook({ rawBody: body + ' ', headers: { 'stripe-signature': sign(body) } })).rejects.toBeInstanceOf(WebhookSignatureError);
        const old = Math.floor(Date.now() / 1000) - 301;
        await expect(g.parseWebhook({ rawBody: body, headers: { 'stripe-signature': sign(body, old) } })).rejects.toThrow(/tolerância/);
        const noSecret = createStripeGateway({ sandbox: true, secretKey: 'sk_test_abc' });
        await expect(noSecret.parseWebhook({ rawBody: body, headers: { 'stripe-signature': sign(body) } })).rejects.toBeInstanceOf(WebhookSignatureError);
    });

    it('mapeia outros eventos', async () => {
        const g = make(fakeFetch());
        const ev = (type: string, object: object) => {
            const raw = JSON.stringify({ id: 'evt_x', type, data: { object } });
            return g.parseWebhook({ rawBody: raw, headers: { 'stripe-signature': sign(raw) } });
        };
        expect((await ev('checkout.session.expired', { id: 'cs_1', client_reference_id: 'r' })).status).toBe('EXPIRED');
        expect((await ev('checkout.session.async_payment_failed', { id: 'cs_1' })).status).toBe('FAILED');
        const pi = await ev('payment_intent.succeeded', { id: 'pi_1', metadata: { externalReference: 'pay_9' } });
        expect(pi).toMatchObject({ status: 'PAID', externalReference: 'pay_9' });
        expect(pi.externalId).toBeUndefined();
        expect((await ev('charge.refunded', { id: 'ch_1', refunded: false, metadata: {} })).status).toBe('PARTIALLY_REFUNDED');
        expect((await ev('charge.refunded', { id: 'ch_1', refunded: true })).status).toBe('REFUNDED');
        expect((await ev('charge.dispute.created', { id: 'dp_1' })).status).toBe('CHARGEBACK');
        expect((await ev('customer.created', { id: 'cus_1' })).type).toBe('unknown');
    });
});
