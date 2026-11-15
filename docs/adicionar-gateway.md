# Como adicionar um gateway

Qualquer objeto que implemente `PaymentGateway` pode ser registrado — não é preciso alterar este pacote.
Para gateways de uso geral, crie o adapter aqui em `src/adapters/` e exporte em `src/index.ts`.

## 1. Implementar a interface

```ts
/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Adapter MeuBanco
 */
import {
    createHttpClient,
    safeEqual,
    validateChargeInput,
    WebhookSignatureError,
    type BaseGatewayConfig,
    type GatewayCapabilities,
    type PaymentGateway,
} from '@williampilger/payment-gateways';

export interface MeuBancoConfig extends BaseGatewayConfig {
    apiKey: string;
    webhookSecret?: string;
}

const CAPABILITIES: GatewayCapabilities = { methods: ['PIX'], refund: true, partialRefund: false, cancel: true, webhooks: true };

export function createMeuBancoGateway(config: MeuBancoConfig): PaymentGateway {
    const gateway = 'meubanco'; // id livre (GatewayId aceita qualquer string)
    const http = createHttpClient({
        gateway,
        baseUrl: config.sandbox ? 'https://sandbox.meubanco.com' : 'https://api.meubanco.com',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        fetch: config.fetch,
        timeoutMs: config.timeoutMs,
        parseError: (b: any) => ({ message: b?.message, code: b?.code }),
    });

    return {
        id: gateway,
        capabilities: CAPABILITIES,
        async createCharge(input) {
            validateChargeInput(gateway, CAPABILITIES, input); // valida centavos, método, campos obrigatórios
            const r = await http<any>({
                method: 'POST',
                path: '/pix',
                headers: { 'Idempotency-Key': input.idempotencyKey },
                json: { valor: input.amountCents, referencia: input.externalReference },
            });
            return { gateway, externalId: r.id, status: 'PENDING', amountCents: input.amountCents, pix: { copiaECola: r.copiaECola }, raw: r };
        },
        async getCharge(externalId) { /* GET + mapear status */ },
        async cancelCharge(externalId) { /* ... */ },
        async refund(input) { /* ... */ },
        async parseWebhook(req) {
            // OBRIGATÓRIO: verificar assinatura/token antes de confiar no corpo
            if (!config.webhookSecret || !safeEqual(req.headers['x-token'], config.webhookSecret)) {
                throw new WebhookSignatureError(gateway, 'meubanco: token inválido');
            }
            const body = JSON.parse(req.rawBody);
            return { gateway, eventId: body.eventId, type: 'charge.updated', externalId: body.id, status: mapStatus(body.status), raw: body };
        },
    };
}
```

## 2. Registrar

```ts
const payments = createPaymentRegistry({
    gateways: [createGateway('asaas', { ... }), createMeuBancoGateway({ sandbox: true, apiKey: '...' })],
});
payments.forMethod('PIX', ['meubanco', 'asaas']);
```

## Regras do contrato

- **Centavos inteiros** na entrada e na saída; converta para o formato do provedor dentro do adapter
  (`centsToDecimal` / `decimalToCents`).
- **Erros**: `ValidationError` antes de chamar a API; `PaymentGatewayError` para HTTP/timeout (o `createHttpClient` já faz);
  `UnsupportedOperationError` para o que o provedor não suporta; `WebhookSignatureError` em webhook inválido.
- **Webhook**: sempre verificar com o corpo cru e comparação em tempo constante (`safeEqual`). Sem segredo configurado =
  rejeitar. Se o provedor manda só o id, devolva `externalId` sem `status` — o `resolveWebhook` chama `getCharge`.
- **Idempotência**: repasse `idempotencyKey` se o provedor suportar; se não, documente (ver Asaas).
- **`raw`**: devolva sempre a resposta crua do provedor (auditoria/log).
- **Testes**: injete `fetch` falso (`test/helpers.ts` → `fakeFetch`), com fixtures em `test/fixtures/<gateway>/` baseadas
  na documentação; cubra montagem da requisição, mapeamento de status, erros e assinatura válida/inválida.
- **Sandbox**: acrescente o caso em `scripts/sandbox.ts`, as variáveis no `.env.sample` e o script `sandbox:<id>`.

---

By: **will.i.am** | github.com/williampilger
