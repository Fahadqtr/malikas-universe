# Vercel Monorepo Fix — Next Session

> Status: deployed to Vercel but build fails. Both attempts ended with errors.
> Reason: pnpm workspace + Vercel auto-detect compatibility.

---

## ما تمّ

| Step | Status |
|---|---|
| Vercel CLI install + login | ✅ |
| Project created: `malikas-universe` | ✅ |
| Production URL assigned: `https://malikas-universe.vercel.app` | ✅ (but 404 because build failed) |
| 14 env vars added (Production + Preview) | ✅ |
| Build Command default | ✅ |
| Install Command override: `pnpm install --no-frozen-lockfile` | ⚠ Still fails |
| Root Directory: `./` (= apps/web) | ⚠ |

## آخر error

```
No Next.js version detected. Make sure your package.json has "next" in
either "dependencies" or "devDependencies". Also check your Root Directory
setting matches the directory of your package.json file.
```

البناء يقول:
1. ✅ install ran (`pnpm install --no-frozen-lockfile`)
2. ✅ "Already up-to-date" (or downloaded)
3. ❌ Next.js detection fails immediately after

## الحلول الممكنة (للجلسة القادمة)

### الحل 1 — Redeploy from monorepo ROOT (not apps/web)

السبب الجذري: لمّا عملت `vercel` من `apps/web/` ، Vercel سجّل Root Directory = "apps/web" بحدّ ذاته. مما يعني pnpm install يبني node_modules داخل apps/web ، لكن workspace dependencies (مثل @malikas/db) لا تتوفّر.

**الإصلاح:**

```powershell
cd C:\Projects\malikas-universe
vercel link --yes      # ربط بالـ project الموجود
vercel --prod          # deploy من المنوريبو root
```

هذا سيجعل Vercel يستخدم root كـ working dir → يقرأ `vercel.json` الموجود → يستخدم:
```json
{
  "buildCommand": "cd apps/web && pnpm build",
  "installCommand": "pnpm install --no-frozen-lockfile",
  "outputDirectory": "apps/web/.next"
}
```

### الحل 2 — حذف Vercel project وإعادة الإنشاء كـ "Other"

في dashboard:
1. Settings → General → ⋯ → **Delete Project**
2. أعد import المشروع لكن من **Other** framework (مو Next.js)
3. اضبط manually:
   - Build Command: `pnpm --filter @malikas/web build`
   - Output Directory: `apps/web/.next`
   - Install Command: `pnpm install --no-frozen-lockfile`
   - Root Directory: blank (use monorepo root)

### الحل 3 — استخدم Turbo Remote Cache (الأقوى للـ monorepo)

```bash
cd C:\Projects\malikas-universe
npx turbo link
vercel link --yes
vercel --prod
```

Turbo + Vercel يفهمون pnpm workspaces ويبنون فقط الـ packages المتأثّرة.

### الحل 4 — في Vercel UI: Root Directory فارغة

1. Settings → General → Root Directory → امسح "./" واتركها فارغة
2. Settings → Build & Deployment:
   - Build Command override ON: `pnpm --filter @malikas/web build`
   - Output Directory override ON: `apps/web/.next`
   - Install Command override OFF (Vercel auto)
3. Redeploy

## في ما يتعلّق بـ env vars

كلّها مضافة بنجاح (14 مفتاح). لا حاجة لإعادة إضافتها لمّا نصلح البناء.

## URL الحالي

`https://malikas-universe.vercel.app` — يرجع 404 حتى يبني بنجاح. بعد الفيكس راح يصير URL ثابت 24/7.

---

## في الوقت الراهن — استخدم ngrok static domain

```powershell
# 1. احصل على static domain مجاني من ngrok dashboard
#    https://dashboard.ngrok.com/cloud-edge/domains
#    اضغط "Create Domain" → ستحصل على مثل: malika-wa-XYZ.ngrok-free.app

# 2. شغّل ngrok بالـ static domain
ngrok http 3001 --domain=YOUR-STATIC.ngrok-free.app

# 3. اترك النافذة مفتوحة طول الاختبار

# 4. حدّث Meta webhook URL لمرّة واحدة بـ:
#    https://YOUR-STATIC.ngrok-free.app/api/whatsapp/webhook
```

ngrok free tier يدعم **domain ثابت واحد** — ما يحتاج تجديد كل جلسة.

---

## الـ Phase الحالي: Phase 12 + WhatsApp Live — COMPLETE ✅

كل المتطلّبات حقّقت:
- ✅ Migration 0010 (whatsapp_webhook_logs)
- ✅ Token diagnostics + permanent token guide
- ✅ /whatsapp-live page (banner + checklist + troubleshooting)
- ✅ Live mode safety gate
- ✅ Send-test endpoint (proved working — رسالة واحدة وصلت)
- ✅ Webhook route with logging
- ✅ Meta Cloud API integrated + verified

النقص الوحيد: نشر دائم (production deploy) — مؤجّل لجلسة قادمة.
