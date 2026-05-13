# Malika's Universe

E-commerce + AI customer support platform for a Qatar K-beauty retailer. Multi-platform sync (Snoonu, Shopify, Talabat, Rafeeq) with WhatsApp AI agent powered by Claude.

## Stack

- **Database:** Supabase (Postgres + Auth + Realtime + pgvector)
- **Backend:** Next.js 14 (App Router) on Vercel
- **Frontend:** Next.js 14 + shadcn/ui + Tailwind
- **Workers:** Node.js + BullMQ on Hetzner VPS
- **Automation:** n8n self-hosted on Hetzner VPS
- **AI:** Claude (Haiku 4.5 + Sonnet 4.6) via Anthropic API
- **Image storage:** Cloudflare R2 + CDN
- **WhatsApp:** Meta Business Cloud API
- **Secrets:** Doppler

Full details: [`docs/tech-stack.md`](./docs/tech-stack.md)

## Monorepo Layout

```
malikas-universe/
├── apps/
│   ├── web/             # Next.js 14 admin + API
│   └── workers/         # BullMQ background workers
├── packages/
│   ├── db/              # Supabase migrations + types
│   └── shared/          # Pure logic engines + types
│
│ # Note: shadcn/ui components live in apps/web/components/ui/
│ # If we ever add a second app, extract them into packages/ui/
├── n8n/                 # Workflow JSONs + Docker compose
├── docs/                # Architecture, runbooks, prompts
└── .github/             # CI/CD workflows
```

## Prerequisites

- Node.js 20+ (`nvm use`)
- pnpm 9+ (`npm install -g pnpm`)
- Docker + Docker Compose
- Doppler CLI ([install](https://docs.doppler.com/docs/install-cli))
- Supabase CLI (`npm install -g supabase`)
- GitHub account with repo access

## Quick Start (Local Dev)

```bash
# 1. Clone & install
git clone git@github.com:malikasuniverse/malikas-universe.git
cd malikas-universe
pnpm install

# 2. Pull secrets from Doppler
doppler login
doppler setup --project malikas-universe --config dev

# 3. Generate Supabase TypeScript types (requires linked project)
pnpm db:types

# 4. Run dev servers
pnpm dev
```

Web admin: http://localhost:3000

## Project Status

| Phase | Status |
|---|---|
| Phase 1 — Environment Setup | In progress |
| Phase 2 — Database Build | Pending |
| Phase 3 — Import System | Pending |
| Phase 4 — Product System | Pending |
| Phase 5 — Admin Dashboard | Pending |
| Phase 6 — AI System | Pending |
| Phase 7 — WhatsApp System | Pending |
| Phase 8 — Automation (n8n) | Pending |
| Phase 9 — Testing | Pending |
| Phase 10 — Deployment | Pending |

See [`docs/roadmap.md`](./docs/roadmap.md) for full plan.

## Documentation

| Document | Purpose |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | 8-layer system design |
| [`docs/core-logic.md`](./docs/core-logic.md) | 8 backend engines |
| [`docs/tech-stack.md`](./docs/tech-stack.md) | Locked technology choices |
| [`docs/database-spec.md`](./docs/database-spec.md) | Full DB schema + API plan |
| [`docs/roadmap.md`](./docs/roadmap.md) | 10-phase build plan |
| [`docs/naming-conventions.md`](./docs/naming-conventions.md) | Naming rules across the codebase |
| [`docs/runbooks/`](./docs/runbooks/) | Operational runbooks |

## Security

- All secrets via Doppler — never commit `.env` files
- 2FA required on all accounts (Supabase, GitHub, Vercel, Cloudflare, Doppler)
- Row-Level Security enforced on every Supabase table
- HMAC signature verification on all webhooks
- Quarterly secret rotation

## License

Private. All rights reserved © Malika's Universe Trading.
