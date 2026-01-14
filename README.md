# Backend de licença / trial (SUAP PGD2 PIT/RIT)

## Rodar local

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Servidor padrão: http://localhost:8787

## Checkout (Mercado Pago)
- Endpoint de compra: `GET /buy?boundUserKey=...&plan=basic|pro&period=monthly|yearly`
- Webhook: `POST /api/webhook/mercadopago`
- URLs de retorno: `/success`, `/pending`, `/cancel`

## Preços
- `MP_PRICE_BASIC_MONTHLY`, `MP_PRICE_PRO_MONTHLY`
- `MP_PRICE_BASIC_YEARLY`, `MP_PRICE_PRO_YEARLY`

## Testar criando licença manual (sem pagamento)

```bash
npm run seed -- pro 30
# copie a LICENSE_KEY e cole no popup/options
```

Ou via endpoint:
- GET /admin/create-license?plan=basic&days=30

## Produção
- Prioridade de plano: Pro > Básico; em empate, maior validade.
- Use `DATABASE_URL` para Postgres (JSON so para dev local).
- Configure CORS allowlist.
- Configure `MERCADOPAGO_ACCESS_TOKEN`.
- Opcional: configure `PUBLIC_BASE_URL` para gerar URLs do webhook/retorno.

## Admin
- GET /admin/stats (total usuarios trial/pago e licencas ativas)
- GET /admin/replay-payment?paymentId=...&force=1 (reprocessa pagamento aprovado)
