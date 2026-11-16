# Changelog - payment-gateways

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) · versões [SemVer](https://semver.org/lang/pt-BR/).

## [0.2.0] - 2026-11-16

### Alterado
- **Consumo por submódulo git + workspace, pelo código-fonte** (mesmo modelo do CoreCAD na Authenty).
  `exports`/`main`/`types` apontam para `src/index.ts`; o consumidor transpila.
  - **Por quê:** o modelo `file:` exigia clonar o repo ao lado, rodar `npm run build` a cada alteração e reinstalar a
    cópia no consumidor (`install-links`), além de um checkout extra no CI. Agora basta `git submodule update` e
    `npm install`: alterações no pacote aparecem direto no consumidor (symlink do workspace), sem build.
- `publishConfig` guarda os `exports` para `dist/`, caso o pacote venha a ser publicado num registry.

### Removido
- Script `prepare` (build automático na instalação): desnecessário consumindo o fonte.

## [0.1.0] - 2026-11-15

### Adicionado
- Contrato único `PaymentGateway` (valores em centavos inteiros), erros tipados (`PaymentGatewayError`,
  `WebhookSignatureError`, `UnsupportedOperationError`, `ValidationError`).
- Registro (`createPaymentRegistry`: `get`/`list`/`has`/`forMethod`/`resolveWebhook`) e fábrica `createGateway`.
- Cliente HTTP sobre `fetch` nativo, com timeout, JSON/form e mapeamento de erros.
  - **Por quê:** sem SDKs dos provedores e sem dependências de runtime, para reaproveitar em qualquer projeto Node.
- Adapters **Stripe**, **Mercado Pago**, **PagBank/PagSeguro**, **Asaas**, **manual** e **cortesia**: cobrança
  (PIX, cartão via checkout, boleto), consulta, cancelamento, estorno total/parcial e webhooks **sempre** com
  verificação de assinatura/token.
- Testes com `fetch` falso + fixtures; scripts `npm run sandbox:<gateway>` para validar com credenciais de sandbox.
- Guia `docs/adicionar-gateway.md`.

### Pendente
- Validação ponta a ponta de cada gateway em sandbox (ver `ToDo.md`).
