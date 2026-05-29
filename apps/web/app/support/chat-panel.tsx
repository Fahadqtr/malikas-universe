'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Card, Textarea } from '@/components/ui';
import type { ConversationRow } from './conversations-list';
import { SlaBadge } from './sla-badge';

export type Message = {
  id: number;
  direction: 'inbound' | 'outbound';
  body: string;
  media_url: string | null;
  ai_model: string | null;
  intent: string | null;
  tools_called: Array<{ name: string; input: Record<string, unknown> }> | null;
  created_at: string;
};

export type Note = {
  id: number;
  body: string;
  author_email: string;
  author_name: string | null;
  kind: 'note' | 'system' | 'action' | 'escalation';
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type ConversationDetail = {
  conversation: ConversationRow & {
    assigned_agent: { id: number; display_name: string; email: string; role: string; avatar_url: string | null } | null;
  };
  messages: Message[];
  notes: Note[];
  tags: Array<{ tag: string; added_by: string; created_at: string }>;
  assignment_log: Array<{ id: number; action: string; actor_email: string; created_at: string }>;
};

export function ChatPanel({
  detail,
  conversationRow,
  onRefresh,
  onError,
}: {
  detail: ConversationDetail | null;
  conversationRow: ConversationRow | null;
  onRefresh: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<'human' | 'ai' | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);

  // Track scroll position — only auto-scroll if user is already near the bottom
  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  // Auto-scroll on new messages — ONLY if user is near the bottom
  useEffect(() => {
    if (threadRef.current && nearBottomRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [detail?.messages.length]);

  // Reset nearBottom when switching conversations
  useEffect(() => {
    nearBottomRef.current = true;
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [detail?.conversation.id]);

  // ─── Empty state ──────────────────────────────────────────────────────────
  if (!detail || !conversationRow) {
    return (
      <Card className="flex items-center justify-center text-sm text-muted-foreground" style={{ minHeight: 600 }}>
        Select a conversation from the left to start.
      </Card>
    );
  }

  const conv = detail.conversation;
  const isHuman = !conv.ai_enabled;

  // ─── Send handlers ────────────────────────────────────────────────────────
  async function sendHuman() {
    if (!draft.trim() || sending) return;
    setSending('human');
    onError(null);
    try {
      const res = await fetch(`/api/support/conversations/${conv.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'human', body: draft }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message ?? 'send failed');
      setDraft('');
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(null);
    }
  }

  async function triggerAi() {
    if (sending) return;
    setSending('ai');
    onError(null);
    try {
      const res = await fetch(`/api/support/conversations/${conv.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'ai' }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message ?? 'AI failed');
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'AI failed');
    } finally {
      setSending(null);
    }
  }

  // Merge messages + system notes into a unified timeline (system notes
  // appear inline as small gray rows so staff see context)
  const timeline = mergeTimeline(detail.messages, detail.notes);

  return (
    <Card className="!p-0 flex flex-col overflow-hidden" style={{ minHeight: 600 }}>
      {/* Header */}
      <div className="border-b border-border p-3 bg-muted/30">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">{conv.customer_name ?? conv.customer_phone}</div>
            <div className="text-xs text-muted-foreground font-mono">
              {conv.customer_phone}
              {conv.language && ` · ${conv.language}`}
              {' · '}
              {conv.total_messages} msgs
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SlaBadge
              lastInboundAt={
                [...detail.messages].reverse().find((m) => m.direction === 'inbound')?.created_at ?? null
              }
              lastOutboundAt={
                [...detail.messages].reverse().find((m) => m.direction === 'outbound')?.created_at ?? null
              }
              status={conv.status}
            />
            {conv.escalated && (
              <span className="text-[10px] uppercase font-semibold px-2 py-1 rounded bg-destructive text-destructive-foreground">
                ⚠ Escalated
              </span>
            )}
            <span
              className={`text-[10px] uppercase font-semibold px-2 py-1 rounded ${
                isHuman ? 'bg-purple-600 text-white' : 'bg-blue-500 text-white'
              }`}
            >
              {isHuman ? '👤 Human mode' : '🤖 AI auto-reply'}
            </span>
          </div>
        </div>
      </div>

      {/* Thread */}
      <div
        ref={threadRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto p-4 space-y-2 bg-[#e6dfd2]/30"
        style={{ minHeight: 0 }}
      >
        {timeline.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-12">
            No messages yet.
          </div>
        ) : (
          timeline.map((t) =>
            t.type === 'msg' ? (
              <MessageBubble key={`m-${t.msg.id}`} m={t.msg} />
            ) : (
              <SystemNote key={`n-${t.note.id}`} n={t.note} />
            ),
          )
        )}
        {sending === 'ai' && (
          <div className="flex justify-start">
            <div className="bg-white rounded-lg px-3 py-2 text-sm italic text-muted-foreground shadow-sm">
              🤖 AI thinking…
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <span className={`px-2 py-0.5 rounded-full font-medium ${isHuman ? 'bg-purple-100 text-purple-900' : 'bg-blue-100 text-blue-900'}`}>
            {isHuman ? 'Replying as: HUMAN' : 'AI is auto-replying to incoming msgs'}
          </span>
          <div className="flex-1" />
          {!isHuman && (
            <span className="text-[10px] text-muted-foreground">
              ⚠ Disable AI in the right panel to control replies manually
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendHuman();
              }
            }}
            placeholder="Type your reply (Ctrl/Cmd+Enter to send)…"
            className="flex-1 !min-h-[80px] resize-none"
            dir={/[؀-ۿ]/.test(draft) ? 'rtl' : 'ltr'}
          />
          <div className="flex flex-col gap-2">
            <Button onClick={sendHuman} disabled={!draft.trim() || sending !== null}>
              {sending === 'human' ? 'Sending…' : 'Send (human)'}
            </Button>
            <Button variant="secondary" onClick={triggerAi} disabled={sending !== null}>
              {sending === 'ai' ? '…' : '🤖 Ask AI'}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function MessageBubble({ m }: { m: Message }) {
  const isCustomer = m.direction === 'inbound';
  const isAi = !!m.ai_model;
  const isHuman = m.direction === 'outbound' && !m.ai_model;
  const dir = /[؀-ۿ]/.test(m.body) ? 'rtl' : 'ltr';

  return (
    <div className={`flex ${isCustomer ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[80%]">
        <div
          dir={dir}
          className={`rounded-lg px-3 py-2 text-sm leading-snug whitespace-pre-wrap shadow-sm
            ${isCustomer
              ? 'bg-[#dcf8c6] text-black'
              : isAi
                ? 'bg-white text-black'
                : 'bg-purple-50 text-black border border-purple-200'}
          `}
        >
          {m.body}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5 px-1">
          {isCustomer ? '◀' : '▶'}
          <span>{new Date(m.created_at).toLocaleString()}</span>
          {isAi && <span>· 🤖 AI</span>}
          {isHuman && <span>· 👤 Staff</span>}
        </div>
      </div>
    </div>
  );
}

function SystemNote({ n }: { n: Note }) {
  const colorMap: Record<Note['kind'], string> = {
    note: 'bg-muted/50 text-muted-foreground',
    system: 'bg-blue-50 text-blue-900',
    action: 'bg-yellow-50 text-yellow-900',
    escalation: 'bg-destructive/10 text-destructive',
  };
  return (
    <div className="flex justify-center my-2">
      <div className={`text-[11px] px-2 py-0.5 rounded-full ${colorMap[n.kind] ?? colorMap.note}`}>
        {n.kind === 'escalation' && '⚠ '}
        {n.kind === 'system' && '⚙ '}
        {n.kind === 'action' && '🎯 '}
        {n.body}
        <span className="opacity-60 ml-1.5">· {n.author_name ?? n.author_email}</span>
      </div>
    </div>
  );
}

type TimelineItem = { type: 'msg'; msg: Message; ts: number } | { type: 'note'; note: Note; ts: number };

function mergeTimeline(messages: Message[], notes: Note[]): TimelineItem[] {
  // Only show notes inline that are 'system' or 'escalation' kind
  // (user-written 'note' kind goes in the right panel)
  const items: TimelineItem[] = [];
  for (const m of messages) {
    items.push({ type: 'msg', msg: m, ts: new Date(m.created_at).getTime() });
  }
  for (const n of notes) {
    if (n.kind === 'system' || n.kind === 'escalation') {
      items.push({ type: 'note', note: n, ts: new Date(n.created_at).getTime() });
    }
  }
  items.sort((a, b) => a.ts - b.ts);
  return items;
}
