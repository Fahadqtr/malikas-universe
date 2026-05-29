'use client';

/**
 * TestChat — interactive console for the WhatsApp AI agent.
 *
 * Left:   WhatsApp-style chat thread (you = customer, AI = agent)
 * Right:  Inspector panel — tool calls, matched products, escalations, cost
 *
 * The customer_phone is a fake test number — change it to start a fresh
 * conversation. Resetting clears state on the client only; DB conversation
 * persists with the phone as the key.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Input, Textarea } from '@/components/ui';

type AgentReply = {
  conversation_id: number;
  reply: string;
  matched_products: Array<{
    master_sku: string;
    name_en: string;
    name_ar: string;
    brand: string;
    category: string;
    price_qar: number;
    image_url: string | null;
  }>;
  escalations: Array<{ reason: string; summary: string; severity: string }>;
  tool_calls: Array<{ name: string; input: Record<string, unknown>; output: unknown }>;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number; latency_ms: number };
  language: 'ar' | 'en' | 'mixed';
};

type ChatTurn =
  | { role: 'customer'; body: string; ts: number }
  | { role: 'agent'; body: string; ts: number; meta: AgentReply };

const SAMPLE_PROMPTS = [
  { label: 'AR — looking for product', text: 'هلا، أبي ترطيب لبشرة جافة' },
  { label: 'AR — by brand', text: 'تبيعون ميديكيوب؟' },
  { label: 'AR — complaint (escalation)', text: 'وصلني منتج فيه شعر ، أبي استرجاع' },
  { label: 'EN — vague', text: 'I need something for my skin' },
  { label: 'EN — specific', text: 'Do you have COSRX snail mucin essence?' },
  { label: 'EN — order (escalation)', text: "Where's my order? I ordered 3 days ago" },
];

const DEFAULT_PHONE = '+97455500001';

export function TestChat() {
  const [phone, setPhone] = useState(DEFAULT_PHONE);
  const [name, setName] = useState('Test Customer');
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll thread to bottom
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [turns, pending]);

  const stats = useMemo(() => {
    let cost = 0;
    let inTokens = 0;
    let outTokens = 0;
    for (const t of turns) {
      if (t.role === 'agent') {
        cost += t.meta.usage.cost_usd;
        inTokens += t.meta.usage.input_tokens;
        outTokens += t.meta.usage.output_tokens;
      }
    }
    return { cost, inTokens, outTokens, turns: turns.length };
  }, [turns]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;

      const now = Date.now();
      setTurns((prev) => [...prev, { role: 'customer', body: trimmed, ts: now }]);
      setDraft('');
      setPending(true);
      setError(null);

      try {
        const res = await fetch('/api/whatsapp/reply-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_phone: phone,
            customer_name: name || undefined,
            message_body: trimmed,
          }),
        });
        const body = await res.json();
        if (!res.ok || !body.ok) {
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        }
        const reply = body.data as AgentReply;
        setConversationId(reply.conversation_id);
        setTurns((prev) => [
          ...prev,
          { role: 'agent', body: reply.reply, ts: Date.now(), meta: reply },
        ]);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Send failed');
      } finally {
        setPending(false);
      }
    },
    [phone, name, pending],
  );

  function resetClient() {
    setTurns([]);
    setConversationId(null);
    setError(null);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
      {/* LEFT — chat */}
      <Card className="!p-0 overflow-hidden flex flex-col" style={{ minHeight: 600 }}>
        {/* Chat header */}
        <div className="border-b border-border bg-muted/30 p-3 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
              Customer phone
            </label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="flex-1 min-w-[150px]">
            <label className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
              Customer name (optional)
            </label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button variant="ghost" size="sm" onClick={resetClient} disabled={pending}>
            Reset view
          </Button>
        </div>

        {/* Thread */}
        <div
          ref={threadRef}
          className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#e6dfd2]/30"
        >
          {turns.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-12">
              Send a message to start the conversation.
              <br />
              <span className="text-xs">Try one of the samples on the right →</span>
            </div>
          )}

          {turns.map((t, i) => (
            <Bubble key={i} role={t.role} body={t.body} />
          ))}

          {pending && (
            <Bubble role="agent" body="…" italic />
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border p-3 space-y-2">
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">
              ⚠ {error}
            </div>
          )}
          <div className="flex gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage(draft);
                }
              }}
              placeholder="اكتب رسالة كأنك العميل... (Enter = send, Shift+Enter = newline)"
              className="flex-1 !min-h-[60px] resize-none"
            />
            <Button onClick={() => sendMessage(draft)} disabled={pending || !draft.trim()}>
              {pending ? 'Thinking…' : 'Send'}
            </Button>
          </div>
        </div>
      </Card>

      {/* RIGHT — inspector */}
      <div className="space-y-4">
        {/* Stats */}
        <Card className="!p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Conversation
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">ID</div>
              <div className="font-mono">{conversationId ?? '—'}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">Turns</div>
              <div>{stats.turns}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">Tokens (in/out)</div>
              <div>{stats.inTokens} / {stats.outTokens}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">Total cost</div>
              <div className="font-medium">${stats.cost.toFixed(4)}</div>
            </div>
          </div>
        </Card>

        {/* Sample prompts */}
        <Card className="!p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Sample prompts
          </div>
          <div className="space-y-1.5">
            {SAMPLE_PROMPTS.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => sendMessage(s.text)}
                disabled={pending}
                className="w-full text-left text-xs px-2 py-1.5 rounded bg-muted hover:bg-accent disabled:opacity-50"
              >
                <div className="font-medium">{s.label}</div>
                <div className="text-muted-foreground truncate">{s.text}</div>
              </button>
            ))}
          </div>
        </Card>

        {/* Last reply inspector */}
        {turns.length > 0 && turns[turns.length - 1].role === 'agent' && (
          <ReplyInspector reply={(turns[turns.length - 1] as Extract<ChatTurn, { role: 'agent' }>).meta} />
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function Bubble({ role, body, italic }: { role: 'customer' | 'agent'; body: string; italic?: boolean }) {
  const isCustomer = role === 'customer';
  const dir = /[؀-ۿ]/.test(body) ? 'rtl' : 'ltr';
  return (
    <div className={`flex ${isCustomer ? 'justify-end' : 'justify-start'}`}>
      <div
        dir={dir}
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm leading-snug whitespace-pre-wrap shadow-sm
          ${isCustomer ? 'bg-[#dcf8c6] text-black' : 'bg-white text-black'}
          ${italic ? 'italic text-muted-foreground' : ''}
        `}
      >
        {body}
      </div>
    </div>
  );
}

function ReplyInspector({ reply }: { reply: AgentReply }) {
  return (
    <Card className="!p-3 space-y-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Last reply · {reply.language} · {reply.usage.latency_ms}ms · ${reply.usage.cost_usd.toFixed(4)}
      </div>

      {/* Escalations */}
      {reply.escalations.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs space-y-1">
          <div className="font-semibold text-destructive uppercase">
            ⚠ Escalated · {reply.escalations[0].severity}
          </div>
          <div><span className="font-medium">Reason:</span> {reply.escalations[0].reason}</div>
          <div><span className="font-medium">Summary:</span> {reply.escalations[0].summary}</div>
        </div>
      )}

      {/* Matched products */}
      {reply.matched_products.length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-1.5">
            Products surfaced ({reply.matched_products.length})
          </div>
          <div className="space-y-1.5">
            {reply.matched_products.map((p) => (
              <div key={p.master_sku} className="flex items-center gap-2 text-xs">
                {p.image_url ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={p.image_url} alt="" className="w-10 h-10 rounded object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded bg-muted" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{p.name_en || p.name_ar}</div>
                  <div className="text-muted-foreground truncate">
                    {p.brand} · {p.category} · QAR {Number(p.price_qar).toFixed(2)}
                  </div>
                </div>
                <a
                  href={`/products/${p.master_sku}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline text-[11px]"
                >
                  →
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool calls */}
      {reply.tool_calls.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Tool calls ({reply.tool_calls.length})
          </summary>
          <div className="mt-2 space-y-2">
            {reply.tool_calls.map((t, i) => (
              <div key={i} className="rounded border border-border p-2 space-y-1">
                <div className="font-mono text-[11px] font-medium">{t.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  <span className="font-medium">in:</span> {JSON.stringify(t.input)}
                </div>
                <details>
                  <summary className="text-[11px] text-muted-foreground cursor-pointer">
                    output
                  </summary>
                  <pre className="text-[10px] mt-1 bg-muted/50 p-1 rounded overflow-x-auto">
                    {typeof t.output === 'string'
                      ? t.output
                      : JSON.stringify(t.output, null, 2)}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
