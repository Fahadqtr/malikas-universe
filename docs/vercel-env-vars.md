# Vercel Environment Variables for Malika's Universe

Copy each row into **Vercel project → Settings → Environment Variables**.
Set scope to: **Production + Preview + Development** for each.

> **All values are in `apps/web/.env.local`.** Open that file to copy.

---

## Required for app to boot

| Key | Where to get value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `.env.local` line: `NEXT_PUBLIC_SUPABASE_URL=` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `.env.local` (long JWT starting with `eyJ...`) |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local` (long JWT starting with `eyJ...`) |
| `NODE_ENV` | `production` |

## AI agent

| Key | Where to get value |
|---|---|
| `ANTHROPIC_API_KEY` | `.env.local` (starts with `sk-ant-api03-...`) |
| `ANTHROPIC_MODEL_HAIKU` | `claude-haiku-4-5-20251001` |
| `ANTHROPIC_MODEL_SONNET` | `claude-sonnet-4-6` |

## Shopify (Phase 8)

| Key | Where to get value |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `516wu8-0g.myshopify.com` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | `.env.local` (starts with `atkn_...`) |
| `SHOPIFY_API_VERSION` | `2025-07` |

## WhatsApp Cloud API (Phase 10-12)

| Key | Where to get value |
|---|---|
| `WHATSAPP_TOKEN` | `.env.local` (System User permanent token, starts with `EAA...`) |
| `WHATSAPP_PHONE_ID` | `1154264414431339` |
| `WHATSAPP_VERIFY_TOKEN` | `malikas_verify_2026` |
| `WHATSAPP_LIVE_ENABLED` | `false` (start safe; flip to `true` after testing) |

## Workers (off — Vercel doesn't support BullMQ workers)

| Key | Value |
|---|---|
| `DISABLE_WORKERS` | `true` |

---

## After all env vars are added

1. **Deployments** → top deployment → **⋯** → **Redeploy** (uncheck "Use existing Build Cache")
2. Wait for build to finish (~2 minutes)
3. Note the production URL (e.g. `https://malikas-universe.vercel.app`)
4. Test webhook GET:
   ```
   https://malikas-universe.vercel.app/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=malikas_verify_2026&hub.challenge=DEPLOY_TEST
   ```
   Should return: `DEPLOY_TEST`

5. **Update Meta webhook config**:
   - Meta → WhatsApp → Configuration → Webhook → Edit
   - Callback URL: `https://malikas-universe.vercel.app/api/whatsapp/webhook`
   - Verify token: `malikas_verify_2026`
   - Click **Verify and save**

6. ngrok no longer needed — Vercel runs 24/7.

---

## Common Vercel build errors and fixes

| Error | Fix |
|---|---|
| `Cannot find module '@malikas/db'` | In Vercel → Settings → General → **Install Command** set to `pnpm install --no-frozen-lockfile` |
| `next: command not found` | **Root Directory** must be `apps/web` (in Settings → General) |
| `Missing env var SUPABASE_...` | You forgot to add it. Settings → Environment Variables → add it → Redeploy. |
| `Build timeout` | Vercel free tier = 45 min max. Should be 2-3 min normally. |
| Build succeeds but routes 404 | Root Directory is wrong, or framework not detected as Next.js. |
