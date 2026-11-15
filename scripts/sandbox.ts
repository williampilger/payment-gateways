/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Teste manual em SANDBOX: cria uma cobrança de R$ 1,00 e consulta o status
 *
 * Uso: npm run sandbox:<stripe|mercadopago|pagseguro|asaas>   (lê o .env via tsx --env-file-if-exists)
 * - Credencial em branco = gateway pulado (sai com código 0).
 * - Stripe: CHECKOUT (página hospedada); demais: PIX.
 */
import { randomUUID } from 'node:crypto';
import { createGateway, PaymentGatewayError, type CreateChargeInput, type PaymentGateway, type PaymentMethod } from '../src';

const env = (k: string) => process.env[k]?.trim() || undefined;

function build(id: string): { gateway: PaymentGateway; method: PaymentMethod } | string {
    switch (id) {
        case 'stripe': {
            const secretKey = env('STRIPE_SECRET_KEY');
            if (!secretKey) return 'STRIPE_SECRET_KEY';
            return { gateway: createGateway('stripe', { sandbox: true, secretKey, webhookSecret: env('STRIPE_WEBHOOK_SECRET') }), method: 'CHECKOUT' };
        }
        case 'mercadopago': {
            const accessToken = env('MP_ACCESS_TOKEN');
            if (!accessToken) return 'MP_ACCESS_TOKEN';
            return { gateway: createGateway('mercadopago', { sandbox: true, accessToken, webhookSecret: env('MP_WEBHOOK_SECRET') }), method: 'PIX' };
        }
        case 'pagseguro': {
            const token = env('PAGSEGURO_TOKEN');
            if (!token) return 'PAGSEGURO_TOKEN';
            return { gateway: createGateway('pagseguro', { sandbox: true, token, webhookToken: env('PAGSEGURO_WEBHOOK_TOKEN') }), method: 'PIX' };
        }
        case 'asaas': {
            const apiKey = env('ASAAS_API_KEY');
            if (!apiKey) return 'ASAAS_API_KEY';
            return { gateway: createGateway('asaas', { sandbox: true, apiKey, webhookToken: env('ASAAS_WEBHOOK_TOKEN') }), method: 'PIX' };
        }
        default:
            throw new Error(`Gateway desconhecido: "${id}" (use stripe | mercadopago | pagseguro | asaas)`);
    }
}

async function main() {
    const id = process.argv[2] ?? '';
    const built = build(id);
    if (typeof built === 'string') {
        console.log(`[${id}] pulado: ${built} não configurado no .env`);
        return;
    }
    const { gateway, method } = built;
    const ref = `sandbox-${Date.now()}`;
    const input: CreateChargeInput = {
        amountCents: 100,
        method,
        description: 'Teste sandbox payment-gateways',
        customer: {
            name: 'Comprador Teste',
            email: env('SANDBOX_CUSTOMER_EMAIL') ?? 'comprador.teste@example.com',
            cpf: env('SANDBOX_CUSTOMER_CPF'),
            phone: '+55 51 99999-9999',
        },
        externalReference: ref,
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        returnUrls: { success: 'https://example.com/pagamento/ok', failure: 'https://example.com/pagamento/falhou' },
    };

    console.log(`[${id}] criando cobrança ${method} de R$ 1,00 (ref ${ref})...`);
    const charge = await gateway.createCharge(input);
    const { raw: _raw, ...summary } = charge;
    console.log(summary);

    console.log(`[${id}] getCharge(${charge.externalId})...`);
    const again = await gateway.getCharge(charge.externalId);
    console.log({ externalId: again.externalId, status: again.status, amountCents: again.amountCents, externalReference: again.externalReference });
}

main().catch((err) => {
    if (err instanceof PaymentGatewayError) {
        console.error(`ERRO ${err.gateway} HTTP ${err.httpStatus ?? '-'} ${err.providerCode ?? ''}: ${err.message}`);
        console.error(JSON.stringify(err.raw, null, 2));
    } else console.error(err);
    process.exit(1);
});
