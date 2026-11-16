# To-Do List - payment-gateways

Legenda: `[X]` feito · `[ ]` pendente · ⚠️ prioridade

## ⚠️ Validação E2E em sandbox (pendente: credenciais)

- [ ] ⚠️ Stripe: `npm run sandbox:stripe` + webhook real via `stripe listen --forward-to` (conferir PIX disponível na conta BR)
- [ ] ⚠️ Mercado Pago: `npm run sandbox:mercadopago` (PIX) + Checkout Pro com usuário de teste; validar `x-signature` real
  (formato do `ts` e do `data.id` na query)
- [ ] ⚠️ PagBank: `npm run sandbox:pagseguro` (PIX) + checkout + boleto; confirmar `x-authenticity-token` real, se o
  `GET /checkouts/{id}` devolve `orders[]` após o pagamento e se `payment_methods` com BOLETO no checkout é aceito
- [ ] ⚠️ Asaas: `npm run sandbox:asaas` (PIX + boleto); validar webhook `asaas-access-token` e o formato de `refunds[]`
- [ ] ⚠️ Testar estorno parcial e total em cada gateway (status final e eventos gerados)

## Núcleo

- [X] Contrato (`PaymentGateway`, tipos, erros) em centavos
- [X] Registro (`get`/`list`/`has`/`forMethod`/`resolveWebhook`) e fábrica `createGateway`
- [X] Cliente HTTP com timeout, JSON/form e mapeamento de erros
- [X] Adapters: Stripe, Mercado Pago, PagBank, Asaas, manual, cortesia
- [X] Testes com fetch falso + fixtures; scripts de sandbox
- [ ] Retry com backoff para 429/5xx (respeitando idempotência)
- [ ] Hook de log opcional (requisição/resposta, com mascaramento de dados sensíveis)
- [X] Consumo por submódulo + workspace (código-fonte), no modelo do CoreCAD - ver CHANGELOG 0.2.0

## Futuro

- [ ] Assinaturas/recorrência (abstração `SubscriptionGateway`: planos, ciclos, cancelamento, webhooks de renovação)
- [ ] Split de pagamentos (marketplace: Mercado Pago, PagBank, Asaas)
- [ ] Cartão transparente (tokenização no front: Stripe Elements, MP Card Form, PagBank encrypt, Asaas)
- [ ] Parcelamento (limite de parcelas / juros) no checkout
- [ ] Boleto no Mercado Pago (`bolbradesco`, exige endereço)
- [ ] Consulta de saldo/repasses e conciliação (relatórios de liquidação)
- [ ] Outros gateways: Pagar.me, Efí (Gerencianet), Cielo, PIX direto via API do banco (BACEN / Pix Automático)

---

By: **will.i.am** | github.com/williampilger
