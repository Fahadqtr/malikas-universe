'use client';

import { Card, Input, Select } from '@/components/ui';
import { SlaBadge } from './sla-badge';

export type ConversationRow = {
  id: number;
  customer_phone: string;
  customer_name: string | null;
  language: string | null;
  status: string;
  escalated: boolean;
  priority: string;
  ai_enabled: boolean;
  assigned_to: number | null;
  last_message_at: string | null;
  last_message_body: string | null;
  last_message_direction: 'inbound' | 'outbound' | null;
  unread_count: number;
  tags: string[];
  assigned_name: string | null;
  total_messages: number;
  created_at: string;
};

const PRIORITY_COLOR: Record<string, string> = {
  urgent: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  medium: 'bg-yellow-400 text-yellow-900',
  low: 'bg-muted text-muted-foreground',
};

export function ConversationsList({
  conversations,
  selectedId,
  onSelect,
  filterStatus,
  setFilterStatus,
  filterAssigned,
  setFilterAssigned,
  search,
  setSearch,
}: {
  conversations: ConversationRow[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  filterStatus: 'open' | 'escalated' | 'resolved' | 'spam' | 'all';
  setFilterStatus: (v: 'open' | 'escalated' | 'resolved' | 'spam' | 'all') => void;
  filterAssigned: 'all' | 'unassigned' | 'me';
  setFilterAssigned: (v: 'all' | 'unassigned' | 'me') => void;
  search: string;
  setSearch: (v: string) => void;
}) {
  return (
    <Card className="!p-0 flex flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="border-b border-border p-2 space-y-2 bg-muted/30">
        <Input
          placeholder="Search phone or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-sm"
        />
        <div className="grid grid-cols-2 gap-2">
          <Select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as never)} className="text-xs">
            <option value="open">Open</option>
            <option value="escalated">Escalated</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </Select>
          <Select value={filterAssigned} onChange={(e) => setFilterAssigned(e.target.value as never)} className="text-xs">
            <option value="all">All</option>
            <option value="unassigned">Unassigned</option>
            <option value="me">Mine</option>
          </Select>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No conversations match these filters.
          </div>
        ) : (
          conversations.map((c) => (
            <ConversationRowItem
              key={c.id}
              c={c}
              selected={c.id === selectedId}
              onClick={() => onSelect(c.id)}
            />
          ))
        )}
      </div>

      {/* Footer count */}
      <div className="border-t border-border px-2 py-1 text-[11px] text-muted-foreground bg-muted/30">
        {conversations.length} conversation{conversations.length !== 1 ? 's' : ''}
      </div>
    </Card>
  );
}

function ConversationRowItem({
  c,
  selected,
  onClick,
}: {
  c: ConversationRow;
  selected: boolean;
  onClick: () => void;
}) {
  const isUnread = c.unread_count > 0;
  const preview = c.last_message_body
    ? c.last_message_body.replace(/\s+/g, ' ').slice(0, 80)
    : '(no messages)';
  const isAr = /[؀-ۿ]/.test(preview);
  const ago = relativeTime(c.last_message_at ?? c.created_at);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left p-2.5 border-b border-border transition-colors block
        ${selected ? 'bg-primary/10 border-l-4 border-l-primary' : isUnread ? 'bg-blue-50' : 'hover:bg-muted/30'}
      `}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-mono font-medium ${isUnread ? 'text-foreground' : 'text-muted-foreground'}`}>
              {c.customer_name ?? c.customer_phone}
            </span>
            {c.language && (
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                · {c.language}
              </span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground font-mono">{c.customer_phone}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {isUnread && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-blue-600 text-white min-w-[18px] text-center">
              {c.unread_count}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">{ago}</span>
        </div>
      </div>

      <div
        className="text-xs text-muted-foreground line-clamp-2 leading-snug"
        dir={isAr ? 'rtl' : 'ltr'}
        title={preview}
      >
        {c.last_message_direction === 'outbound' && <span className="text-[10px] text-muted-foreground/70">↗ </span>}
        {preview}
      </div>

      {/* Badge row */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span
          className={`text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded ${PRIORITY_COLOR[c.priority] ?? PRIORITY_COLOR.medium}`}
        >
          {c.priority}
        </span>
        <SlaBadge
          lastInboundAt={c.last_message_direction === 'inbound' ? c.last_message_at : null}
          lastOutboundAt={c.last_message_direction === 'outbound' ? c.last_message_at : null}
          status={c.status}
        />
        {c.escalated && (
          <span className="text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded bg-destructive text-destructive-foreground">
            ⚠ escalated
          </span>
        )}
        {!c.ai_enabled && (
          <span className="text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded bg-purple-600 text-white">
            👤 human
          </span>
        )}
        {c.ai_enabled && (
          <span className="text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded bg-blue-500 text-white">
            🤖 AI
          </span>
        )}
        {c.assigned_name && (
          <span className="text-[10px] text-muted-foreground truncate max-w-[100px]" title={c.assigned_name}>
            · {c.assigned_name}
          </span>
        )}
      </div>
    </button>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}
