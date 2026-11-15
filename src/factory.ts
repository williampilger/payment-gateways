/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Fábrica genérica: createGateway(id, config)
 */
import { createAsaasGateway, type AsaasConfig } from './adapters/asaas';
import { createCourtesyGateway, type CourtesyConfig } from './adapters/courtesy';
import { createManualGateway, type ManualConfig } from './adapters/manual';
import { createMercadoPagoGateway, type MercadoPagoConfig } from './adapters/mercadopago';
import { createPagSeguroGateway, type PagSeguroConfig } from './adapters/pagseguro';
import { createStripeGateway, type StripeConfig } from './adapters/stripe';
import { ValidationError } from './core/errors';
import type { BuiltinGatewayId, PaymentGateway } from './core/types';

/** Configuração de cada gateway embutido */
export interface GatewayConfigMap {
    stripe: StripeConfig;
    mercadopago: MercadoPagoConfig;
    pagseguro: PagSeguroConfig;
    asaas: AsaasConfig;
    manual: ManualConfig;
    courtesy: CourtesyConfig;
}

const FACTORIES: { [K in BuiltinGatewayId]: (config: GatewayConfigMap[K]) => PaymentGateway } = {
    stripe: createStripeGateway,
    mercadopago: createMercadoPagoGateway,
    pagseguro: createPagSeguroGateway,
    asaas: createAsaasGateway,
    manual: createManualGateway,
    courtesy: createCourtesyGateway,
};

export const BUILTIN_GATEWAY_IDS = Object.keys(FACTORIES) as BuiltinGatewayId[];

export function createGateway<K extends BuiltinGatewayId>(id: K, config: GatewayConfigMap[K]): PaymentGateway {
    const factory = FACTORIES[id] as ((c: GatewayConfigMap[K]) => PaymentGateway) | undefined;
    if (!factory) throw new ValidationError(`Gateway "${String(id)}" desconhecido`, 'id');
    return factory(config);
}
