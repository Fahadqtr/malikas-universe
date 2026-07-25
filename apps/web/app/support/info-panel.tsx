'use client';

import { useState } from 'react';
import { Button, Card, Input, Label, Select, Textarea } from '@/components/ui';
import type { ConversationDetail } from './chat-panel';

type Agent = { id: number; display_name: string; email: string; role: string };

const QUICK_ACTIONS: Array<{
  id: 'recommend_products' | 'escalate' | 'send_coupon' | 'request_photos' | 'refund_issue' | 'fake_product_claim' | 'delivery_issue';
  label: string;
  color: string;
  warn?: boolean;
}> = [
  { id: 'recommend_products', label: '🛍 Recommend products', color: 'bg-muted' },
  { id: 'request_photos', label: '📸 Request photos', color: 'bg-muted' },
  { id: 'delivery_issue', label: '🚚 Delivery issue', color: 'bg-muted' },
  { id: 'send_coupon', label: '🎟 Coupon (draft only)', color: 'bg-yellow-100', warn: true },
  { id: 'refund_issue', label: '💰 Refund issue', color: 'bg-orange-100', warn: true },
  { id: 'fake_product_claim', label: '🚨 Fake product claim', color: 'bg-red-100', warn: true },
  { id: 'escalate', label: '⚠ Escalate to lead', color: 'bg-destructive/10', warn: true },
];

export function InfoPanel({
  detail,
  agents,
  onRefresh,
  onError,
}: {
  detail: ConversationDetail | null;
  agents: Agent[];
  onRefresh: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [actionDraft, setActionDraft] = useState<{ ar: string; en: string } | null>(null);
  const [tagDraft, setTagDraft] = useState('');

  if (!detail) {
    return (
      <Card className="text-sm text-muted-foreground">
        Pick a conversation to see customer info, notes, and actions.
      </Card>
    );
  }

  const conv = detail.conversation;

  // ─── Mutation helpers ─────────────────────────────────────────────────────
  async function patch(payload: Record<string, unknown>) {
    onError(null);
    try {
      const res = await fetch(`/api/support/conversations/${conv.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message ?? 'patch failed');
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Action failed');
    }
  }

  async function addNote() {
    if (!noteDraft.trim()) return;
    setSavingNote(true);
    onError(null);
    try {
      const res = await fetch(`/api/support/conversations/${conv.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: noteDraft, kind: 'note' }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message ?? 'note failed');
      setNoteDraft('');
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save note failed');
    } finally {
      setSavingNote(false);
    }
  }

  async function runAction(actionId: string) {
    if (runningAction) return;
    setRunningAction(actionId);
    onError(null);
    try {
      const res = await fetch(`/api/support/conversations/${conv.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: actionId }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message ?? 'action failed');
      setActionDraft({ ar: body.data.draft_ar, en: body.data.draft_en });
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setRunningAction(null);
    }
  }

  async function addTag() {
    if (!tagDraft.trim()) return;
    await patch({ add_tag: tagDraft.trim().toLowerCase().replace(/\s+/g, '_') });
    setTagDraft('');
  }

  // User notes only (system notes appear in the chat thread)
  const userNotes = detail.notes.filter((n) => n.kind === 'note' || n.kind === 'action' || n.kind === 'escalation');

  return (
    <div className="space-y-3 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
      {/* Status + AI toggle */}
      <Card className="!p-3 space-y-3">
        <div className="space-y-1.5">
          <Label>Status</Label>
          <Select value={conv.status} onChange={(e) => patch({ status: e.target.value })}>
            <option value="open">Open</option>
            <option value="escalated">Escalated</option>
            <option value="resolved">Resolved</option>
            <option value="spam">Spam</option>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Priority</Label>
          <Select value={conv.priority} onChange={(e) => patch({ priority: e.target.value })}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Assigned to</Label>
          <Select
            value={conv.assigned_to ?? ''}
            onChange={(e) => patch({ assigned_to: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">— Unassigned —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name} ({a.role})
              </option>
            ))}
          </Select>
        </div>

        {/* AI toggle */}
        <div className="flex items-center justify-between rounded-md border border-border p-2.5 bg-muted/30">
          <div>
            <div className="text-sm font-medium">
              {conv.ai_enabled ? '🤖 AI auto-reply ON' : '👤 Human mode ON'}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {conv.ai_enabled
                ? 'Incoming customer messages get AI replies.'
                : 'Only staff replies will be sent.'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => patch({ ai_enabled: !conv.ai_enabled })}
            className={`px-3 py-1 rounded text-xs font-medium ${
              conv.ai_enabled
                ? 'bg-purple-600 text-white hover:bg-purple-700'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {conv.ai_enabled ? 'Take over' : 'Re-enable AI'}
          </button>
        </div>

        {conv.status !== 'resolved' && (
          <Button
            variant="secondary"
            onClick={() => patch({ resolved: true })}
            className="w-full"
          >
            ✓ Mark resolved
          </Button>
        )}
      </Card>

      {/* Tags */}
      <Card className="!p-3 space-y-2">
        <Label>Tags</Label>
        <div className="flex flex-wrap gap-1">
          {detail.tags.length === 0 ? (
            <span className="text-xs text-muted-foreground">No tags yet.</span>
          ) : (
            detail.tags.map((t) => (
              <span
                key={t.tag}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-xs"
              >
                {t.tag}
                <button
                  type="button"
                  onClick={() => patch({ remove_tag: t.tag })}
                  className="text-muted-foreground hover:text-destructive text-[10px] ml-0.5"
                  title="Remove tag"
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
        <div className="flex gap-1">
          <Input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTag()}
            placeholder="Add tag…"
            className="text-xs"
          />
          <Button size="sm" variant="ghost" onClick={addTag} disabled={!tagDraft.trim()}>
            +
          </Button>
        </div>
      </Card>

      {/* Quick actions */}
      <Card className="!p-3 space-y-2">
        <Label>Quick actions</Label>
        <p className="text-[11px] text-muted-foreground">
          Each action drafts a reply. Nothing is sent until you click Send in the chat.
        </p>
        <div className="space-y-1">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={runningAction !== null}
              onClick={() => runAction(a.id)}
              className={`w-full text-left text-xs px-2 py-1.5 rounded border border-border ${a.color} hover:opacity-80 disabled:opacity-50 ${a.warn ? 'border-destructive/30' : ''}`}
            >
              {runningAction === a.id ? '…' : a.label}
            </button>
          ))}
        </div>

        {/* Action draft preview */}
        {actionDraft && (
          <div className="mt-2 rounded-md border border-yellow-300 bg-yellow-50 p-2 text-xs space-y-2">
            <div className="font-semibold text-yellow-900">
              Draft ready — copy into the chat composer, edit, and click Send.
            </div>
            <details>
              <summary className="cursor-pointer text-yellow-800">العربية</summary>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-[11px]" dir="rtl">{actionDraft.ar}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-yellow-800">English</summary>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-[11px]">{actionDraft.en}</pre>
            </details>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(actionDraft.ar);
                alert('Arabic draft copied — paste into composer');
              }}
              className="text-[10px] text-primary hover:underline"
            >
              Copy AR
            </button>
            {' · '}
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(actionDraft.en);
                alert('English draft copied — paste into composer');
              }}
              className="text-[10px] text-primary hover:underline"
            >
              Copy EN
            </button>
            {' · '}
            <button
              type="button"
              onClick={() => setActionDraft(null)}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        )}
      </Card>

      {/* Internal notes timeline */}
      <Card className="!p-3 space-y-2">
        <Label>Internal notes</Label>
        <p className="text-[11px] text-muted-foreground">Not visible to the customer.</p>

        <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
          {userNotes.length === 0 ? (
            <div className="text-xs text-muted-foreground">No notes yet.</div>
          ) : (
            userNotes.map((n) => (
              <div key={n.id} className="rounded-md border border-border bg-muted/30 p-2 text-xs">
                <div className="flex items-baseline justify-between mb-0.5">
                  <span className="font-medium">{n.author_name ?? n.author_email}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(n.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="text-foreground whitespace-pre-wrap">{n.body}</div>
                {n.kind !== 'note' && (
                  <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{n.kind}</span>
                )}
              </div>
            ))
          )}
        </div>

        <Textarea
          rows={3}
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          placeholder="Add an internal note…"
        />
        <Button
          size="sm"
          onClick={addNote}
          disabled={!noteDraft.trim() || savingNote}
          className="w-full"
        >
          {savingNote ? 'Saving…' : '+ Add note'}
        </Button>
      </Card>
    </div>
  );
}
