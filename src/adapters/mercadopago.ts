/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Adapter Mercado Pago (Pagamentos PIX + Checkout Pro)
 *
 * - API: https://api.mercadopago.com — JSON, `Authorization: Bearer <accessToken>`, `X-Idempotency-Key`.
 * - Sandbox = credenciais de teste (mesma URL); `sandbox: true` só troca `init_point` por `sandbox_init_point`.
 * - PIX: `POST /v1/payments` (payment_method_id=pix) -> QR em point_of_interaction.transaction_data.
 *   `externalId` = id NUMÉRICO do pagamento.
 * - CHECKOUT/CARD: `POST /checkout/preferences` (Checkout Pro). `externalId` = id da PREFERÊNCIA; o pagamento só
 *   existe depois que o pagador paga. `getCharge(prefId)` busca os pagamentos por external_reference.
 * - Webhook: manda SÓ o id (`data.id`), sem status -> `parseWebhook` devolve `externalId` (id do pagamento) e o
 *   consumidor chama `getCharge` (ou usa `registry.resolveWebhook`). Assinatura: cabeçalho `x-signature`
 *   (ts=...,v1=...) = HMAC-SHA256 do manifesto `id:{data.id};request-id:{x-request-id};ts:{ts};` com a chave secreta.
 */
import { ValidationError, WebhookSignatureError } from '../core/errors';
import { createHttpClient } from '../core/http';
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
    centsToDecimal,
    chargeItems,
    decimalToCents,
    hmacSha256Hex,
    lowerHeaders,
    newUuid,
    onlyDigits,
    parseDate,
    parseJsonBody,
    safeEqual,
    splitName,
    str,
    toSaoPauloIso,
    validateChargeInput,
} from '../core/util';

export interface MercadoPagoConfig extends BaseGatewayConfig {
    /** Access Token (TEST-... ou APP_USR-...) */
    accessToken: string;
    /** "Assinatura secreta" da tela de Webhooks (obrigatória para `parseWebhook`) */
    webhookSecret?: string;
    /** Padrão: https://api.mercadopago.com */
    baseUrl?: string;
}

export const MERCADOPAGO_BASE_URL = 'https://api.mercadopago.com';

const CAPABILITIES: GatewayCapabilities = {
    methods: ['PIX', 'CHECKOUT', 'CARD'],
    refund: true,
    partialRefund: true,
    cancel: true,
    webhooks: true,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);

/** Pagamentos têm id numérico; preferências têm "<collector>-<uuid>" */
const isPaymentId = (id: string) => /^\d+$/.test(id);

/** status (+ status_detail) do pagamento -> ChargeStatus */
export function mapMercadoPagoStatus(status: unknown, statusDetail?: unknown): ChargeStatus {
    switch (status) {
        case 'approved':
            return statusDetail === 'partially_refunded' ? 'PARTIALLY_REFUNDED' : 'PAID';
        case 'authorized':
            return 'AUTHORIZED';
        case 'pending':
        case 'in_process':
            return 'PENDING';
        case 'rejected':
            return 'FAILED';
        case 'cancelled':
            return statusDetail === 'expired' ? 'EXPIRED' : 'CANCELED';
        case 'refunded':
            return 'REFUNDED';
        case 'charged_back':
        case 'in_mediation': // disputa aberta pelo comprador
            return 'CHARGEBACK';
        default:
            return 'PENDING';
    }
}

/** Prioridade ao escolher o pagamento "que vale" entre vários da mesma preferência */
const STATUS_RANK: Record<string, number> = {
    charged_back: 9, in_mediation: 8, refunded: 7, approved: 6, authorized: 5, in_process: 4, pending: 3, rejected: 1, cancelled: 0,
};

export function createMercadoPagoGateway(config: MercadoPagoConfig): PaymentGateway {
    const gateway = 'mercadopago';
    if (!config?.accessToken) throw new ValidationError('mercadopago: accessToken é obrigatório', 'accessToken');

    const http = createHttpClient({
        gateway,
        baseUrl: config.baseUrl ?? MERCADOPAGO_BASE_URL,
        headers: { Authorization: `Bearer ${config.accessToken}` },
        fetch: config.fetch,
        timeoutMs: config.timeoutMs,
        parseError: (b) => {
            const o = obj(b);
            if (!o) return undefined;
            const cause = Array.isArray(o.cause) ? obj(o.cause[0]) : undefined;
            return { message: str(o.message) ?? str(cause?.description), code: str(cause?.code) ?? str(o.error) };
        },
    });

    const paymentToResult = (p: Obj, externalId?: string): ChargeResult => {
        const td = obj(obj(p.point_of_interaction)?.transaction_data);
        const status = mapMercadoPagoStatus(p.status, p.status_detail);
        return {
            gateway,
            externalId: externalId ?? String(p.id),
            status,
            amountCents: decimalToCents(p.transaction_amount as number),
            externalReference: str(p.external_reference),
            checkoutUrl: str(td?.ticket_url),
            pix: td?.qr_code ? { copiaECola: String(td.qr_code), qrCodeBase64: str(td.qr_code_base64) } : undefined,
            expiresAt: parseDate(p.date_of_expiration),
            paidAt: parseDate(p.date_approved),
            raw: p,
        };
    };

    const getPayment = (id: string) => http<Obj>({ path: `/v1/payments/${encodeURIComponent(id)}` });

    /** Preferência -> pagamento mais relevante com o mesmo external_reference */
    const findPreferencePayment = async (prefId: string) => {
        const pref = await http<Obj>({ path: `/checkout/preferences/${encodeURIComponent(prefId)}` });
        const ref = str(pref.external_reference);
        let payment: Obj | undefined;
        if (ref) {
            const search = await http<Obj>({
                path: '/v1/payments/search',
                query: { external_reference: ref, sort: 'date_created', criteria: 'desc' },
            });
            const results = (Array.isArray(search.results) ? search.results : []).map(obj).filter((x): x is Obj => !!x);
            payment = results.sort((a, b) => (STATUS_RANK[String(b.status)] ?? 2) - (STATUS_RANK[String(a.status)] ?? 2))[0];
        }
        return { pref, payment };
    };

    const prefResult = (pref: Obj, status: ChargeStatus, amountCents?: number): ChargeResult => ({
        gateway,
        externalId: String(pref.id),
        status,
        amountCents:
            amountCents ??
            (Array.isArray(pref.items)
                ? pref.items.reduce((s: number, it) => s + decimalToCents(obj(it)?.unit_price as number) * Number(obj(it)?.quantity ?? 1), 0)
                : 0),
        externalReference: str(pref.external_reference),
        checkoutUrl: str(config.sandbox ? pref.sandbox_init_point : pref.init_point) ?? str(pref.init_point),
        expiresAt: pref.expires ? parseDate(pref.expiration_date_to) : undefined,
        raw: pref,
    });

    return {
        id: gateway,
        capabilities: CAPABILITIES,

        async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
            validateChargeInput(gateway, CAPABILITIES, input);
            const doc = onlyDigits(input.customer.cpf);
            const identification = doc ? { type: doc.length === 14 ? 'CNPJ' : 'CPF', number: doc } : undefined;
            const name = splitName(input.customer.name);
            const items = chargeItems(input).map((it) => ({
                id: it.id,
                title: it.title,
                quantity: it.quantity,
                unit_price: centsToDecimal(it.unitAmountCents),
                currency_id: 'BRL',
            }));

            if (input.method === 'PIX') {
                const p = await http<Obj>({
                    method: 'POST',
                    path: '/v1/payments',
                    headers: { 'X-Idempotency-Key': input.idempotencyKey },
                    json: {
                        transaction_amount: centsToDecimal(input.amountCents),
                        description: input.description,
                        payment_method_id: 'pix',
                        payer: { email: input.customer.email, first_name: name.first, last_name: name.last || undefined, identification },
                        external_reference: input.externalReference,
                        notification_url: input.notificationUrl,
                        date_of_expiration: input.expiresAt ? toSaoPauloIso(input.expiresAt) : undefined,
                        metadata: input.metadata,
                        additional_info: { items: items.map(({ currency_id: _c, ...it }) => it) },
                    },
                });
                return paymentToResult(p);
            }

            // CHECKOUT / CARD -> Checkout Pro
            const pref = await http<Obj>({
                method: 'POST',
                path: '/checkout/preferences',
                json: {
                    items,
                    payer: { name: name.first, surname: name.last || undefined, email: input.customer.email, identification },
                    back_urls: input.returnUrls
                        ? { success: input.returnUrls.success, failure: input.returnUrls.failure, pending: input.returnUrls.pending }
                        : undefined,
                    auto_return: input.returnUrls?.success ? 'approved' : undefined,
                    external_reference: input.externalReference,
                    notification_url: input.notificationUrl,
                    metadata: input.metadata,
                    expires: input.expiresAt ? true : undefined,
                    expiration_date_from: input.expiresAt ? toSaoPauloIso(new Date()) : undefined,
                    expiration_date_to: input.expiresAt ? toSaoPauloIso(input.expiresAt) : undefined,
                    payment_methods:
                        input.method === 'CARD'
                            ? { excluded_payment_types: [{ id: 'ticket' }, { id: 'bank_transfer' }, { id: 'atm' }] }
                            : undefined,
                },
            });
            return prefResult(pref, 'PENDING', input.amountCents);
        },

        async getCharge(externalId: string): Promise<ChargeResult> {
            assertExternalId(externalId);
            if (isPaymentId(externalId)) return paymentToResult(await getPayment(externalId));

            const { pref, payment } = await findPreferencePayment(externalId);
            if (payment) return { ...paymentToResult(payment, String(pref.id)), checkoutUrl: prefResult(pref, 'PENDING').checkoutUrl, raw: { preference: pref, payment } };
            const expired = pref.expires === true && (parseDate(pref.expiration_date_to)?.getTime() ?? Infinity) < Date.now();
            return prefResult(pref, expired ? 'EXPIRED' : 'PENDING');
        },

        async cancelCharge(externalId: string): Promise<ChargeResult> {
            assertExternalId(externalId);
            if (isPaymentId(externalId)) {
                const p = await http<Obj>({ method: 'PUT', path: `/v1/payments/${encodeURIComponent(externalId)}`, json: { status: 'cancelled' } });
                return paymentToResult(p);
            }
            // Preferência: expira agora (pagamentos já feitos NÃO são afetados)
            const pref = await http<Obj>({
                method: 'PUT',
                path: `/checkout/preferences/${encodeURIComponent(externalId)}`,
                json: { expires: true, expiration_date_to: toSaoPauloIso(new Date()) },
            });
            return prefResult(pref, 'CANCELED');
        },

        async refund(input: RefundInput): Promise<RefundResult> {
            assertExternalId(input.externalId);
            assertRefundAmount(input.amountCents);
            let paymentId = input.externalId;
            if (!isPaymentId(paymentId)) {
                const { payment } = await findPreferencePayment(paymentId);
                if (!payment?.id) throw new ValidationError('mercadopago: preferência sem pagamento para estornar', 'externalId');
                paymentId = String(payment.id);
            }
            const r = await http<Obj>({
                method: 'POST',
                path: `/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
                headers: { 'X-Idempotency-Key': newUuid() },
                json: input.amountCents !== undefined ? { amount: centsToDecimal(input.amountCents) } : {},
            });
            return {
                externalRefundId: String(r.id),
                status: r.status === 'approved' ? 'DONE' : r.status === 'rejected' || r.status === 'cancelled' ? 'FAILED' : 'PENDING',
                amountCents: decimalToCents(r.amount as number),
                raw: r,
            };
        },

        async parseWebhook(req: WebhookRequest): Promise<WebhookEvent> {
            if (!config.webhookSecret) throw new WebhookSignatureError(gateway, 'mercadopago: webhookSecret não configurado');
            const headers = lowerHeaders(req.headers);
            const sig = headers['x-signature'];
            if (!sig) throw new WebhookSignatureError(gateway, 'mercadopago: cabeçalho x-signature ausente');

            let ts: string | undefined;
            let v1: string | undefined;
            for (const part of sig.split(',')) {
                const [k, v] = part.trim().split('=', 2);
                if (k === 'ts') ts = v;
                else if (k === 'v1') v1 = v;
            }
            if (!ts || !v1) throw new WebhookSignatureError(gateway, 'mercadopago: x-signature malformado');

            const body = parseJsonBody(gateway, req.rawBody);
            const rawDataId = req.query?.['data.id'] ?? str(obj(body.data)?.id);
            // Docs: se o id for alfanumérico, usar em minúsculas no manifesto
            const dataId = rawDataId && /^[a-z0-9]+$/i.test(rawDataId) ? rawDataId.toLowerCase() : rawDataId;
            const requestId = headers['x-request-id'];

            // Partes ausentes são removidas do manifesto (conforme a documentação)
            const manifest =
                (dataId ? `id:${dataId};` : '') + (requestId ? `request-id:${requestId};` : '') + `ts:${ts};`;
            if (!safeEqual(v1, hmacSha256Hex(config.webhookSecret, manifest))) {
                throw new WebhookSignatureError(gateway, 'mercadopago: assinatura inválida');
            }

            const topic = str(body.type) ?? req.query?.type ?? req.query?.topic;
            const eventId = str(body.id) ?? `${topic ?? 'unknown'}:${rawDataId ?? ''}:${ts}`;
            if (topic === 'payment' && rawDataId) {
                return { gateway, eventId, type: 'charge.updated', externalId: rawDataId, raw: body };
            }
            return { gateway, eventId, type: 'unknown', externalId: rawDataId, raw: body };
        },
    };
}
