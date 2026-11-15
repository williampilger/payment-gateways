/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Gateway "courtesy" (cortesia: libera o pedido sem cobrar)
 *
 * - Sem rede e SEM estado. Exige `input.courtesy.reason` e `input.courtesy.grantedBy` (auditoria).
 * - O valor é SEMPRE forçado para 0: `amountCents` informado vira `waivedAmountCents` no `raw` (valor dispensado).
 * - Devolve PAID na hora, com externalId `cty_<uuid>`. Não há estorno (nada foi cobrado).
 */
import { UnsupportedOperationError, ValidationError } from '../core/errors';
import type {
    ChargeResult,
    CreateChargeInput,
    GatewayCapabilities,
    PaymentGateway,
    RefundResult,
    WebhookEvent,
} from '../core/types';
import { newUuid, validateChargeInput } from '../core/util';

export interface CourtesyConfig {
    /** Relógio injetável (testes). Padrão: () => new Date() */
    now?: () => Date;
}

const CAPABILITIES: GatewayCapabilities = {
    methods: ['COURTESY'],
    refund: false,
    partialRefund: false,
    cancel: false,
    webhooks: false,
};

export function createCourtesyGateway(config: CourtesyConfig = {}): PaymentGateway {
    const gateway = 'courtesy';
    const now = config.now ?? (() => new Date());

    return {
        id: gateway,
        capabilities: CAPABILITIES,

        async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
            validateChargeInput(gateway, CAPABILITIES, input, { allowZero: true });
            if (!input.courtesy?.reason?.trim()) throw new ValidationError('courtesy: courtesy.reason é obrigatório', 'courtesy.reason');
            if (!input.courtesy.grantedBy?.trim()) throw new ValidationError('courtesy: courtesy.grantedBy é obrigatório', 'courtesy.grantedBy');
            const paidAt = now();
            return {
                gateway,
                externalId: `cty_${newUuid()}`,
                status: 'PAID',
                amountCents: 0,
                externalReference: input.externalReference,
                paidAt,
                raw: {
                    reason: input.courtesy.reason,
                    grantedBy: input.courtesy.grantedBy,
                    waivedAmountCents: input.amountCents,
                    idempotencyKey: input.idempotencyKey,
                    paidAt: paidAt.toISOString(),
                },
            };
        },

        async getCharge(): Promise<ChargeResult> {
            throw new UnsupportedOperationError(gateway, 'getCharge', 'courtesy: sem estado — consulte o seu próprio registro');
        },

        async cancelCharge(): Promise<ChargeResult> {
            throw new UnsupportedOperationError(gateway, 'cancelCharge');
        },

        async refund(): Promise<RefundResult> {
            throw new UnsupportedOperationError(gateway, 'refund', 'courtesy: nada foi cobrado, não há o que estornar');
        },

        async parseWebhook(): Promise<WebhookEvent> {
            throw new UnsupportedOperationError(gateway, 'parseWebhook');
        },
    };
}
