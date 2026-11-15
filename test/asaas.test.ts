/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Testes do adapter Asaas
 */
import { describe, expect, it } from 'vitest';
import { createAsaasGateway, mapAsaasStatus, PaymentGatewayError, ValidationError, WebhookSignatureError } from '../src';
import { baseInput, fakeFetch, fixture, fixtureText } from './helpers';

const make = (f: ReturnType<typeof fakeFetch>, sandbox = true) =>
    createAsaasGateway({ sandbox, apiKey: '$aact_test', webhookToken: 'wh-token-123', fetch: f.fetch });

describe('asaas: createCharge', () => {
    it('PIX: cria cliente, cria pagamento e busca o QR', async () => {
        const f = fakeFetch(
            { body: fixture('asaas/list-empty.json') }, // GET /customers
            { body: fixture('asaas/customer.json') }, // POST /customers
            { body: fixture('asaas/list-empty.json') }, // GET /payments (idempotência)
            { body: fixture('asaas/payment-pix.json') }, // POST /payments
            { body: fixture('asaas/pix-qrcode.json') }, // GET pixQrCode
        );
        const r = await make(f).createCharge(baseInput({ expiresAt: new Date('2026-11-16T15:00:00Z') }));

        expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
            'GET https://api-sandbox.asaas.com/v3/customers?cpfCnpj=12345678909&limit=1',
            'POST https://api-sandbox.asaas.com/v3/customers',
            'GET https://api-sandbox.asaas.com/v3/payments?externalReference=pay_123&customer=cus_000005219613&limit=20',
            'POST https://api-sandbox.asaas.com/v3/payments',
            'GET https://api-sandbox.asaas.com/v3/payments/pay_080225913252/pixQrCode',
        ]);
        expect(f.calls[0].headers.access_token).toBe('$aact_test');
        expect(f.calls[1].json).toMatchObject({ name: 'Fulano de Tal', cpfCnpj: '12345678909', email: 'cliente@example.com', mobilePhone: '51999999999' });
        expect(f.calls[3].json).toMatchObject({
            customer: 'cus_000005219613',
            billingType: 'PIX',
            value: 1,
            dueDate: '2026-11-16',
            externalReference: 'pay_123',
        });
        expect(r).toMatchObject({
            gateway: 'asaas',
            externalId: 'pay_080225913252',
            status: 'PENDING',
            amountCents: 100,
            externalReference: 'pay_123',
            checkoutUrl: 'https://sandbox.asaas.com/i/080225913252',
            pix: { qrCodeBase64: 'iVBORw0KGgoAAAANSUhEUgAAAYsAAAGL' },
        });
        expect(r.pix?.copiaECola).toMatch(/^000201/);
    });

    it('reaproveita pagamento PENDENTE igual (idempotência) e cliente existente', async () => {
        const f = fakeFetch(
            { body: { data: [fixture('asaas/customer.json')] } },
            { body: { data: [fixture('asaas/payment-pix.json')] } },
            { body: fixture('asaas/pix-qrcode.json') },
        );
        const r = await make(f, false).createCharge(baseInput());
        expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
        expect(f.calls[0].url.startsWith('https://api.asaas.com/v3/')).toBe(true);
        expect(r.externalId).toBe('pay_080225913252');
    });

    it('CHECKOUT -> billingType UNDEFINED e invoiceUrl', async () => {
        const f = fakeFetch(
            { body: { data: [fixture('asaas/customer.json')] } },
            { body: fixture('asaas/list-empty.json') },
            { body: { ...fixture('asaas/payment-pix.json'), billingType: 'UNDEFINED' } },
        );
        const r = await make(f).createCharge(baseInput({ method: 'CHECKOUT' }));
        expect(f.calls[2].json.billingType).toBe('UNDEFINED');
        expect(r.checkoutUrl).toBe('https://sandbox.asaas.com/i/080225913252');
        expect(r.pix).toBeUndefined();
    });

    it('exige CPF', async () => {
        await expect(make(fakeFetch()).createCharge(baseInput({ customer: { name: 'A', email: 'a@b.c' } }))).rejects.toBeInstanceOf(ValidationError);
    });

    it('erro 400 -> PaymentGatewayError com code', async () => {
        const f = fakeFetch({ status: 400, body: fixture('asaas/error-invalid.json') });
        const err = await make(f).createCharge(baseInput()).catch((e) => e);
        expect(err).toBeInstanceOf(PaymentGatewayError);
        expect(err).toMatchObject({ httpStatus: 400, providerCode: 'invalid_cpfCnpj' });
    });
});

describe('asaas: getCharge / refund / cancel', () => {
    it('pagamento recebido -> PAID (sem buscar QR)', async () => {
        const f = fakeFetch({ body: fixture('asaas/payment-received.json') });
        const r = await make(f).getCharge('pay_080225913252');
        expect(f.calls).toHaveLength(1);
        expect(r.status).toBe('PAID');
        expect(r.paidAt).toBeInstanceOf(Date);
    });

    it('refund parcial', async () => {
        const f = fakeFetch({ body: fixture('asaas/refund.json') });
        const r = await make(f).refund({ externalId: 'pay_080225913252', amountCents: 50, reason: 'Cliente desistiu' });
        expect(f.calls[0]).toMatchObject({
            method: 'POST',
            url: 'https://api-sandbox.asaas.com/v3/payments/pay_080225913252/refund',
            json: { value: 0.5, description: 'Cliente desistiu' },
        });
        expect(r).toMatchObject({ externalRefundId: 'rf_9f6d7a8b', status: 'DONE', amountCents: 50 });
    });

    it('cancel -> DELETE /payments/{id}', async () => {
        const f = fakeFetch({ body: fixture('asaas/payment-pix.json') }, { body: { deleted: true, id: 'pay_080225913252' } });
        const r = await make(f).cancelCharge('pay_080225913252');
        expect(f.calls[1]).toMatchObject({ method: 'DELETE', url: 'https://api-sandbox.asaas.com/v3/payments/pay_080225913252' });
        expect(r.status).toBe('CANCELED');
    });
});

describe('asaas: status', () => {
    it.each([
        ['PENDING', 'PENDING'],
        ['RECEIVED', 'PAID'],
        ['CONFIRMED', 'PAID'],
        ['RECEIVED_IN_CASH', 'PAID'],
        ['OVERDUE', 'EXPIRED'],
        ['REFUNDED', 'REFUNDED'],
        ['REFUND_REQUESTED', 'REFUNDED'],
        ['CHARGEBACK_REQUESTED', 'CHARGEBACK'],
        ['CHARGEBACK_DISPUTE', 'CHARGEBACK'],
        ['DELETED', 'CANCELED'],
    ])('%s -> %s', (s, expected) => expect(mapAsaasStatus(s)).toBe(expected));
});

describe('asaas: webhook', () => {
    const body = fixtureText('asaas/webhook-payment-received.json');

    it('token válido', async () => {
        const ev = await make(fakeFetch()).parseWebhook({ rawBody: body, headers: { 'Asaas-Access-Token': 'wh-token-123' } });
        expect(ev).toMatchObject({
            gateway: 'asaas',
            eventId: 'evt_05b708f961d739ea7eba7e4db318f621&368604920',
            type: 'charge.updated',
            externalId: 'pay_080225913252',
            status: 'PAID',
            externalReference: 'pay_123',
        });
    });

    it('PAYMENT_DELETED -> CANCELED; evento não-pagamento -> unknown', async () => {
        const g = make(fakeFetch());
        const del = JSON.stringify({ id: 'evt_1', event: 'PAYMENT_DELETED', payment: { id: 'pay_1', status: 'PENDING', deleted: true } });
        expect((await g.parseWebhook({ rawBody: del, headers: { 'asaas-access-token': 'wh-token-123' } })).status).toBe('CANCELED');
        const other = JSON.stringify({ id: 'evt_2', event: 'TRANSFER_DONE', transfer: {} });
        expect((await g.parseWebhook({ rawBody: other, headers: { 'asaas-access-token': 'wh-token-123' } })).type).toBe('unknown');
    });

    it('token inválido/ausente/não configurado -> WebhookSignatureError', async () => {
        const g = make(fakeFetch());
        await expect(g.parseWebhook({ rawBody: body, headers: {} })).rejects.toBeInstanceOf(WebhookSignatureError);
        await expect(g.parseWebhook({ rawBody: body, headers: { 'asaas-access-token': 'wh-token-12' } })).rejects.toBeInstanceOf(WebhookSignatureError);
        const noToken = createAsaasGateway({ sandbox: true, apiKey: 'x' });
        await expect(noToken.parseWebhook({ rawBody: body, headers: { 'asaas-access-token': 'wh-token-123' } })).rejects.toBeInstanceOf(
            WebhookSignatureError,
        );
    });
});
