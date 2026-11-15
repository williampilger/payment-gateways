/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - @williampilger/payment-gateways (API pública)
 */
export type * from './core/types';
export { PaymentGatewayError, WebhookSignatureError, UnsupportedOperationError, ValidationError } from './core/errors';
export { createPaymentRegistry, type PaymentRegistry, type ResolvedWebhookEvent } from './core/registry';
export { createHttpClient, encodeForm, buildUrl, DEFAULT_TIMEOUT_MS, type HttpClient, type HttpClientOptions, type HttpRequest } from './core/http';
export { centsToDecimal, decimalToCents, safeEqual, hmacSha256Hex, sha256Hex, validateChargeInput } from './core/util';

export { createGateway, BUILTIN_GATEWAY_IDS, type GatewayConfigMap } from './factory';
export { createStripeGateway, mapStripeSessionStatus, mapStripePaymentIntentStatus, STRIPE_BASE_URL, type StripeConfig } from './adapters/stripe';
export { createMercadoPagoGateway, mapMercadoPagoStatus, MERCADOPAGO_BASE_URL, type MercadoPagoConfig } from './adapters/mercadopago';
export {
    createPagSeguroGateway,
    mapPagSeguroStatus,
    mapPagSeguroCharge,
    mapPagSeguroCheckoutStatus,
    PAGSEGURO_BASE_URL,
    PAGSEGURO_SANDBOX_BASE_URL,
    type PagSeguroConfig,
} from './adapters/pagseguro';
export { createAsaasGateway, mapAsaasStatus, ASAAS_BASE_URL, ASAAS_SANDBOX_BASE_URL, type AsaasConfig } from './adapters/asaas';
export { createManualGateway, type ManualConfig } from './adapters/manual';
export { createCourtesyGateway, type CourtesyConfig } from './adapters/courtesy';
