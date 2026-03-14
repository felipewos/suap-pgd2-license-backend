# suap-pgd2-license-backend

Backend de trial e licenciamento da extensao `suap-pgd2-extension`, com verificacao de acesso e fluxo de compra.

## Rodar local

```bash
cp .env.example .env
npm install
npm start
```

Servidor padrao: `http://localhost:8787`

## Rotas principais

- `POST /api/auth/bind`
- `POST /api/trial/status`
- `POST /api/license/verify`
- `GET /buy`
- `POST /api/webhook/mercadopago`

## Licencas de teste

```bash
npm run seed -- pro 30
```

Isso gera uma `LICENSE_KEY` para testar ativacao manual na extensao.

## Ambiente

Configure no minimo:

- `DATABASE_URL` para Postgres em producao
- `MERCADOPAGO_ACCESS_TOKEN`
- `PUBLIC_BASE_URL` quando precisar gerar URLs absolutas

## Admin

- `GET /admin/stats`
- `GET /admin/replay-payment?paymentId=...&force=1`
