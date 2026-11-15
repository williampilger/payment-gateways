/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Contrato comum dos gateways de pagamento
 *
 * - Dinheiro SEMPRE em centavos inteiros (`amountCents`). Cada adapter converte para o formato do provedor.
 * - `externalReference` é o id do NOSSO pedido/pagamento; `externalId` é o id da cobrança NO PROVEDOR.
 * - Nenhuma dependência de banco/framework: o consumidor é a fonte da verdade e persiste o que precisar.
 */

/** Gateways que vêm prontos no pacote */
export type BuiltinGatewayId = 'stripe' | 'mercadopago' | 'pagseguro' | 'asaas' | 'manual' | 'courtesy';

/** Ids embutidos + qualquer string (para plugar gateways próprios) sem perder o autocomplete */
export type GatewayId = BuiltinGatewayId | (string & {});

export type Currency = 'BRL' | (string & {});

/**
 * - PIX: QR Code / copia-e-cola
 * - CARD: cartão (normalmente via página hospedada do provedor; não trafegamos dados de cartão)
 * - BOLETO: boleto bancário
 * - CHECKOUT: página hospedada onde o pagador escolhe o meio
 * - CASH / MANUAL: recebimento fora do sistema (registrado por alguém)
 * - COURTESY: cortesia (valor zero)
 */
export type PaymentMethod = 'PIX' | 'CARD' | 'BOLETO' | 'CHECKOUT' | 'CASH' | 'MANUAL' | 'COURTESY';

export type ChargeStatus =
    | 'PENDING'
    | 'AUTHORIZED'
    | 'PAID'
    | 'FAILED'
    | 'CANCELED'
    | 'EXPIRED'
    | 'REFUNDED'
    | 'PARTIALLY_REFUNDED'
    | 'CHARGEBACK';

export interface GatewayCapabilities {
    methods: PaymentMethod[];
    refund: boolean;
    partialRefund: boolean;
    cancel: boolean;
    webhooks: boolean;
}

export interface CustomerAddress {
    street: string;
    number: string;
    complement?: string;
    /** Bairro */
    locality: string;
    city: string;
    /** UF (ex.: "RS") */
    regionCode: string;
    /** CEP (só dígitos ou com máscara) */
    postalCode: string;
}

export interface Customer {
    name: string;
    email: string;
    /** CPF (ou CNPJ) — só dígitos ou com máscara */
    cpf?: string;
    /** Telefone brasileiro, ex.: "+55 51 99999-9999" ou "51999999999" */
    phone?: string;
    /** Opcional; exigido por alguns provedores para BOLETO (ex.: PagBank) */
    address?: CustomerAddress;
}

export interface ChargeItem {
    id?: string;
    title: string;
    quantity: number;
    unitAmountCents: number;
}

export interface CreateChargeInput {
    amountCents: number;
    /** Padrão: 'BRL' */
    currency?: Currency;
    method: PaymentMethod;
    description: string;
    customer: Customer;
    /** Se informado, a soma (quantity × unitAmountCents) deve bater com `amountCents` */
    items?: ChargeItem[];
    /** Id do NOSSO pedido/pagamento (volta nos webhooks quando o provedor suporta) */
    externalReference: string;
    /** Chave de idempotência (repetir a mesma chave não deve criar outra cobrança) */
    idempotencyKey: string;
    expiresAt?: Date;
    returnUrls?: { success: string; failure?: string; pending?: string };
    notificationUrl?: string;
    metadata?: Record<string, string>;
    /** Obrigatório no gateway `manual` */
    manual?: { receivedBy: string; receivedMethod?: string; note?: string };
    /** Obrigatório no gateway `courtesy` */
    courtesy?: { reason: string; grantedBy: string };
}

export interface PixData {
    /** PNG em base64 (sem o prefixo data:) quando o provedor devolve a imagem */
    qrCodeBase64?: string;
    /** URL da imagem do QR Code quando o provedor devolve só o link (ex.: PagBank) */
    qrCodeUrl?: string;
    copiaECola: string;
}

export interface ChargeResult {
    gateway: GatewayId;
    externalId: string;
    status: ChargeStatus;
    amountCents: number;
    /** Nosso id (quando o provedor devolve) */
    externalReference?: string;
    checkoutUrl?: string;
    pix?: PixData;
    boletoUrl?: string;
    boletoBarcode?: string;
    expiresAt?: Date;
    paidAt?: Date;
    /** Resposta crua do provedor (para log/auditoria) */
    raw: unknown;
}

export interface RefundInput {
    externalId: string;
    /** Omitido = estorno total */
    amountCents?: number;
    reason?: string;
}

export interface RefundResult {
    externalRefundId: string;
    status: 'PENDING' | 'DONE' | 'FAILED';
    amountCents: number;
    raw: unknown;
}

export interface WebhookRequest {
    /** Corpo EXATAMENTE como recebido (não reserializar o JSON — quebra a assinatura) */
    rawBody: string;
    /** Cabeçalhos da requisição (o nome é tratado sem diferenciar maiúsculas) */
    headers: Record<string, string | undefined>;
    /** Query string já decodificada (Mercado Pago manda `data.id` e `type` aqui) */
    query?: Record<string, string | undefined>;
}

export interface WebhookEvent {
    gateway: GatewayId;
    /** Id do evento para idempotência (gravar e ignorar repetidos) */
    eventId: string;
    type: 'charge.updated' | 'unknown';
    externalId?: string;
    /**
     * Ausente quando o provedor manda só o id (ex.: Mercado Pago). Nesse caso chame `getCharge(externalId)`
     * — ou use `registry.resolveWebhook()`, que faz isso automaticamente.
     */
    status?: ChargeStatus;
    externalReference?: string;
    raw: unknown;
}

export interface PaymentGateway {
    readonly id: GatewayId;
    readonly capabilities: GatewayCapabilities;
    createCharge(input: CreateChargeInput): Promise<ChargeResult>;
    getCharge(externalId: string): Promise<ChargeResult>;
    cancelCharge(externalId: string): Promise<ChargeResult>;
    refund(input: RefundInput): Promise<RefundResult>;
    /** DEVE validar assinatura/token e lançar `WebhookSignatureError` quando inválido */
    parseWebhook(req: WebhookRequest): Promise<WebhookEvent>;
}

/** Configuração comum a todos os adapters HTTP */
export interface BaseGatewayConfig {
    /** true = ambiente de testes do provedor */
    sandbox: boolean;
    /** Injeção de fetch (testes, proxy, logging). Padrão: globalThis.fetch */
    fetch?: typeof fetch;
    /** Timeout por requisição. Padrão: 30000 ms */
    timeoutMs?: number;
}
