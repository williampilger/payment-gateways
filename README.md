# @williampilger/payment-gateways

Abstração **reutilizável** de gateways de pagamento para Node.js/TypeScript. Um contrato único (`PaymentGateway`)
com adapters para **Stripe**, **Mercado Pago**, **PagSeguro/PagBank**, **Asaas**, **manual** (recebimento por fora) e
**cortesia**.

- Só `fetch` nativo — **sem SDKs** dos provedores e **sem dependências** de runtime.
- Sem banco, sem framework: o consumidor é a fonte da verdade e grava o que quiser.
- Dinheiro sempre em **centavos inteiros** (`amountCents`).
- Webhooks **sempre** com verificação de assinatura/token (`WebhookSignatureError` quando inválido).
- ESM + `.d.ts` (tsup), Node >= 22, TypeScript strict, testes com Vitest.

## Instalação

Enquanto o pacote não é publicado, use como dependência local (pasta irmã):

```jsonc
// package.json do projeto consumidor
{
  "dependencies": {
    "@williampilger/payment-gateways": "file:../payment-gateways"
  }
}
```

> `file:` cria um link simbólico para a pasta — o `dist/` precisa existir. Rode `npm install` (o script `prepare`
> executa o build) ou `npm run build` dentro de `payment-gateways` sempre que alterar o código.

Futuramente, direto do GitHub (o `prepare` gera o `dist/` na instalação):

```jsonc
"@williampilger/payment-gateways": "github:williampilger/payment-gateways#v0.1.0"
```

## Uso rápido

```ts
import {
    createGateway,
    createPaymentRegistry,
    WebhookSignatureError,
} from '@williampilger/payment-gateways';

const payments = createPaymentRegistry({
    gateways: [
        createGateway('mercadopago', {
            sandbox: process.env.NODE_ENV !== 'production',
            accessToken: process.env.MP_ACCESS_TOKEN!,
            webhookSecret: process.env.MP_WEBHOOK_SECRET,
        }),
        createGateway('asaas', { sandbox: true, apiKey: process.env.ASAAS_API_KEY!, webhookToken: process.env.ASAAS_WEBHOOK_TOKEN }),
        createGateway('manual', {}),
        createGateway('courtesy', {}),
    ],
});

// 1) Escolher o gateway (por id ou pelo método, com prioridade)
const gateway = payments.forMethod('PIX', ['mercadopago', 'asaas'])!;

// 2) Criar a cobrança
const charge = await gateway.createCharge({
    amountCents: 4990, // R$ 49,90
    method: 'PIX',
    description: 'Pedido #123',
    customer: { name: 'Fulano de Tal', email: 'fulano@example.com', cpf: '123.456.789-09' },
    externalReference: 'pay_123',      // id do SEU pagamento
    idempotencyKey: 'pay_123-try-1',   // repetir a chave não duplica a cobrança
    expiresAt: new Date(Date.now() + 30 * 60_000),
    notificationUrl: 'https://meusite.com/webhooks/mercadopago',
});
// charge.externalId, charge.status, charge.pix?.copiaECola, charge.pix?.qrCodeBase64, charge.checkoutUrl ...

// 3) Webhook (rawBody = corpo EXATO recebido, sem reserializar)
try {
    const event = await payments.resolveWebhook('mercadopago', { rawBody, headers, query });
    // gravar event.eventId (idempotência) e aplicar event.status ao pagamento event.externalReference/externalId
} catch (err) {
    if (err instanceof WebhookSignatureError) return reply.code(401).send();
    throw err;
}
```

Pagamento recebido por fora (dinheiro/maquininha) e cortesia:

```ts
await payments.get('manual').createCharge({ ...base, method: 'CASH', manual: { receivedBy: 'Maria (caixa)', note: 'troco p/ 50' } });
await payments.get('courtesy').createCharge({ ...base, method: 'COURTESY', amountCents: 0, courtesy: { reason: 'Parceiro', grantedBy: 'admin@x' } });
```

## API pública

| Export | Descrição |
|---|---|
| `createPaymentRegistry({ gateways })` | `get(id)`, `list()`, `has(id)`, `forMethod(method, priority?)`, `resolveWebhook(id, req)` |
| `createGateway(id, config)` | Fábrica genérica dos gateways embutidos (config tipada por id) |
| `createStripeGateway`, `createMercadoPagoGateway`, `createPagSeguroGateway`, `createAsaasGateway`, `createManualGateway`, `createCourtesyGateway` | Fábricas de cada adapter |
| `PaymentGatewayError` | Falha no provedor: `gateway`, `httpStatus`, `providerCode`, `raw` |
| `WebhookSignatureError` | Assinatura/token do webhook inválido ou ausente → responda 401 |
| `UnsupportedOperationError` | Método/operação não suportado pelo gateway |
| `ValidationError` | Entrada inválida (antes de qualquer requisição) |
| `map*Status` | Funções puras de mapeamento de status de cada provedor |
| `createHttpClient`, `encodeForm`, `validateChargeInput`, `safeEqual`, `hmacSha256Hex`, `sha256Hex` | Utilitários para escrever novos adapters |

Tipos: `PaymentGateway`, `GatewayId`, `PaymentMethod`, `ChargeStatus`, `GatewayCapabilities`, `CreateChargeInput`,
`ChargeResult`, `RefundInput`, `RefundResult`, `WebhookRequest`, `WebhookEvent`, `BaseGatewayConfig`, configs de cada adapter.

Toda config HTTP aceita `sandbox: boolean`, `fetch?` (injeção para testes/proxy) e `timeoutMs?` (padrão 30 s).

## Gateways

| Gateway | Métodos | Estorno | Parcial | Cancelar | Webhook | `externalId` |
|---|---|:-:|:-:|:-:|:-:|---|
| `stripe` | CHECKOUT, CARD, PIX (Checkout Session) | ✔ | ✔ | ✔ (expira a sessão) | ✔ | `cs_...` |
| `mercadopago` | PIX (Pagamentos), CHECKOUT, CARD (Checkout Pro) | ✔ | ✔ | ✔ | ✔ (só id) | id numérico (PIX) / id da preferência |
| `pagseguro` | PIX, BOLETO (Pedidos), CHECKOUT, CARD (Checkout) | ✔ | ✔ | ✔ (exceto PIX não pago) | ✔ | `ORDE_...` / `CHEC_...` |
| `asaas` | PIX, BOLETO, CARD, CHECKOUT (`UNDEFINED`) | ✔ | ✔ | ✔ (DELETE) | ✔ | `pay_...` |
| `manual` | CASH, MANUAL, PIX | ✔ (registro) | ✔ | ✖ | ✖ | `man_<uuid>` |
| `courtesy` | COURTESY | ✖ | ✖ | ✖ | ✖ | `cty_<uuid>` |

Observações por gateway:

- **Stripe** — PIX/cartão são exibidos na página hospedada (`checkoutUrl`); `pix` não é preenchido. `returnUrls.success` é
  obrigatório. `expires_at` é ajustado para a janela aceita (30 min – 24 h). Com `sandbox: true` uma chave live é recusada.
  Eventos `payment_intent.*` / `charge.*` não trazem o id da sessão: use `externalReference` (gravado no metadata).
- **Mercado Pago** — sandbox = credenciais de teste (mesma URL); `sandbox` só escolhe `sandbox_init_point`. No Checkout Pro o
  `externalId` é a preferência; `getCharge` procura o pagamento por `external_reference` (o mais relevante: aprovado >
  pendente > recusado). O webhook traz o id do **pagamento** (não da preferência) — use `resolveWebhook` e case pelo
  `externalReference`.
- **PagBank** — PIX e BOLETO exigem CPF; BOLETO exige `customer.address`. PIX não pago não tem "charge" e não pode ser
  cancelado (deixe expirar). O pedido gerado por um checkout tem outro id (`ORDE_...`): case pelo `externalReference`.
- **Asaas** — exige CPF (cliente é buscado/criado automaticamente). Sem chave de idempotência na API: o adapter reaproveita
  um pagamento PENDENTE com o mesmo `externalReference` + valor + tipo.
- **manual** — sem estado: `getCharge` lança `UnsupportedOperationError` (seu banco é a fonte da verdade). `refund` exige
  `amountCents` e só registra (o dinheiro volta por fora).
- **courtesy** — o valor é sempre forçado a 0; o valor original vai em `raw.waivedAmountCents`.

## Webhooks — verificação

Passe sempre o **corpo cru** (`rawBody` string, exatamente como chegou). Nomes de cabeçalho são comparados sem diferenciar
maiúsculas. Todas as comparações são em tempo constante.

| Gateway | Cabeçalho | Verificação | Status no evento? |
|---|---|---|---|
| Stripe | `Stripe-Signature: t=..,v1=..` | HMAC-SHA256(`${t}.${rawBody}`, `webhookSecret`); tolerância 300 s (anti-replay) | Sim |
| Mercado Pago | `x-signature: ts=..,v1=..` + `x-request-id` | HMAC-SHA256(`id:{data.id};request-id:{x-request-id};ts:{ts};`, `webhookSecret`); `data.id` vem da **query** (minúsculo se alfanumérico) | **Não** (só id) |
| PagBank | `x-authenticity-token` | SHA-256 hex de `${token}-${rawBody}` (token = token da conta) | Sim |
| Asaas | `asaas-access-token` | Igual ao `webhookToken` configurado no painel | Sim |

Sem o segredo configurado (`webhookSecret`/`webhookToken`), `parseWebhook` lança `WebhookSignatureError` — nunca aceita
evento sem verificação.

`eventId` serve para idempotência (grave e ignore repetidos). Stripe/Mercado Pago/Asaas usam o id do evento do provedor;
no PagBank (que não manda id de evento) é `${id do pedido}:${hash do corpo}`.

**Eventos sem status** (Mercado Pago): `parseWebhook` devolve `externalId` e `status: undefined`; chame
`gateway.getCharge(externalId)` — ou use `registry.resolveWebhook(gatewayId, req)`, que faz isso e devolve também `charge`.

## Mapeamento de status

| `ChargeStatus` | Stripe | Mercado Pago | PagBank | Asaas |
|---|---|---|---|---|
| `PENDING` | sessão `open` / PI `requires_*`, `processing` | `pending`, `in_process` | `WAITING`, `IN_ANALYSIS`, checkout `ACTIVE` | `PENDING`, `AWAITING_RISK_ANALYSIS` |
| `AUTHORIZED` | PI `requires_capture` | `authorized` | `AUTHORIZED` | `AUTHORIZED` |
| `PAID` | `payment_status=paid` / PI `succeeded` | `approved` | `PAID` | `RECEIVED`, `CONFIRMED`, `RECEIVED_IN_CASH` |
| `FAILED` | `async_payment_failed`, PI `payment_failed` | `rejected` | `DECLINED` | `PAYMENT_REPROVED_BY_RISK_ANALYSIS` (evento) |
| `CANCELED` | PI `canceled` | `cancelled` | `CANCELED`, checkout `INACTIVE` | `DELETED` / `deleted: true` |
| `EXPIRED` | sessão `expired` | `cancelled` + `status_detail=expired` | QR vencido sem charge, checkout `EXPIRED` | `OVERDUE` (vencido) |
| `REFUNDED` | `charge.refunded=true` | `refunded` | `summary.refunded >= paid` | `REFUNDED`, `REFUND_REQUESTED`, `REFUND_IN_PROGRESS` |
| `PARTIALLY_REFUNDED` | `amount_refunded > 0` | `approved` + `partially_refunded` | `summary.refunded < paid` | `PAYMENT_PARTIALLY_REFUNDED` (evento) |
| `CHARGEBACK` | `charge.disputed` / `charge.dispute.created` | `charged_back`, `in_mediation` | — | `CHARGEBACK_*`, `AWAITING_CHARGEBACK_REVERSAL` |

Decisões: Asaas `OVERDUE` → `EXPIRED` (o boleto/PIX ainda pode ser pago depois; nesse caso chega `RECEIVED` e vira `PAID`).
Mercado Pago `in_mediation` (disputa aberta) → `CHARGEBACK`. Asaas `REFUND_REQUESTED` → `REFUNDED` (estorno já solicitado).

## Adicionar um gateway novo

Implemente a interface `PaymentGateway` e registre no `createPaymentRegistry` — veja
[docs/adicionar-gateway.md](docs/adicionar-gateway.md).

## Desenvolvimento

```bash
npm install          # instala e builda (prepare)
npm run typecheck
npm test
npm run build        # dist/ (ESM + .d.ts)

cp .env.sample .env  # credenciais de SANDBOX
npm run sandbox:mercadopago   # cria PIX de R$ 1,00 e consulta o status
npm run sandbox:stripe | sandbox:pagseguro | sandbox:asaas
```

- [Como adicionar um gateway](docs/adicionar-gateway.md)
- [ToDo / próximos passos](ToDo.md)

---

By: **will.i.am** | github.com/williampilger
