'use client';

/**
 * WhatsappLiveDashboard — client component that polls /api/whatsapp/status
 * + lets owners run a test-send.
 *
 * Layout:
 *   1. Temp-token warning banner                (top)
 *   2. Live-mode banner (off/on)
 *   3. Setup checklist                          (drives operator's eye)
 *   4. Configuration + Webhook URL              (paired cards)
 *   5. Token-expired callout (when applicable)
 *   6. Test-send form                           (owner only)
 *   7. Troubleshooting box                      (collapsible)
 *   8. Recent webhook logs table                (auto-refreshes)
 *
 * Polls /api/whatsapp/status every 10s for live data.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Input, Textarea } from '@/components/ui';

type ConfigStatus = {
  token_configured: boolean;
  phone_id_configured: boolean;
  verify_token_configured: boolean;
  verify_token_hint: string;
  phone_id_hint: string;
  live_enabled: boolean;
  api_version: string;
};

type WebhookLog = {
  id: number;
  direction: 'inbound' | 'outbound';
  phone: string | null;
  status: string;
  error_message: string | null;
  wamid: string | null;
  conversation_id: number | null;
  live_enabled: boolean;
  created_at: string;
  payload_preview: string;
};

type PingResult =
  | { ok: true; phone_number: string; verified_name: string }
  | { ok: false; reason: string; kind: 'expired' | 'invalid' | 'permission' | 'network' | 'not_configured' | 'other'; code?: number };

type Checklist = {
  token_set: boolean;
  phone_id_set: boolean;
  verify_token_set: boolean;
  token_valid: boolean;
  token_expired: boolean;
  webhook_likely_verified: boolean;
  messages_subscribed: boolean;
  live_enabled: boolean;
  last_inbound_at: string | null;
  last_inbound_phone: string | null;
  last_outbound_at: string | null;
  last_outbound_status: string | null;
};

type StatusResponse = {
  config: ConfigStatus;
  live_enabled: boolean;
  ping: PingResult;
  webhook_url: string;
  actor_role: string;
  checklist: Checklist;
  logs: WebhookLog[];
};

const POLL_INTERVAL_MS = 10_000;

export function WhatsappLiveDashboard({ actorRole }: { actorRole: string }) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [showTroubleshoot, setShowTroubleshoot] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/status?logs=30', { cache: 'no-store' });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message ?? 'failed');
      setData(body.data as StatusResponse);
    } catch (e) {
      setBannerError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const t = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [fetchStatus]);

  if (loading && !data) {
    return <Card>Loading status…</Card>;
  }
  if (!data) {
    return (
      <Card className="border-destructive/40 bg-destructive/10 text-destructive">
        Failed to load status. {bannerError}
      </Card>
    );
  }

  const { config, ping, webhook_url, logs, live_enabled, checklist } = data;
  const isOwner = actorRole === 'owner';
  const allConfigured =
    config.token_configured && config.phone_id_configured && config.verify_token_configured;
  const tokenExpired = !ping.ok && ping.kind === 'expired';

  return (
    <div className="space-y-4">
      {bannerError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive p-2 text-sm flex items-center justify-between">
          <span>⚠ {bannerError}</span>
          <button onClick={() => setBannerError(null)} className="text-xs hover:underline">dismiss</button>
        </div>
      )}

      {/* ─── 1. Temp-token warning ─────────────────────────────────────────── */}
      <div className="rounded-lg border border-orange-300 bg-orange-50 text-orange-900 p-3 text-sm">
        <div className="flex items-start gap-2">
          <span className="text-lg leading-none">⏳</span>
          <div className="flex-1">
            <strong>Temporary tokens expire every 2–24 hours.</strong>{' '}
            For stable operation, generate a <strong>permanent System User Token</strong> from
            Meta Business Settings. See <code className="bg-orange-100 px-1 rounded text-xs">docs/whatsapp-live-setup.md</code> →
            "Permanent Token Setup".
          </div>
        </div>
      </div>

      {/* ─── 2. Live-mode banner ───────────────────────────────────────────── */}
      <div
        className={`rounded-lg border p-3 text-sm flex items-center justify-between flex-wrap gap-2 ${
          live_enabled
            ? 'border-green-300 bg-green-50 text-green-900'
            : 'border-yellow-300 bg-yellow-50 text-yellow-900'
        }`}
      >
        <div>
          <strong>Live mode: {live_enabled ? 'ENABLED' : 'OFF (safe mode)'}</strong>
          <div className="text-xs opacity-80 mt-0.5">
            {live_enabled
              ? 'Inbound WhatsApp messages will be auto-replied by the AI agent.'
              : "Inbound messages are logged but NOT auto-replied. Flip WHATSAPP_LIVE_ENABLED=true in .env.local + restart dev when you're ready."}
          </div>
        </div>
        {live_enabled ? <span className="text-2xl">🟢</span> : <span className="text-2xl">🛡</span>}
      </div>

      {/* ─── 3. Setup checklist ─────────────────────────────────────────────── */}
      <Card className="space-y-2">
        <h2 className="font-semibold">Setup checklist</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <ChecklistItem ok={checklist.token_set} label="Token configured (env var set)" />
          <ChecklistItem ok={checklist.phone_id_set} label="Phone ID configured" />
          <ChecklistItem ok={checklist.verify_token_set} label="Verify token configured" />
          <ChecklistItem
            ok={checklist.token_valid}
            warn={checklist.token_expired}
            label={checklist.token_expired ? 'Token EXPIRED — refresh required' : 'Token valid (Meta accepts it)'}
          />
          <ChecklistItem
            ok={checklist.webhook_likely_verified}
            label="Webhook reachable (Meta ping ok)"
          />
          <ChecklistItem
            ok={checklist.messages_subscribed}
            label="Subscribed to messages event (proved by inbound activity)"
            neutralIfFalse
          />
          <ChecklistItem
            ok={live_enabled}
            label={`Live AI replies: ${live_enabled ? 'ON' : 'OFF (safe)'}`}
            neutralIfFalse
          />
          <ChecklistItem
            ok={!!checklist.last_inbound_at}
            label={
              checklist.last_inbound_at
                ? `Last inbound: ${new Date(checklist.last_inbound_at).toLocaleTimeString()} from ${checklist.last_inbound_phone ?? '—'}`
                : 'Last inbound: none yet'
            }
            neutralIfFalse
          />
          <ChecklistItem
            ok={!!checklist.last_outbound_at}
            label={
              checklist.last_outbound_at
                ? `Last outbound: ${new Date(checklist.last_outbound_at).toLocaleTimeString()} (${checklist.last_outbound_status})`
                : 'Last outbound: none yet'
            }
            neutralIfFalse
          />
        </div>
      </Card>

      {/* ─── 4. Token-expired callout ───────────────────────────────────────── */}
      {tokenExpired && (
        <div className="rounded-lg border-2 border-red-400 bg-red-50 p-4 text-red-900 space-y-2">
          <div className="flex items-start gap-2">
            <span className="text-2xl">🔑</span>
            <div className="flex-1">
              <div className="font-semibold text-base">Token expired</div>
              <p className="text-sm mt-1">
                The WhatsApp token has expired. This is normal for the temporary 24h test tokens
                Meta shows on <em>API Setup → Try it out</em>. <strong>Generate a permanent System User Token</strong> to
                stop hitting this every day:
              </p>
              <ol className="list-decimal list-inside text-sm mt-2 space-y-0.5">
                <li>
                  Go to <a
                    href="https://business.facebook.com/settings/system-users"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline font-medium"
                  >business.facebook.com/settings/system-users</a>
                </li>
                <li>Add a System User → role: <strong>Admin</strong> → name it <code className="bg-red-100 px-1 rounded">malika-system-user</code></li>
                <li>
                  Click the user → <strong>Add Assets</strong> → assign{' '}
                  <em>App: Malika WhatsApp</em> AND <em>WhatsApp Business Account: malikastrading</em>
                </li>
                <li>
                  Click <strong>Generate New Token</strong> → permissions:{' '}
                  <code className="bg-red-100 px-1 rounded">whatsapp_business_messaging</code> +{' '}
                  <code className="bg-red-100 px-1 rounded">whatsapp_business_management</code>
                </li>
                <li>Expiration: <strong>Never</strong> → Generate → copy the token (you only see it once)</li>
                <li>
                  Replace <code className="bg-red-100 px-1 rounded">WHATSAPP_TOKEN</code> in{' '}
                  <code className="bg-red-100 px-1 rounded">apps/web/.env.local</code> with it,
                  then restart the dev server.
                </li>
              </ol>
              <p className="text-xs mt-2 italic">
                Full walkthrough with screenshots: <code className="bg-red-100 px-1 rounded">docs/whatsapp-live-setup.md</code> → "Permanent Token Setup via Meta Business Settings"
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ─── 5. Configuration + Webhook URL ─────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="space-y-3">
          <h2 className="font-semibold">Configuration</h2>
          <ConfigRow
            label="WHATSAPP_TOKEN"
            ok={config.token_configured}
            hint={config.token_configured ? '••••• (hidden for security)' : 'missing'}
          />
          <ConfigRow
            label="WHATSAPP_PHONE_ID"
            ok={config.phone_id_configured}
            hint={config.phone_id_configured ? config.phone_id_hint : 'missing'}
          />
          <ConfigRow
            label="WHATSAPP_VERIFY_TOKEN"
            ok={config.verify_token_configured}
            hint={config.verify_token_configured ? config.verify_token_hint : 'missing'}
          />
          <ConfigRow label="API version" ok={true} hint={config.api_version} />

          <div className="border-t border-border pt-2 text-xs">
            <div className="font-medium mb-1">Meta API ping</div>
            {ping.ok ? (
              <div className="text-green-800">✓ {ping.verified_name} ({ping.phone_number})</div>
            ) : (
              <div className={tokenExpired ? 'text-red-700 font-medium' : 'text-yellow-800'}>
                ⚠ [{ping.kind}] {ping.reason}
              </div>
            )}
          </div>
        </Card>

        <Card className="space-y-3">
          <h2 className="font-semibold">Webhook callback URL</h2>
          <p className="text-xs text-muted-foreground">
            Paste this into Meta &gt; WhatsApp &gt; Configuration &gt; Webhook.
            Run a tunnel (<code>ngrok http 3001</code>) first if you're on localhost.
          </p>
          <div className="flex items-stretch gap-2">
            <Input
              readOnly
              value={webhook_url || 'unable to detect host'}
              className="font-mono text-xs flex-1"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(webhook_url);
              }}
            >
              Copy
            </Button>
          </div>
          <div className="text-xs space-y-1">
            <div>
              <strong>Verify token:</strong>{' '}
              <code className="bg-muted px-1 py-0.5 rounded">malikas_verify_2026</code>{' '}
              (must match WHATSAPP_VERIFY_TOKEN)
            </div>
            <div>
              <strong>Subscribe to:</strong>{' '}
              <code className="bg-muted px-1 py-0.5 rounded">messages</code>
            </div>
          </div>
        </Card>
      </div>

      {/* ─── 6. Test send form ──────────────────────────────────────────────── */}
      <Card className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">Send a real test WhatsApp message</h2>
          <span className="text-xs text-muted-foreground">
            {isOwner ? 'Owner only' : 'Owner only — you are read-only'}
          </span>
        </div>
        {!allConfigured ? (
          <div className="text-sm text-yellow-800 bg-yellow-50 border border-yellow-300 rounded-md p-2">
            Set all three env vars first, then restart the dev server.
          </div>
        ) : tokenExpired ? (
          <div className="text-sm text-red-800 bg-red-50 border border-red-300 rounded-md p-2">
            Token expired — refresh it (see callout above) before sending. Outbound will fail otherwise.
          </div>
        ) : !isOwner ? (
          <div className="text-sm text-muted-foreground">
            You don't have permission to send. Ask the owner.
          </div>
        ) : (
          <SendTestForm onAfterSend={fetchStatus} />
        )}
      </Card>

      {/* ─── 7. Troubleshooting box ─────────────────────────────────────────── */}
      <Card className="space-y-2">
        <button
          type="button"
          onClick={() => setShowTroubleshoot((v) => !v)}
          className="w-full flex items-center justify-between text-left"
        >
          <h2 className="font-semibold">🔧 Troubleshooting</h2>
          <span className="text-xs text-muted-foreground">
            {showTroubleshoot ? 'Hide' : 'Show'}
          </span>
        </button>
        {showTroubleshoot && (
          <div className="text-sm space-y-2 pt-2 border-t border-border">
            <TroubleshootRow
              symptom="Outbound send fails (sent → failed in log)"
              fix={
                <>
                  Check token. Look for <code className="bg-muted px-1 rounded">Token expired</code> in Meta API ping.
                  Generate a fresh System User Token from Business Settings (instructions in the red callout
                  above when expiry happens).
                </>
              }
            />
            <TroubleshootRow
              symptom="Inbound messages missing (no log rows after sending from your phone)"
              fix={
                <>
                  Check ngrok is still running (the cmd window). Visit{' '}
                  <code className="bg-muted px-1 rounded">https://YOUR-NGROK.ngrok-free.app/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=malikas_verify_2026&hub.challenge=PING</code>{' '}
                  — should return <code>PING</code>. If not, restart ngrok. Then re-confirm the URL in Meta &gt;
                  Configuration &gt; Webhook.
                </>
              }
            />
            <TroubleshootRow
              symptom="AI not replying to customers"
              fix={
                <>
                  Check <code className="bg-muted px-1 rounded">WHATSAPP_LIVE_ENABLED=true</code> in{' '}
                  <code className="bg-muted px-1 rounded">.env.local</code>, then restart the dev server.
                  The Live mode banner at the top of this page must say "ENABLED" (green).
                </>
              }
            />
            <TroubleshootRow
              symptom="Conversations not appearing in /support"
              fix={
                <>
                  Open <a href="/support" className="text-primary underline">/support</a>. If you see messages
                  in <em>Recent webhook events</em> below but no conversation row, the realtime channel may
                  be paused — click the page or refresh it. If still missing, check that migration{' '}
                  <code className="bg-muted px-1 rounded">00000000000008_phase11_support.sql</code> ran on Supabase.
                </>
              }
            />
            <TroubleshootRow
              symptom="Webhook verification fails in Meta (couldn't be validated)"
              fix={
                <>
                  Most often the ngrok URL changed. Get the current URL from the ngrok terminal window,
                  paste it into Meta &gt; Webhook callback URL, click Verify and save. Keep ngrok running
                  the whole time.
                </>
              }
            />
            <TroubleshootRow
              symptom="Meta returns recipient_not_in_allowed_list"
              fix={
                <>
                  Add the recipient's phone number under <strong>Step 1. Try it out → To → Add phone number</strong>{' '}
                  in your Meta app. They'll receive a verification code on WhatsApp.
                </>
              }
            />
          </div>
        )}
      </Card>

      {/* ─── 8. Recent webhook logs ─────────────────────────────────────────── */}
      <Card className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">Recent webhook events</h2>
          <button type="button" onClick={fetchStatus} className="text-xs text-primary hover:underline">
            ↻ Refresh
          </button>
        </div>
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No webhook events yet. Once Meta is wired up and you send a test message,
            inbound events will appear here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground border-b border-border">
                <tr>
                  <th className="py-1 pr-2">When</th>
                  <th className="py-1 pr-2">Dir</th>
                  <th className="py-1 pr-2">Status</th>
                  <th className="py-1 pr-2">Phone</th>
                  <th className="py-1 pr-2">Live</th>
                  <th className="py-1 pr-2">Conv</th>
                  <th className="py-1 pr-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((row) => (
                  <tr key={row.id} className="border-b border-border/40 align-top">
                    <td className="py-1 pr-2 whitespace-nowrap">
                      {new Date(row.created_at).toLocaleTimeString()}
                    </td>
                    <td className="py-1 pr-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] ${
                          row.direction === 'inbound'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-purple-100 text-purple-800'
                        }`}
                      >
                        {row.direction}
                      </span>
                    </td>
                    <td className="py-1 pr-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] ${
                          row.status === 'sent' || row.status === 'parsed'
                            ? 'bg-green-100 text-green-800'
                            : row.status === 'failed' || row.status === 'error'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="py-1 pr-2 font-mono">{row.phone ?? '—'}</td>
                    <td className="py-1 pr-2">{row.live_enabled ? '🟢' : '🛡'}</td>
                    <td className="py-1 pr-2">
                      {row.conversation_id ? (
                        <a
                          href={`/support?id=${row.conversation_id}`}
                          className="text-primary hover:underline"
                        >
                          #{row.conversation_id}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-1 pr-2 max-w-xs truncate" title={row.payload_preview}>
                      {row.error_message ? (
                        <span className="text-red-700">{row.error_message}</span>
                      ) : (
                        <span className="text-muted-foreground">{row.payload_preview}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ChecklistItem({
  ok,
  label,
  warn = false,
  neutralIfFalse = false,
}: {
  ok: boolean;
  label: string;
  warn?: boolean;
  neutralIfFalse?: boolean;
}) {
  const icon = ok ? '✅' : warn ? '🔴' : neutralIfFalse ? '⚪' : '❌';
  const cls = ok
    ? 'text-green-800'
    : warn
      ? 'text-red-700 font-medium'
      : neutralIfFalse
        ? 'text-muted-foreground'
        : 'text-yellow-800';
  return (
    <div className={`flex items-baseline gap-2 ${cls}`}>
      <span className="text-base leading-none">{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function ConfigRow({ label, ok, hint }: { label: string; ok: boolean; hint: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="font-mono text-xs">{label}</span>
      <span className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{hint}</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
          }`}
        >
          {ok ? '✓ set' : '✗ missing'}
        </span>
      </span>
    </div>
  );
}

function TroubleshootRow({ symptom, fix }: { symptom: string; fix: ReactNode }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-2 py-1.5 border-b border-border/30 last:border-0">
      <div className="font-medium">{symptom}</div>
      <div className="text-muted-foreground">{fix}</div>
    </div>
  );
}

function SendTestForm({ onAfterSend }: { onAfterSend: () => void }) {
  const [to, setTo] = useState('');
  const [message, setMessage] = useState("Hi from Malika's Universe — automated test.");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; wamid: string }
    | { ok: false; error: string }
    | null
  >(null);

  async function handleSend() {
    if (!to || !message.trim()) return;
    setSending(true);
    setResult(null);
    try {
      const res = await fetch('/api/whatsapp/send-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, message }),
      });
      const body = await res.json();
      if (body.ok) {
        setResult({ ok: true, wamid: body.data.wamid });
        setTimeout(onAfterSend, 500);
      } else {
        setResult({ ok: false, error: body.error?.message ?? 'send failed' });
      }
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : 'network error' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-2">
        <Input
          placeholder="+97412345678"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          disabled={sending}
        />
        <Textarea
          rows={2}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={sending}
        />
      </div>
      <div className="flex items-center gap-2 justify-end">
        {result && result.ok && (
          <span className="text-xs text-green-700">
            ✓ Sent. wamid: <code className="bg-muted px-1 py-0.5 rounded">{result.wamid}</code>
          </span>
        )}
        {result && !result.ok && (
          <span className="text-xs text-red-700">✗ {result.error}</span>
        )}
        <Button onClick={handleSend} disabled={sending || !to || !message.trim()} size="sm">
          {sending ? 'Sending…' : 'Send test'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Tip: send to YOUR OWN WhatsApp number first. Meta blocks sending to numbers
        that haven't messaged you yet, unless you use a pre-approved template.
      </p>
    </div>
  );
}
