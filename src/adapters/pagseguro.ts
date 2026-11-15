/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Adapter PagSeguro / PagBank (API de Pedidos + Checkout)
 *
 * - API: https://api.pagseguro.com (sandbox: https://sandbox.api.pagseguro.com) — JSON,
 *   `Authorization: Bearer <token>`, `x-idempotency-key`.
 * - PIX: `POST /orders` com `qr_codes` -> `qr_codes[0].text` (copia-e-cola) + link `QRCODE.PNG`. `externalId` = ORDE_...
 * - BOLETO: `POST /orders` com `charges[].payment_method.type = BOLETO` (exige `customer.address` + CPF).
 * - CHECKOUT/CARD: `POST /checkouts` -> link `PAY`. `externalId` = CHEC_... ; o pedido (ORDE_...) só nasce no pagamento.
 * - Estorno/cancelamento: `POST /charges/{charge_id}/cancel` com `amount.value`. PIX ainda não pago NÃO tem charge
 *   -> não dá para cancelar (deixe expirar; `cancelCharge` lança `UnsupportedOperationError`).
 * - Webhook: `x-authenticity-token` = SHA-256 (hex) de `${token}-${rawBody}` — token = o MESMO token da conta.
 *   O corpo é o próprio pedido (ou checkout), então o status vem no evento.
 */
import { UnsupportedOperationError, ValidationError, WebhookSignatureError } from '../core/errors';
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
    chargeItems,
    lowerHeaders,
    onlyDigits,
    parseBrPhone,
    parseDate,
    parseJsonBody,
    safeEqual,
    sha256Hex,
    str,
    toSaoPauloDate,
    toSaoPauloIso,
    validateChargeInput,
} from '../core/util';

export interface PagSeguroConfig extends BaseGatewayConfig {
    /** Token da conta PagBank (Bearer) */
    token: string;
    /** Token usado na verificação do webhook. Padrão: o próprio `token` (é o que o PagBank usa) */
    webhookToken?: string;
    /** Sobrescreve a URL base */
    baseUrl?: string;
}

export const PAGSEGURO_BASE_URL = 'https://api.pagseguro.com';
export const PAGSEGURO_SANDBOX_BASE_URL = 'https://sandbox.api.pagseguro.com';

const CAPABILITIES: GatewayCapabilities = {
    methods: ['PIX', 'BOLETO', 'CHECKOUT', 'CARD'],
    refund: true,
    partialRefund: true,
    cancel: true,
    webhooks: true,
};

/** PIX sem expiresAt: 24 h */
const DEFAULT_PIX_TTL_MS = 24 * 60 * 60 * 1000;

const UF_NAMES: Record<string, string> = {
    AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
    ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
    PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro',
    RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina',
    SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : []);
const link = (o: Obj, rel: string): string | undefined => str(arr(o.links).find((l) => l.rel === rel)?.href);

/** Status de uma charge do PagBank -> ChargeStatus (sem considerar estornos) */
export function mapPagSeguroStatus(status: unknown): ChargeStatus {
    switch (status) {
        case 'PAID':
            return 'PAID';
        case 'AUTHORIZED':
            return 'AUTHORIZED';
        case 'DECLINED':
            return 'FAILED';
        case 'CANCELED':
            return 'CANCELED';
        case 'WAITING':
        case 'IN_ANALYSIS':
        default:
            return 'PENDING';
    }
}

/** Charge completa (considera amount.summary.refunded para estorno total/parcial) */
export function mapPagSeguroCharge(charge: Obj): ChargeStatus {
    const amount = obj(charge.amount);
    const summary = obj(amount?.summary);
    const refunded = Number(summary?.refunded ?? 0);
    const paid = Number(summary?.paid ?? amount?.value ?? 0);
    if (refunded > 0) return refunded >= paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    return mapPagSeguroStatus(charge.status);
}

/** Status do checkout (sem pedido ainda) */
export function mapPagSeguroCheckoutStatus(status: unknown): ChargeStatus {
    if (status === 'EXPIRED') return 'EXPIRED';
    if (status === 'INACTIVE') return 'CANCELED';
    return 'PENDING';
}

const isCheckoutId = (id: string) => id.startsWith('CHEC_');

/** Charge "que vale" do pedido: paga/autorizada primeiro, senão a última */
const mainCharge = (order: Obj): Obj | undefined => {
    const charges = arr(order.charges);
    return charges.find((c) => c.status === 'PAID' || c.status === 'AUTHORIZED') ?? charges[charges.length - 1];
};

export function createPagSeguroGateway(config: PagSeguroConfig): PaymentGateway {
    const gateway = 'pagseguro';
    if (!config?.token) throw new ValidationError('pagseguro: token é obrigatório', 'token');

    const http = createHttpClient({
        gateway,
        baseUrl: config.baseUrl ?? (config.sandbox ? PAGSEGURO_SANDBOX_BASE_URL : PAGSEGURO_BASE_URL),
        headers: { Authorization: `Bearer ${config.token}` },
        fetch: config.fetch,
        timeoutMs: config.timeoutMs,
        parseError: (b) => {
            const e = arr(obj(b)?.error_messages)[0];
            return e ? { message: [str(e.description), str(e.parameter_name)].filter(Boolean).join(' / '), code: str(e.code) ?? str(e.error) } : undefined;
        },
    });

    const orderToResult = (order: Obj, externalId?: string): ChargeResult => {
        const charge = mainCharge(order);
        const qr = arr(order.qr_codes)[0];
        const boleto = obj(obj(charge?.payment_method)?.boleto);
        let status: ChargeStatus;
        if (charge) status = mapPagSeguroCharge(charge);
        else {
            const exp = parseDate(qr?.expiration_date);
            status = exp && exp.getTime() < Date.now() ? 'EXPIRED' : 'PENDING';
        }
        const amountCents =
            Number(obj(charge?.amount)?.value ?? obj(qr?.amount)?.value ?? NaN) ||
            arr(order.items).reduce((s, it) => s + Number(it.unit_amount ?? 0) * Number(it.quantity ?? 1), 0);
        return {
            gateway,
            externalId: externalId ?? String(order.id),
            status,
            amountCents,
            externalReference: str(order.reference_id),
            pix: qr?.text ? { copiaECola: String(qr.text), qrCodeUrl: link(qr, 'QRCODE.PNG') } : undefined,
            boletoUrl: charge ? (link(charge, 'PDF') ?? link(charge, 'PNG')) : undefined,
            boletoBarcode: str(boleto?.barcode),
            expiresAt: parseDate(qr?.expiration_date ?? boleto?.due_date),
            paidAt: status === 'PAID' ? parseDate(charge?.paid_at) : undefined,
            raw: order,
        };
    };

    const checkoutToResult = (co: Obj): ChargeResult => ({
        gateway,
        externalId: String(co.id),
        status: mapPagSeguroCheckoutStatus(co.status),
        amountCents:
            arr(co.items).reduce((s, it) => s + Number(it.unit_amount ?? 0) * Number(it.quantity ?? 1), 0) +
            Number(co.additional_amount ?? 0) -
            Number(co.discount_amount ?? 0),
        externalReference: str(co.reference_id),
        checkoutUrl: link(co, 'PAY'),
        expiresAt: parseDate(co.expiration_date),
        raw: co,
    });

    const getOrder = (id: string) => http<Obj>({ path: `/orders/${encodeURIComponent(id)}` });
    const getCheckout = (id: string) => http<Obj>({ path: `/checkouts/${encodeURIComponent(id)}` });

    /** Checkout -> pedido (quando já pago); pedido -> ele mesmo */
    const resolveOrder = async (externalId: string): Promise<{ order?: Obj; checkout?: Obj }> => {
        if (!isCheckoutId(externalId)) return { order: await getOrder(externalId) };
        const checkout = await getCheckout(externalId);
        const orderId = str(arr(checkout.orders)[0]?.id);
        return { checkout, order: orderId ? await getOrder(orderId) : undefined };
    };

    const customerOf = (input: CreateChargeInput, requireDoc: boolean) => {
        const taxId = onlyDigits(input.customer.cpf);
        if (requireDoc && !taxId) throw new ValidationError('pagseguro: customer.cpf é obrigatório', 'customer.cpf');
        const phone = parseBrPhone(input.customer.phone);
        return { name: input.customer.name, email: input.customer.email, taxId: taxId || undefined, phone };
    };

    const itemsOf = (input: CreateChargeInput) =>
        chargeItems(input).map((it) => ({ reference_id: it.id, name: it.title.slice(0, 100), quantity: it.quantity, unit_amount: it.unitAmountCents }));

    return {
        id: gateway,
        capabilities: CAPABILITIES,

        async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
            validateChargeInput(gateway, CAPABILITIES, input);
            const headers = { 'x-idempotency-key': input.idempotencyKey };
            const notification_urls = input.notificationUrl ? [input.notificationUrl] : undefined;

            if (input.method === 'PIX' || input.method === 'BOLETO') {
                const c = customerOf(input, true);
                const customer = {
                    name: c.name,
                    email: c.email,
                    tax_id: c.taxId,
                    phones: c.phone ? [{ ...c.phone, type: 'MOBILE' }] : undefined,
                };
                const body: Obj = { reference_id: input.externalReference, customer, items: itemsOf(input), notification_urls };

                if (input.method === 'PIX') {
                    const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_PIX_TTL_MS);
                    body.qr_codes = [{ amount: { value: input.amountCents }, expiration_date: toSaoPauloIso(expiresAt, false) }];
                } else {
                    const a = input.customer.address;
                    if (!a) throw new ValidationError('pagseguro: BOLETO exige customer.address', 'customer.address');
                    const uf = a.regionCode.toUpperCase();
                    const dueDate = input.expiresAt ?? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
                    body.charges = [
                        {
                            reference_id: input.externalReference,
                            description: input.description.slice(0, 64),
                            amount: { value: input.amountCents, currency: 'BRL' },
                            payment_method: {
                                type: 'BOLETO',
                                boleto: {
                                    due_date: toSaoPauloDate(dueDate),
                                    instruction_lines: { line_1: input.description.slice(0, 75), line_2: 'Não receber após o vencimento' },
                                    holder: {
                                        name: c.name,
                                        tax_id: c.taxId,
                                        email: c.email,
                                        address: {
                                            street: a.street,
                                            number: a.number,
                                            complement: a.complement,
                                            locality: a.locality,
                                            city: a.city,
                                            region: UF_NAMES[uf] ?? uf,
                                            region_code: uf,
                                            country: 'Brasil',
                                            postal_code: onlyDigits(a.postalCode),
                                        },
                                    },
                                },
                            },
                        },
                    ];
                }
                const order = await http<Obj>({ method: 'POST', path: '/orders', headers, json: body });
                return orderToResult(order);
            }

            // CHECKOUT / CARD -> página hospedada
            const c = customerOf(input, false);
            const co = await http<Obj>({
                method: 'POST',
                path: '/checkouts',
                headers,
                json: {
                    reference_id: input.externalReference,
                    expiration_date: input.expiresAt ? toSaoPauloIso(input.expiresAt, false) : undefined,
                    customer: {
                        name: c.name,
                        email: c.email,
                        tax_id: c.taxId,
                        phone: c.phone,
                    },
                    customer_modifiable: true,
                    items: itemsOf(input),
                    payment_methods: input.method === 'CARD' ? [{ type: 'CREDIT_CARD' }] : [{ type: 'CREDIT_CARD' }, { type: 'PIX' }, { type: 'BOLETO' }],
                    redirect_url: input.returnUrls?.success,
                    return_url: input.returnUrls?.failure ?? input.returnUrls?.success,
                    notification_urls,
                    payment_notification_urls: notification_urls,
                },
            });
            return checkoutToResult(co);
        },

        async getCharge(externalId: string): Promise<ChargeResult> {
            assertExternalId(externalId);
            const { order, checkout } = await resolveOrder(externalId);
            if (order) {
                const r = orderToResult(order, externalId);
                return checkout ? { ...r, checkoutUrl: link(checkout, 'PAY'), raw: { checkout, order } } : r;
            }
            return checkoutToResult(checkout!);
        },

        async cancelCharge(externalId: string): Promise<ChargeResult> {
            assertExternalId(externalId);
            const { order, checkout } = await resolveOrder(externalId);
            if (checkout && !order) {
                await http({ method: 'POST', path: `/checkouts/${encodeURIComponent(externalId)}/inactivate` });
                return checkoutToResult({ ...checkout, status: 'INACTIVE' });
            }
            const charge = order ? mainCharge(order) : undefined;
            if (!charge) {
                throw new UnsupportedOperationError(gateway, 'cancelCharge', 'pagseguro: PIX ainda não pago não pode ser cancelado (deixe expirar)');
            }
            if (charge.status === 'PAID') throw new ValidationError('pagseguro: cobrança já paga — use refund()', 'externalId');
            const value = Number(obj(charge.amount)?.value ?? 0);
            const updated = await http<Obj>({
                method: 'POST',
                path: `/charges/${encodeURIComponent(String(charge.id))}/cancel`,
                json: { amount: { value } },
            });
            return orderToResult({ ...order!, charges: [updated] }, externalId);
        },

        async refund(input: RefundInput): Promise<RefundResult> {
            assertExternalId(input.externalId);
            assertRefundAmount(input.amountCents);
            const { order } = await resolveOrder(input.externalId);
            const charge = order ? arr(order.charges).find((c) => c.status === 'PAID') : undefined;
            if (!charge) throw new ValidationError('pagseguro: nenhuma cobrança paga para estornar', 'externalId');
            const amount = obj(charge.amount);
            const remaining = Number(amount?.value ?? 0) - Number(obj(amount?.summary)?.refunded ?? 0);
            const value = input.amountCents ?? remaining;
            const r = await http<Obj>({
                method: 'POST',
                path: `/charges/${encodeURIComponent(String(charge.id))}/cancel`,
                json: { amount: { value } },
            });
            return {
                externalRefundId: String(r.id ?? charge.id),
                status: r.status === 'DECLINED' ? 'FAILED' : 'DONE',
                amountCents: value,
                raw: r,
            };
        },

        async parseWebhook(req: WebhookRequest): Promise<WebhookEvent> {
            const token = config.webhookToken ?? config.token;
            const received = lowerHeaders(req.headers)['x-authenticity-token'];
            if (!received) throw new WebhookSignatureError(gateway, 'pagseguro: cabeçalho x-authenticity-token ausente');
            if (!safeEqual(received.toLowerCase(), sha256Hex(`${token}-${req.rawBody}`))) {
                throw new WebhookSignatureError(gateway, 'pagseguro: x-authenticity-token inválido');
            }

            const body = parseJsonBody(gateway, req.rawBody);
            const id = str(body.id);
            // Sem id de evento: o mesmo corpo reenviado gera o mesmo eventId
            const eventId = `${id ?? 'unknown'}:${sha256Hex(req.rawBody).slice(0, 32)}`;
            if (!id) return { gateway, eventId, type: 'unknown', raw: body };

            if (isCheckoutId(id)) {
                return {
                    gateway, eventId, type: 'charge.updated', externalId: id,
                    status: mapPagSeguroCheckoutStatus(body.status), externalReference: str(body.reference_id), raw: body,
                };
            }
            const r = orderToResult(body);
            return { gateway, eventId, type: 'charge.updated', externalId: id, status: r.status, externalReference: r.externalReference, raw: body };
        },
    };
}
