/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Adapter Stripe (Checkout Sessions)
 *
 * - API: https://api.stripe.com/v1 — corpo form-urlencoded, `Authorization: Bearer <secretKey>`, `Idempotency-Key`.
 * - Sandbox = chave `sk_test_...` (mesma URL). Com `sandbox: true` uma chave live é recusada.
 * - CHECKOUT/CARD/PIX criam uma Checkout Session (página hospedada); o QR do PIX é exibido pela própria Stripe,
 *   então `ChargeResult.pix` NÃO é preenchido — use `checkoutUrl`.
 * - `externalId` = id da sessão (`cs_...`). Cancelar = expirar a sessão (status vira EXPIRED).
 * - `expires_at` da sessão precisa ficar entre 30 min e 24 h a partir de agora: valores fora disso são ajustados.
 * - Webhook: `Stripe-Signature: t=...,v1=...` = HMAC-SHA256(`${t}.${rawBody}`, webhookSecret), tolerância 300 s.
 */
import { ValidationError, WebhookSignatureError } from '../core/errors';
import { createHttpClient, encodeForm } from '../core/http';
import type {
    BaseGatewayConfig,
    ChargeResult,
    ChargeStatus,
    CreateChargeInput,
    GatewayCapabilities,
    PaymentGateway,
    RefundInput,
    RefundResult,
    WebhookEvent,
    WebhookRequest,
} from '../core/types';
import {
    assertExternalId,
    assertRefundAmount,
    chargeItems,
    hmacSha256Hex,
    lowerHeaders,
    newUuid,
    parseJsonBody,
    safeEqual,
    unixToDate,
    validateChargeInput,
} from '../core/util';

export interface StripeConfig extends BaseGatewayConfig {
    /** sk_test_... / sk_live_... (ou rk_ restrita) */
    secretKey: string;
    /** whsec_... (obrigatório para `parseWebhook`) */
    webhookSecret?: string;
    /** Tolerância da assinatura do webhook. Padrão: 300 s */
    webhookToleranceSec?: number;
    /** Fixa `Stripe-Version` (opcional; padrão = versão da conta) */
    apiVersion?: string;
    /** Sobrescreve a URL base (testes/proxy). Padrão: https://api.stripe.com */
    baseUrl?: string;
}

export const STRIPE_BASE_URL = 'https://api.stripe.com';

const CAPABILITIES: GatewayCapabilities = {
    methods: ['CHECKOUT', 'CARD', 'PIX'],
    refund: true,
    partialRefund: true,
    cancel: true,
    webhooks: true,
};

const MIN_EXPIRES_SEC = 30 * 60 + 60; // 30 min (+ folga)
const MAX_EXPIRES_SEC = 24 * 60 * 60 - 60; // 24 h (- folga)

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);

/** Status de PaymentIntent -> ChargeStatus */
export function mapStripePaymentIntentStatus(status: unknown): ChargeStatus {
    switch (status) {
        case 'succeeded':
            return 'PAID';
        case 'requires_capture':
            return 'AUTHORIZED';
        case 'canceled':
            return 'CANCELED';
        default: // requires_payment_method, requires_confirmation, requires_action, processing
            return 'PENDING';
    }
}

/** Sessão (com payment_intent.latest_charge expandido, quando houver) -> ChargeStatus */
export function mapStripeSessionStatus(session: Obj): ChargeStatus {
    const pi = obj(session.payment_intent);
    const charge = obj(pi?.latest_charge);
    if (charge) {
        if (charge.disputed === true) return 'CHARGEBACK';
        if (charge.refunded === true) return 'REFUNDED';
        if (typeof charge.amount_refunded === 'number' && charge.amount_refunded > 0) return 'PARTIALLY_REFUNDED';
    }
    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') return 'PAID';
    if (session.status === 'expired') return 'EXPIRED';
    if (pi) return mapStripePaymentIntentStatus(pi.status);
    return 'PENDING';
}

export function createStripeGateway(config: StripeConfig): PaymentGateway {
    const gateway = 'stripe';
    if (!config?.secretKey) throw new ValidationError('stripe: secretKey é obrigatório', 'secretKey');
    if (config.sandbox && /_live_/.test(config.secretKey)) {
        throw new ValidationError('stripe: sandbox=true com chave LIVE', 'secretKey');
    }

    const http = createHttpClient({
        gateway,
        baseUrl: config.baseUrl ?? STRIPE_BASE_URL,
        headers: {
            Authorization: `Bearer ${config.secretKey}`,
            ...(config.apiVersion ? { 'Stripe-Version': config.apiVersion } : {}),
        },
        fetch: config.fetch,
        timeoutMs: config.timeoutMs,
        parseError: (b) => {
            const e = obj(obj(b)?.error);
            return e ? { message: e.message as string | undefined, code: (e.code ?? e.decline_code ?? e.type) as string | undefined } : undefined;
        },
    });

    const toResult = (s: Obj): ChargeResult => {
        const status = mapStripeSessionStatus(s);
        const pi = obj(s.payment_intent);
        const charge = obj(pi?.latest_charge);
        return {
            gateway,
            externalId: String(s.id),
            status,
            amountCents: typeof s.amount_total === 'number' ? s.amount_total : 0,
            externalReference: (s.client_reference_id as string | null) ?? (obj(s.metadata)?.externalReference as string | undefined) ?? undefined,
            checkoutUrl: typeof s.url === 'string' ? s.url : undefined,
            expiresAt: unixToDate(s.expires_at),
            paidAt: status === 'PAID' || status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED' ? unixToDate(charge?.created) : undefined,
            raw: s,
        };
    };

    const retrieveSession = (id: string) =>
        http<Obj>({
            path: `/v1/checkout/sessions/${encodeURIComponent(id)}`,
            query: { 'expand[]': ['payment_intent.latest_charge'] },
        });

    return {
        id: gateway,
        capabilities: CAPABILITIES,

        async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
            validateChargeInput(gateway, CAPABILITIES, input, { currencies: ['BRL', 'USD', 'EUR'] });
            if (!input.returnUrls?.success) throw new ValidationError('stripe: returnUrls.success é obrigatório', 'returnUrls.success');
            const currency = (input.currency ?? 'BRL').toLowerCase();
            const meta = { ...(input.metadata ?? {}), externalReference: input.externalReference };

            let expiresAt: number | undefined;
            if (input.expiresAt) {
                const now = Math.floor(Date.now() / 1000);
                const wanted = Math.floor(input.expiresAt.getTime() / 1000);
                expiresAt = Math.min(Math.max(wanted, now + MIN_EXPIRES_SEC), now + MAX_EXPIRES_SEC);
            }

            const params: Obj = {
                mode: 'payment',
                client_reference_id: input.externalReference,
                customer_email: input.customer.email,
                line_items: chargeItems(input).map((it) => ({
                    quantity: it.quantity,
                    price_data: { currency, unit_amount: it.unitAmountCents, product_data: { name: it.title } },
                })),
                payment_method_types: input.method === 'CARD' ? ['card'] : input.method === 'PIX' ? ['pix'] : undefined,
                payment_method_options:
                    input.method === 'PIX' && expiresAt
                        ? { pix: { expires_after_seconds: Math.max(10, expiresAt - Math.floor(Date.now() / 1000)) } }
                        : undefined,
                success_url: input.returnUrls.success,
                cancel_url: input.returnUrls.failure,
                expires_at: expiresAt,
                metadata: meta,
                payment_intent_data: { description: input.description, metadata: meta },
            };

            const session = await http<Obj>({
                method: 'POST',
                path: '/v1/checkout/sessions',
                form: encodeForm(params),
                headers: { 'Idempotency-Key': input.idempotencyKey },
            });
            return toResult(session);
        },

        async getCharge(externalId: string): Promise<ChargeResult> {
            assertExternalId(externalId);
            return toResult(await retrieveSession(externalId));
        },

        async cancelCharge(externalId: string): Promise<ChargeResult> {
            assertExternalId(externalId);
            const s = await http<Obj>({ method: 'POST', path: `/v1/checkout/sessions/${encodeURIComponent(externalId)}/expire` });
            return toResult(s);
        },

        async refund(input: RefundInput): Promise<RefundResult> {
            assertExternalId(input.externalId);
            assertRefundAmount(input.amountCents);
            const session = await retrieveSession(input.externalId);
            const pi = session.payment_intent;
            const piId = typeof pi === 'string' ? pi : (obj(pi)?.id as string | undefined);
            if (!piId) throw new ValidationError('stripe: sessão sem pagamento para estornar', 'externalId');

            const r = await http<Obj>({
                method: 'POST',
                path: '/v1/refunds',
                form: encodeForm({
                    payment_intent: piId,
                    amount: input.amountCents,
                    metadata: input.reason ? { reason: input.reason } : undefined,
                }),
                headers: { 'Idempotency-Key': newUuid() },
            });
            return {
                externalRefundId: String(r.id),
                status: r.status === 'succeeded' ? 'DONE' : r.status === 'failed' || r.status === 'canceled' ? 'FAILED' : 'PENDING',
                amountCents: typeof r.amount === 'number' ? r.amount : (input.amountCents ?? 0),
                raw: r,
            };
        },

        async parseWebhook(req: WebhookRequest): Promise<WebhookEvent> {
            if (!config.webhookSecret) throw new WebhookSignatureError(gateway, 'stripe: webhookSecret não configurado');
            const header = lowerHeaders(req.headers)['stripe-signature'];
            if (!header) throw new WebhookSignatureError(gateway, 'stripe: cabeçalho Stripe-Signature ausente');

            let t: string | undefined;
            const v1: string[] = [];
            for (const part of header.split(',')) {
                const [k, v] = part.trim().split('=', 2);
                if (k === 't') t = v;
                else if (k === 'v1' && v) v1.push(v);
            }
            if (!t || !/^\d+$/.test(t) || !v1.length) throw new WebhookSignatureError(gateway, 'stripe: Stripe-Signature malformado');

            const expected = hmacSha256Hex(config.webhookSecret, `${t}.${req.rawBody}`);
            if (!v1.some((sig) => safeEqual(sig, expected))) throw new WebhookSignatureError(gateway, 'stripe: assinatura inválida');

            const tolerance = config.webhookToleranceSec ?? 300;
            if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > tolerance) {
                throw new WebhookSignatureError(gateway, 'stripe: timestamp fora da tolerância (possível replay)');
            }

            const event = parseJsonBody(gateway, req.rawBody);
            const o = obj(obj(event.data)?.object) ?? {};
            const meta = obj(o.metadata);
            const base = { gateway, eventId: String(event.id ?? ''), raw: event } as const;
            const type = String(event.type ?? '');

            const session = (status: ChargeStatus): WebhookEvent => ({
                ...base,
                type: 'charge.updated',
                externalId: o.id as string | undefined,
                status,
                externalReference: (o.client_reference_id as string | undefined) ?? (meta?.externalReference as string | undefined),
            });
            const byReference = (status: ChargeStatus): WebhookEvent => ({
                ...base,
                type: 'charge.updated',
                status,
                externalReference: meta?.externalReference as string | undefined,
            });

            switch (type) {
                case 'checkout.session.completed':
                    return session(o.payment_status === 'paid' || o.payment_status === 'no_payment_required' ? 'PAID' : 'PENDING');
                case 'checkout.session.async_payment_succeeded':
                    return session('PAID');
                case 'checkout.session.async_payment_failed':
                    return session('FAILED');
                case 'checkout.session.expired':
                    return session('EXPIRED');
                case 'payment_intent.succeeded':
                    return byReference('PAID');
                case 'payment_intent.amount_capturable_updated':
                    return byReference('AUTHORIZED');
                case 'payment_intent.payment_failed':
                    return byReference('FAILED');
                case 'payment_intent.canceled':
                    return byReference('CANCELED');
                case 'payment_intent.processing':
                    return byReference('PENDING');
                case 'charge.refunded':
                    return byReference(o.refunded === true ? 'REFUNDED' : 'PARTIALLY_REFUNDED');
                case 'charge.dispute.created':
                    return { ...base, type: 'charge.updated', status: 'CHARGEBACK' };
                default:
                    return { ...base, type: 'unknown' };
            }
        },
    };
}
