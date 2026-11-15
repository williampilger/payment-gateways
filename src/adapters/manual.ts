/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Gateway "manual" (recebimento fora do sistema: dinheiro, PIX direto na conta, maquininha...)
 *
 * - Sem rede e SEM estado: o consumidor (banco de dados dele) é a fonte da verdade.
 * - `createCharge` exige `input.manual.receivedBy` e devolve PAID na hora, com externalId `man_<uuid>`.
 * - `getCharge`/`cancelCharge`/`parseWebhook` lançam `UnsupportedOperationError` (não há o que consultar).
 * - `refund` devolve DONE: o dinheiro é devolvido por fora; aqui só registramos o fato.
 */
import { UnsupportedOperationError, ValidationError } from '../core/errors';
import type {
    ChargeResult,
    CreateChargeInput,
    GatewayCapabilities,
    PaymentGateway,
    RefundInput,
    RefundResult,
    WebhookEvent,
} from '../core/types';
import { assertExternalId, assertRefundAmount, newUuid, validateChargeInput } from '../core/util';

export interface ManualConfig {
    /** Métodos aceitos. Padrão: CASH, MANUAL e PIX (PIX direto na chave da empresa) */
    methods?: Array<'CASH' | 'MANUAL' | 'PIX' | 'CARD' | 'BOLETO'>;
    /** Relógio injetável (testes). Padrão: () => new Date() */
    now?: () => Date;
}

export function createManualGateway(config: ManualConfig = {}): PaymentGateway {
    const gateway = 'manual';
    const now = config.now ?? (() => new Date());
    const capabilities: GatewayCapabilities = {
        methods: config.methods ?? ['CASH', 'MANUAL', 'PIX'],
        refund: true,
        partialRefund: true,
        cancel: false,
        webhooks: false,
    };

    return {
        id: gateway,
        capabilities,

        async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
            validateChargeInput(gateway, capabilities, input);
            if (!input.manual?.receivedBy?.trim()) throw new ValidationError('manual: manual.receivedBy é obrigatório', 'manual.receivedBy');
            const paidAt = now();
            return {
                gateway,
                externalId: `man_${newUuid()}`,
                status: 'PAID',
                amountCents: input.amountCents,
                externalReference: input.externalReference,
                paidAt,
                raw: {
                    method: input.method,
                    receivedBy: input.manual.receivedBy,
                    receivedMethod: input.manual.receivedMethod,
                    note: input.manual.note,
                    idempotencyKey: input.idempotencyKey,
                    paidAt: paidAt.toISOString(),
                },
            };
        },

        async getCharge(): Promise<ChargeResult> {
            throw new UnsupportedOperationError(gateway, 'getCharge', 'manual: sem estado — consulte o seu próprio registro do pagamento');
        },

        async cancelCharge(): Promise<ChargeResult> {
            throw new UnsupportedOperationError(gateway, 'cancelCharge', 'manual: pagamento manual já nasce PAID — use refund()');
        },

        async refund(input: RefundInput): Promise<RefundResult> {
            assertExternalId(input.externalId);
            assertRefundAmount(input.amountCents);
            if (input.amountCents === undefined) {
                throw new ValidationError('manual: informe amountCents (o gateway não guarda o valor original)', 'amountCents');
            }
            return {
                externalRefundId: `mrf_${newUuid()}`,
                status: 'DONE',
                amountCents: input.amountCents,
                raw: { externalId: input.externalId, reason: input.reason, refundedAt: now().toISOString() },
            };
        },

        async parseWebhook(): Promise<WebhookEvent> {
            throw new UnsupportedOperationError(gateway, 'parseWebhook');
        },
    };
}
