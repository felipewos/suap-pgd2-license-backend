# Backend de licença / trial (SUAP PGD2 PIT/RIT)

## Rodar local

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Servidor padrão: http://localhost:8787

## Testar criando licença manual (sem Stripe)

```bash
npm run seed -- pro 30
# copie a LICENSE_KEY e cole no popup/options
```

Ou via endpoint:
- GET /admin/create-license?plan=basic&days=30

## Produção
- Prioridade de plano: Pro > Basico; em empate, maior validade.
- Use `DATABASE_URL` para Postgres (JSON so para dev local).
- Configure CORS allowlist.
- Configure Stripe (opcional) + webhook.
