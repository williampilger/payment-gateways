/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Registro de gateways (escolha por id/método e resolução de webhooks)
 */
import { ValidationError } from './errors';
import type { ChargeResult, GatewayId, PaymentGateway, PaymentMethod, WebhookEvent, WebhookRequest } from './types';

export interface ResolvedWebhookEvent extends WebhookEvent {
    /** Preenchido quando o status precisou ser consultado no provedor (`getCharge`) */
    charge?: ChargeResult;
}

export interface PaymentRegistry {
    /** Lança `ValidationError` se o gateway não estiver registrado */
    get(id: GatewayId): PaymentGateway;
    list(): PaymentGateway[];
    has(id: GatewayId): boolean;
    /**
     * Primeiro gateway que suporta o método. `priority` define a ordem de preferência (ids);
     * os não listados vêm depois, na ordem de registro.
     */
    forMethod(method: PaymentMethod, priority?: GatewayId[]): PaymentGateway | undefined;
    /**
     * `parseWebhook` (valida a assinatura) + `getCharge` quando o evento veio sem status
     * (ex.: Mercado Pago, que só manda o id). Erros de assinatura sobem como `WebhookSignatureError`.
     */
    resolveWebhook(gatewayId: GatewayId, req: WebhookRequest): Promise<ResolvedWebhookEvent>;
}

export function createPaymentRegistry(opts: { gateways: PaymentGateway[] }): PaymentRegistry {
    const map = new Map<string, PaymentGateway>();
    for (const g of opts.gateways) {
        if (!g?.id) throw new ValidationError('Gateway sem id');
        if (map.has(g.id)) throw new ValidationError(`Gateway "${g.id}" registrado duas vezes`);
        map.set(g.id, g);
    }

    const get = (id: GatewayId): PaymentGateway => {
        const g = map.get(id);
        if (!g) throw new ValidationError(`Gateway "${id}" não registrado`, 'gateway');
        return g;
    };

    return {
        get,
        list: () => [...map.values()],
        has: (id) => map.has(id),
        forMethod(method, priority = []) {
            const ordered = [
                ...priority.map((id) => map.get(id)).filter((g): g is PaymentGateway => !!g),
                ...[...map.values()].filter((g) => !priority.includes(g.id)),
            ];
            return ordered.find((g) => g.capabilities.methods.includes(method));
        },
        async resolveWebhook(gatewayId, req) {
            const gateway = get(gatewayId);
            const event = await gateway.parseWebhook(req);
            if (event.status || !event.externalId || event.type !== 'charge.updated') return event;
            const charge = await gateway.getCharge(event.externalId);
            return {
                ...event,
                status: charge.status,
                externalReference: event.externalReference ?? charge.externalReference,
                charge,
            };
        },
    };
}
