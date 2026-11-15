/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Erros do pacote (use `instanceof` para tratar cada caso)
 */
import type { GatewayId } from './types';

/** Falha na comunicação com o provedor (HTTP != 2xx, timeout, rede, resposta inválida) */
export class PaymentGatewayError extends Error {
    readonly gateway: GatewayId;
    /** Status HTTP (undefined em timeout/erro de rede) */
    readonly httpStatus?: number;
    /** Código de erro do provedor quando houver (ex.: "resource_missing", "invalid_value") */
    readonly providerCode?: string;
    readonly raw?: unknown;

    constructor(
        message: string,
        opts: { gateway: GatewayId; httpStatus?: number; providerCode?: string; raw?: unknown; cause?: unknown },
    ) {
        super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = 'PaymentGatewayError';
        this.gateway = opts.gateway;
        this.httpStatus = opts.httpStatus;
        this.providerCode = opts.providerCode;
        this.raw = opts.raw;
    }
}

/** Assinatura/token do webhook ausente ou inválido — responda 401 e NÃO processe o evento */
export class WebhookSignatureError extends Error {
    readonly gateway: GatewayId;

    constructor(gateway: GatewayId, message: string) {
        super(message);
        this.name = 'WebhookSignatureError';
        this.gateway = gateway;
    }
}

/** Operação/método não suportado pelo gateway */
export class UnsupportedOperationError extends Error {
    readonly gateway: GatewayId;
    readonly operation: string;

    constructor(gateway: GatewayId, operation: string, message?: string) {
        super(message ?? `Operação "${operation}" não suportada pelo gateway "${gateway}"`);
        this.name = 'UnsupportedOperationError';
        this.gateway = gateway;
        this.operation = operation;
    }
}

/** Entrada inválida (detectada ANTES de chamar o provedor) */
export class ValidationError extends Error {
    readonly field?: string;

    constructor(message: string, field?: string) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
    }
}
