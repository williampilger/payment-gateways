/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Adapter Asaas (API v3)
 *
 * - API: https://api.asaas.com/v3 (sandbox: https://api-sandbox.asaas.com/v3) — JSON, cabeçalho `access_token`.
 * - Toda cobrança precisa de um cliente Asaas: buscamos por CPF (`GET /customers?cpfCnpj=`) ou criamos. CPF obrigatório.
 * - `POST /payments` com billingType PIX | BOLETO | CREDIT_CARD | UNDEFINED (CHECKOUT = UNDEFINED; o pagador
 *   escolhe na `invoiceUrl`). PIX: QR em `GET /payments/{id}/pixQrCode`; BOLETO: linha digitável em
 *   `GET /payments/{id}/identificationField`.
 * - ⚠️ O Asaas NÃO tem chave de idempotência: antes de criar, procuramos um pagamento PENDENTE com o mesmo
 *   externalReference, valor e billingType e reaproveitamos (evita duplicar em retry).
 * - `dueDate`: data (São Paulo) de `expiresAt`, ou amanhã. OVERDUE (vencido) -> EXPIRED.
 * - Webhook: cabeçalho `asaas-access-token` igual ao token configurado no painel (comparação em tempo constante).
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
    PaymentMethod,
    RefundInput,
    RefundResult,
    WebhookEvent,
    WebhookRequest,
} from '../core/types';
import {
    assertExternalId,
    assertRefundAmount,
    centsToDecimal,
    decimalToCents,
    lowerHeaders,
    onlyDigits,
    parseDate,
    parseJsonBody,
    safeEqual,
    str,
    toSaoPauloDate,
    validateChargeInput,
} from '../core/util';

export interface AsaasConfig extends BaseGatewayConfig {
    /** Chave de API ($aact_...) */
    apiKey: string;
    /** Token definido na configuração do webhook no painel (obrigatório para `parseWebhook`) */
    webhookToken?: string;
    /** Sobrescreve a URL base */
    baseUrl?: string;
}

export const ASAAS_BASE_URL = 'https://api.asaas.com/v3';
export const ASAAS_SANDBOX_BASE_URL = 'https://api-sandbox.asaas.com/v3';

const CAPABILITIES: GatewayCapabilities = {
    methods: ['PIX', 'BOLETO', 'CARD', 'CHECKOUT'],
    refund: true,
    partialRefund: true,
    cancel: true,
    webhooks: true,
};

const BILLING_TYPE: Partial<Record<PaymentMethod, string>> = {
    PIX: 'PIX',
    BOLETO: 'BOLETO',
    CARD: 'CREDIT_CARD',
    CHECKOUT: 'UNDEFINED',
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const list = (v: unknown): Obj[] => (Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]).map(obj).filter((x): x is Obj => !!x) : []);

/** Status do pagamento Asaas -> ChargeStatus */
export function mapAsaasStatus(status: unknown): ChargeStatus {
    switch (status) {
        case 'RECEIVED':
        case 'CONFIRMED':
        case 'RECEIVED_IN_CASH':
        case 'DUNNING_RECEIVED':
            return 'PAID';
        case 'AUTHORIZED':
            return 'AUTHORIZED';
        case 'OVERDUE':
            return 'EXPIRED';
        case 'REFUNDED':
        case 'REFUND_REQUESTED':
        case 'REFUND_IN_PROGRESS':
            return 'REFUNDED';
        case 'CHARGEBACK_REQUESTED':
        case 'CHARGEBACK_DISPUTE':
        case 'AWAITING_CHARGEBACK_REVERSAL':
            return 'CHARGEBACK';
        case 'DELETED':
            return 'CANCELED';
        case 'PENDING':
        case 'AWAITING_RISK_ANALYSIS':
        case 'DUNNING_REQUESTED':
        default:
            return 'PENDING';
    }
}

/** Eventos de webhook que mudam o status sem refletir em `payment.status` */
const EVENT_STATUS: Record<string, ChargeStatus> = {
    PAYMENT_DELETED: 'CANCELED',
    PAYMENT_REFUNDED: 'REFUNDED',
    PAYMENT_PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
    PAYMENT_REPROVED_BY_RISK_ANALYSIS: 'FAILED',
    PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: 'FAILED',
};

const mapPayment = (p: Obj): ChargeStatus => (p.deleted === true ? 'CANCELED' : mapAsaasStatus(p.status));

export function createAsaasGateway(config: AsaasConfig): PaymentGateway {
    const gateway = 'asaas';
    if (!config?.apiKey) throw new ValidationError('asaas: apiKey é obrigatório', 'apiKey');

    const http = createHttpClient({
        gateway,
        baseUrl: config.baseUrl ?? (config.sandbox ? ASAAS_SANDBOX_BASE_URL : ASAAS_BASE_URL),
        headers: { access_token: config.apiKey, 'User-Agent': 'payment-gateways' },
        fetch: config.fetch,
        timeoutMs: config.timeoutMs,
        parseError: (b) => {
            const e = Array.isArray(obj(b)?.errors) ? obj((obj(b)!.errors as unknown[])[0]) : undefined;
            return e ? { message: str(e.description), code: str(e.code) } : undefined;
        },
    });

    const toResult = (p: Obj, extra: Partial<ChargeResult> = {}): ChargeResult => {
        const status = mapPayment(p);
        return {
            gateway,
            externalId: String(p.id),
            status,
            amountCents: decimalToCents(p.value as number),
            externalReference: str(p.externalReference),
            checkoutUrl: str(p.invoiceUrl),
            boletoUrl: p.billingType === 'BOLETO' ? str(p.bankSlipUrl) : undefined,
            expiresAt: parseDate(p.dueDate),
            paidAt: status === 'PAID' || status === 'REFUNDED' ? parseDate(p.clientPaymentDate ?? p.paymentDate ?? p.confirmedDate) : undefined,
            raw: p,
            ...extra,
        };
    };

    /** Detalhes do meio (QR do PIX / linha digitável) */
    const enrich = async (p: Obj): Promise<Partial<ChargeResult>> => {
        const id = encodeURIComponent(String(p.id));
        if (mapPayment(p) !== 'PENDING') return {};
        if (p.billingType === 'PIX') {
            const qr = await http<Obj>({ path: `/payments/${id}/pixQrCode` });
            return { pix: { copiaECola: String(qr.payload ?? ''), qrCodeBase64: str(qr.encodedImage) }, raw: { payment: p, pixQrCode: qr } };
        }
        if (p.billingType === 'BOLETO') {
            const f = await http<Obj>({ path: `/payments/${id}/identificationField` });
            return { boletoBarcode: str(f.identificationField) ?? str(f.barCode), raw: { payment: p, identificationField: f } };
        }
        return {};
    };

    const ensureCustomer = async (input: CreateChargeInput): Promise<string> => {
        const cpfCnpj = onlyDigits(input.customer.cpf);
        if (!cpfCnpj) throw new ValidationError('asaas: customer.cpf é obrigatório', 'customer.cpf');
        const found = list(await http({ path: '/customers', query: { cpfCnpj, limit: 1 } })).find((c) => c.deleted !== true);
        if (found?.id) return String(found.id);
        const phone = onlyDigits(input.customer.phone).replace(/^55(?=\d{10,11}$)/, '');
        const a = input.customer.address;
        const created = await http<Obj>({
            method: 'POST',
            path: '/customers',
            json: {
                name: input.customer.name,
                cpfCnpj,
                email: input.customer.email,
                mobilePhone: phone || undefined,
                address: a?.street,
                addressNumber: a?.number,
                complement: a?.complement,
                province: a?.locality,
                postalCode: a ? onlyDigits(a.postalCode) : undefined,
                notificationDisabled: true,
            },
        });
        return String(created.id);
    };

    return {
        id: gateway,
        capabilities: CAPABILITIES,

        async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
            validateChargeInput(gateway, CAPABILITIES, input);
            const billingType = BILLING_TYPE[input.method]!;
            const value = centsToDecimal(input.amountCents);
            const customer = await ensureCustomer(input);

            // Idempotência "manual" (Asaas não tem Idempotency-Key)
            const existing = list(
                await http({ path: '/payments', query: { externalReference: input.externalReference, customer, limit: 20 } }),
            ).find((p) => p.status === 'PENDING' && p.deleted !== true && p.billingType === billingType && decimalToCents(p.value as number) === input.amountCents);

            const payment =
                existing ??
                (await http<Obj>({
                    method: 'POST',
                    path: '/payments',
                    json: {
                        customer,
                        billingType,
                        value,
                        dueDate: toSaoPauloDate(input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000)),
                        description: input.description.slice(0, 500),
                        externalReference: input.externalReference,
                        callback: input.returnUrls?.success ? { successUrl: input.returnUrls.success, autoRedirect: true } : undefined,
                    },
                }));
            return toResult(payment, await enrich(payment));
        },

        async getCharge(externalId: string): Promise<ChargeResult> {
            assertExternalId(externalId);
            const p = await http<Obj>({ path: `/payments/${encodeURIComponent(externalId)}` });
            return toResult(p, await enrich(p));
        },

        async cancelCharge(externalId: string): Promise<ChargeResult> {
            assertExternalId(externalId);
            const p = await http<Obj>({ path: `/payments/${encodeURIComponent(externalId)}` });
            const r = await http<Obj>({ method: 'DELETE', path: `/payments/${encodeURIComponent(externalId)}` });
            return { ...toResult({ ...p, deleted: r.deleted === true || p.deleted === true }), raw: { payment: p, delete: r } };
        },

        async refund(input: RefundInput): Promise<RefundResult> {
            assertExternalId(input.externalId);
            assertRefundAmount(input.amountCents);
            const p = await http<Obj>({
                method: 'POST',
                path: `/payments/${encodeURIComponent(input.externalId)}/refund`,
                json: {
                    value: input.amountCents !== undefined ? centsToDecimal(input.amountCents) : undefined,
                    description: input.reason,
                },
            });
            const refunds = Array.isArray(p.refunds) ? (p.refunds as unknown[]).map(obj).filter((x): x is Obj => !!x) : [];
            const last = refunds[refunds.length - 1];
            const refundStatus = str(last?.status) ?? str(p.status);
            return {
                externalRefundId: str(last?.id) ?? String(p.id),
                status: refundStatus === 'DONE' || refundStatus === 'REFUNDED' ? 'DONE' : refundStatus === 'CANCELLED' ? 'FAILED' : 'PENDING',
                amountCents: input.amountCents ?? decimalToCents((last?.value ?? p.value) as number),
                raw: p,
            };
        },

        async parseWebhook(req: WebhookRequest): Promise<WebhookEvent> {
            if (!config.webhookToken) throw new WebhookSignatureError(gateway, 'asaas: webhookToken não configurado');
            const received = lowerHeaders(req.headers)['asaas-access-token'];
            if (!received) throw new WebhookSignatureError(gateway, 'asaas: cabeçalho asaas-access-token ausente');
            if (!safeEqual(received, config.webhookToken)) throw new WebhookSignatureError(gateway, 'asaas: asaas-access-token inválido');

            const body = parseJsonBody(gateway, req.rawBody);
            const event = str(body.event) ?? '';
            const payment = obj(body.payment);
            const eventId = str(body.id) ?? `${event}:${str(payment?.id) ?? ''}:${str(body.dateCreated) ?? ''}`;
            if (!event.startsWith('PAYMENT_') || !payment?.id) return { gateway, eventId, type: 'unknown', raw: body };
            return {
                gateway,
                eventId,
                type: 'charge.updated',
                externalId: String(payment.id),
                status: EVENT_STATUS[event] ?? mapPayment(payment),
                externalReference: str(payment.externalReference),
                raw: body,
            };
        },
    };
}
