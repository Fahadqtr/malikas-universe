# WhatsApp Live Setup — Meta Cloud API → Malika's Universe

End-to-end setup for connecting the WhatsApp AI Agent to a **real** WhatsApp Business number.

> **Safety first.** Live auto-replies are OFF by default. You can wire Meta to your local dev environment, watch real customer messages land in `/support`, and only flip the AI auto-reply switch when you're confident the tone and behavior are correct.

---

## Test flow at a glance

| Step | What | Result |
|---|---|---|
| A | Run migration `0010` | `whatsapp_webhook_logs` table created |
| B | Set env keys in `.env.local` | Token + phone ID + verify token configured |
| C | Start dev server (`pnpm dev`) | Next.js on `http://localhost:3001` |
| D | Run a tunnel (`npx localtunnel --port 3001`) | Public HTTPS URL pointing at your laptop |
| E | Configure Meta webhook | Meta sends inbound messages to your tunnel |
| F | Send a test WhatsApp message | Meta forwards it; row appears in `whatsapp_webhook_logs` |
| G | Verify it appears in `/support` | New conversation with the customer message |
| H | Set `WHATSAPP_LIVE_ENABLED=true` and restart | AI replies start being delivered for real |

---

## Step A — Run migration 0010

```sql
-- supabase/migrations/00000000000010_whatsapp_live.sql
```

In Supabase SQL Editor, run the contents of that file. It creates `whatsapp_webhook_logs` and indexes. Idempotent.

---

## Step B — Get the four env values from Meta

### B1. Create the Meta Developer app

1. Open <https://developers.facebook.com/apps>
2. **My Apps** → **Create App**
3. Choose **Business** as the app type
4. App name: `Malika WhatsApp` (anything works)
5. Once created, on the left sidebar add the **WhatsApp** product

### B2. Open the WhatsApp API Setup screen

After adding WhatsApp, you'll be taken to **WhatsApp → API Setup**. This screen shows:

- A temporary **access token** (24-hour expiry — useful for first test only)
- A **Phone number ID** (numeric, e.g. `123456789012345`)
- A **WhatsApp Business Account ID** (numeric, store it but we don't need it for now)
- A **test phone number** that Meta gives you for free (sends from `+1 555 …`)
- A box to **add recipient phone numbers** for testing

### B3. Get the Phone Number ID

It's labelled **"Phone number ID"** under the test number. Copy the numeric value.

```
WHATSAPP_PHONE_ID=123456789012345
```

### B4. Get a permanent access token

The 24-hour token works for testing but expires. **For real use, follow the dedicated section below: "Permanent Token Setup via Meta Business Settings".**

If you want a quick summary:

1. Go to <https://business.facebook.com/settings/system-users>
2. Add a System User, role Admin
3. Assign the app + WBA as assets
4. Generate token with `whatsapp_business_messaging` + `whatsapp_business_management`
5. Expiration: Never
6. Copy → paste into `.env.local`

```
WHATSAPP_TOKEN=EAA…(very long string)
```

### B5. Pick a verify token

A verify token is just a shared secret you make up. Meta sends it on every webhook handshake; we compare. Anything works. Recommended:

```
WHATSAPP_VERIFY_TOKEN=malikas_verify_2026
```

### B6. Paste into `apps/web/.env.local`

```env
# ─── WhatsApp Cloud API ───────────────────────────────────────
WHATSAPP_TOKEN=EAA…long_string_from_B4
WHATSAPP_PHONE_ID=123456789012345
WHATSAPP_VERIFY_TOKEN=malikas_verify_2026

# SAFETY: keep this OFF until you've verified inbound logs look correct
WHATSAPP_LIVE_ENABLED=false
```

> **Never commit these.** `.env.local` is gitignored.

---

## Step C — Start the dev server

```powershell
cd C:\Projects\malikas-universe
pnpm dev
```

Wait for `✓ Ready`. Open `http://localhost:3001/whatsapp-live` — you should see three green ✓ marks for the env config, plus a successful Meta ping.

---

## Step D — Run a public HTTPS tunnel

Meta only accepts **HTTPS** webhook URLs. Your laptop doesn't have one. Use a tunnel.

### Preferred: `localtunnel`

```powershell
npx localtunnel --port 3001
```

Output:

```
your url is: https://random-words-1234.loca.lt
```

That's your public URL. The full webhook is:

```
https://random-words-1234.loca.lt/api/whatsapp/webhook
```

Open the URL once in a browser — `localtunnel` shows a friendly warning page the first time; click **"Click to Continue"**. Then it works for the API.

> ⚠ The hostname changes every restart unless you use `--subdomain malika`. If you stop the tunnel you must update Meta with the new URL.

### Alternative: `ngrok`

```powershell
choco install ngrok          # one time
ngrok config add-authtoken YOUR_TOKEN   # get it from https://dashboard.ngrok.com/
ngrok http 3001
```

Output:

```
Forwarding   https://1234-94-200-xx-xx.ngrok-free.app -> http://localhost:3001
```

Use that `https://…ngrok-free.app/api/whatsapp/webhook` as the callback URL.

> ngrok free is more stable than localtunnel but limits you to one tunnel at a time and 40 connections/min. Plenty for testing.

---

## Step E — Configure the Meta webhook

1. In your Meta app, go to **WhatsApp → Configuration → Webhook**
2. Click **Edit** next to "Callback URL"
3. **Callback URL:** paste the full URL from `/whatsapp-live` (it auto-builds it for you, including the tunnel host)
   ```
   https://random-words-1234.loca.lt/api/whatsapp/webhook
   ```
4. **Verify token:** `malikas_verify_2026` (must EXACTLY match `WHATSAPP_VERIFY_TOKEN`)
5. Click **Verify and save**

Meta now sends a GET request: `?hub.mode=subscribe&hub.verify_token=malikas_verify_2026&hub.challenge=…`. Our route compares the token, echoes the challenge back, and Meta accepts. If you see a **green check**, you're verified.

> If verification fails:
> - Open `https://your-tunnel-url/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=malikas_verify_2026&hub.challenge=test123` in a browser — should return `test123`.
> - If you see "WhatsApp webhook not configured" — env vars not picked up. Restart dev server.
> - If you see "Verification failed" — token mismatch. Re-check `.env.local`.

### Subscribe to message events

Same Configuration page:

1. Under **Webhook fields** → click **Manage**
2. Check the box next to **`messages`** → click **Subscribe**

That's it. Meta will POST to your webhook on every inbound customer message.

---

## Step F — Send a test inbound message

You can only send to numbers that have messaged your business in the last 24 hours, OR to numbers you've explicitly added as recipients in **API Setup → To**.

1. **WhatsApp → API Setup** → **To:** → **Add phone number** → add YOUR OWN WhatsApp
2. From your phone, message Meta's test number that was given to you in B2 (the `+1 555 …` number)
3. Send any text, e.g. `سلام`

Within a few seconds, on `/whatsapp-live`:

- A row appears in **Recent webhook events** with direction `inbound`, status `parsed`, your phone, and `live: 🛡` (because live mode is still off — safe default).

---

## Step G — Verify it appears in `/support`

Open `/support`. The new inbound message creates (or updates) a conversation. You'll see:

- The customer phone in the left list
- Your test message in the chat view
- A "🛡 inbound logged" entry — no AI reply was sent because live mode is OFF

> This is the safety gate working as designed. You can iterate on the AI prompt via `/whatsapp-test` (which calls `/api/whatsapp/reply-test` — same agent code, no outbound).

---

## Step H — Enable live AI replies

Once you're happy with everything:

1. Edit `apps/web/.env.local`:
   ```env
   WHATSAPP_LIVE_ENABLED=true
   ```
2. **Restart the dev server** (env vars are only read on boot)
3. Reload `/whatsapp-live` — the top banner flips to green **"Live mode: ENABLED"**
4. Send another test message from your phone
5. Within 2-5 seconds, you should receive an AI reply on your phone

Done. The agent is now answering customers in real time.

---

## Permanent Token Setup via Meta Business Settings

The token Meta shows on **WhatsApp → API Setup → Try it out** expires every **2–24 hours**. That's fine for the very first end-to-end test, but unworkable in practice. The fix is a **System User token** that you generate from Business Settings — it lives **forever** unless you revoke it.

> **Do this once.** Then you stop having to refresh your token every morning.

### Step P1 — Open Business Settings

1. Go to <https://business.facebook.com/settings>
2. Top-left **business selector** must be **malikastrading** (or whatever business owns your WhatsApp Business Account)
3. Left sidebar → **Users** → **System Users**

### Step P2 — Create the System User

1. Click **Add** (top-right)
2. Name: `malika-system-user` (anything works)
3. Role: **Admin** (must be Admin for WhatsApp scopes; Employee won't work)
4. Click **Create System User**

You're now back on the System Users list with the new user selected.

### Step P3 — Assign assets (App + WhatsApp Business Account)

On the right side of the System User page:

1. Click **Add Assets**
2. In the left column pick **Apps**
3. Tick **Malika WhatsApp** → on the right side enable **Develop App** and **Manage App** → click **Save Changes**
4. Click **Add Assets** again
5. In the left column pick **WhatsApp Accounts**
6. Tick **malikastrading** (the WBA) → on the right enable **Full Control: Manage WhatsApp account, messaging, message templates** → **Save Changes**

If either asset doesn't show up: the System User isn't Admin, OR the WBA isn't owned by this business. Fix the role / owner first.

### Step P4 — Generate the permanent token

Back on the System User page:

1. Click **Generate New Token**
2. App: **Malika WhatsApp** (same one you assigned)
3. **Token expiration: Never** (NOT 60 days — pick "Never")
4. **Permissions** — tick these two boxes:
   - ☑ `whatsapp_business_messaging`
   - ☑ `whatsapp_business_management`
5. Click **Generate Token**

A blue dialog shows the token. **Copy it now — Meta will never show it again.** If you lose it, generate a new one (the old one keeps working until you revoke it).

### Step P5 — Paste into `.env.local`

Open `apps/web/.env.local` and replace the token line:

```env
WHATSAPP_TOKEN=EAA…(your_new_permanent_token)
```

Save the file, then restart the dev server (`RESTART-DEV-AGAIN.bat`).

### Step P6 — Verify on `/whatsapp-live`

Reload `http://localhost:3001/whatsapp-live`:

- **Meta API ping**: ✓ Test Number (+1 555-637-5616) — green
- **Setup checklist → Token valid**: ✅
- **Setup checklist → Token EXPIRED**: shouldn't appear

The token will now last **months** (Meta only revokes if you remove the System User or change the password on the business account).

> ⚠ **Treat this token like a database password.** Anyone with it can send WhatsApps from your business number and read every conversation. Never commit it to git. Never paste it in chat. Doppler / Vercel env vars only in prod.

### What if I lose it?

1. Go back to Business Settings → System Users → `malika-system-user`
2. Click **Generate New Token** again — same permissions
3. New token replaces old; old one stops working

---

## What to do when something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| `Token expired` on `/whatsapp-live` ping | Using the 24h test token | Follow "Permanent Token Setup" above. |
| `Verify and save` keeps failing | Verify token mismatch | Re-check both Meta UI and `.env.local`. Restart dev. |
| `Verification failed` | Env not loaded | Restart `pnpm dev` after changing `.env.local`. |
| Inbound message → no log row | Tunnel down / wrong URL | Check tunnel still running. Re-paste URL in Meta. |
| Log shows `status: error` | Agent crash | See `error_message` column. Check Claude API key + DB. |
| Log shows `status: sent` but no message on phone | Recipient not allowlisted in Meta | Add their number under **API Setup → To**. After 24h window starts, it auto-works. |
| Meta returns `(#131030)` | Phone not registered with WhatsApp | Try a phone number that's actually on WhatsApp |
| Meta returns `(#100) Invalid parameter` | Phone format issue | Send as `+9745…`, our lib strips the leading + automatically |

---

## Reverting / killing live mode in a hurry

If you need to stop auto-replies immediately:

1. Set `WHATSAPP_LIVE_ENABLED=false` in `.env.local`
2. Restart the dev server (or pm2/systemd restart in prod)

Inbound messages still get logged, but no reply leaves your server.

For a faster panic switch in prod, stop the tunnel/proxy — Meta will retry for ~24h, but no traffic reaches the agent in the meantime. **This is the recommended kill switch for incidents.**

---

## What about production?

When you deploy to a real host (Vercel, Railway, your own VPS):

1. The host gives you a stable HTTPS URL (e.g. `https://app.malikasuniverse.com`)
2. Set the four env vars in the host's config (Vercel: Settings → Environment Variables; Doppler in our case)
3. Point Meta's webhook at `https://app.malikasuniverse.com/api/whatsapp/webhook`
4. No tunnel needed — your domain is already HTTPS
5. Flip `WHATSAPP_LIVE_ENABLED=true`

Phone-number switching (test phone → real business number) is done in **WhatsApp → Phone Numbers → Add phone number** inside the Meta app. The verification step is a one-time call to your business landline or SMS. Once your real number is in, change `WHATSAPP_PHONE_ID` to the new number's ID and restart.

---

## Webhook signature verification (TODO before going public)

Right now we accept any POST to `/api/whatsapp/webhook` without verifying it came from Meta. For local testing on a tunnel that nobody knows about, this is fine. For prod, add HMAC verification on the `X-Hub-Signature-256` header. See:

<https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-business-messaging#validating-payloads>

This is on the security backlog — flag before going live to real customers at scale.

---

## Quick reference

| Thing | Location / value |
|---|---|
| Webhook URL (local) | `https://YOUR-TUNNEL.loca.lt/api/whatsapp/webhook` |
| Webhook URL (prod) | `https://app.malikasuniverse.com/api/whatsapp/webhook` |
| Verify token | `malikas_verify_2026` (or whatever you set) |
| Test endpoint | `/api/whatsapp/reply-test` (no Meta call) |
| Live endpoint | `/api/whatsapp/webhook` (full path, called by Meta) |
| Outbound test | `POST /api/whatsapp/send-test` (owner only) |
| Status JSON | `GET /api/whatsapp/status` |
| Dashboard UI | `/whatsapp-live` |
| Conversations UI | `/support` |
| Local-agent test UI | `/whatsapp-test` |
| Migration | `supabase/migrations/00000000000010_whatsapp_live.sql` |
| WhatsApp lib | `apps/web/lib/whatsapp.ts` |
| Webhook route | `apps/web/app/api/whatsapp/webhook/route.ts` |

---

## Doc maintainers

If you update Meta endpoints, version (currently `v22.0`), or the env var names, also update:

- `apps/web/lib/whatsapp.ts` (the `API_VERSION` constant)
- `.env.example` (top-level)
- This doc
