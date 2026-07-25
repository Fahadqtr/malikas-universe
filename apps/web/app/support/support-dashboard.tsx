'use client';

/**
 * SupportDashboard — top-level client wrapper.
 *
 * Manages selected conversation + realtime + presence + notifications.
 * Renders <MetricsBar> + 3-panel grid (List · Chat · Info) + ToastList.
 *
 * Realtime architecture:
 *   • Supabase Realtime subscriptions (messages/conversations/notes/escalations/
 *     notification_events) → debounced refresh + toast + sound
 *   • Polling fallback every 60s (network blips, missed events)
 *   • Browser title updates with unread count
 *   • Presence channel shows who else is online + viewing each conversation
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConversationsList, type ConversationRow } from './conversations-list';
import { ChatPanel, type ConversationDetail } from './chat-panel';
import { InfoPanel } from './info-panel';
import { MetricsBar, type SupportMetrics } from './metrics-bar';
import { ToastList } from './toast-list';
import { NotificationControls } from './notification-controls';
import { IncomingCallModal, clearIncomingCall } from './incoming-call-modal';
import { useSupportRealtime } from './use-realtime';
import { useUnreadTitle } from './use-unread';
import { usePresence } from './use-presence';
import { stopRinging } from '@/lib/notifications';

// Polling fallback (realtime may miss events on flaky networks)
const REFRESH_INTERVAL_MS = 60000;

export function SupportDashboard({
  initialConversationId,
}: {
  initialConversationId: number | null;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(initialConversationId);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [metrics, setMetrics] = useState<SupportMetrics | null>(null);
  const [agents, setAgents] = useState<Array<{ id: number; display_name: string; email: string; role: string }>>([]);
  const [bannerError, setBannerError] = useState<string | null>(null);

  // Filters
  const [filterStatus, setFilterStatus] = useState<'open' | 'escalated' | 'resolved' | 'spam' | 'all'>('open');
  const [filterAssigned, setFilterAssigned] = useState<'all' | 'unassigned' | 'me'>('all');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // ─── Fetchers ─────────────────────────────────────────────────────────────
  const fetchList = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        status: filterStatus,
        assigned: filterAssigned,
        limit: '60',
      });
      if (searchDebounced) params.set('q', searchDebounced);
      const res = await fetch(`/api/support/conversations?${params}`);
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message ?? 'failed');
      setConversations(body.data.items);
    } catch (e) {
      setBannerError(e instanceof Error ? e.message : 'List load failed');
    }
  }, [filterStatus, filterAssigned, searchDebounced]);

  const fetchDetail = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/support/conversations/${id}`);
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message ?? 'failed');
      setDetail(body.data);
    } catch (e) {
      setBannerError(e instanceof Error ? e.message : 'Detail load failed');
    }
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/support/metrics');
      const body = await res.json();
      if (body.ok) setMetrics(body.data);
    } catch {
      // non-fatal
    }
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/support/agents');
      const body = await res.json();
      if (body.ok) setAgents(body.data.items);
    } catch {
      // non-fatal
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  useEffect(() => {
    void fetchMetrics();
    const t = setInterval(fetchMetrics, REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [fetchMetrics]);

  // Detail when selected changes
  useEffect(() => {
    if (selectedId == null) {
      setDetail(null);
      return;
    }
    // Opening a conversation = stop any active ring for it + clear popup
    stopRinging('accepted');
    clearIncomingCall(selectedId);
    void fetchDetail(selectedId);
    // Light polling for new messages while a conversation is open
    const t = setInterval(() => fetchDetail(selectedId), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [selectedId, fetchDetail]);

  // Listen to popstate (Accept button in modal uses pushState + popstate)
  useEffect(() => {
    function onPop() {
      const params = new URLSearchParams(window.location.search);
      const id = params.get('id');
      const n = id ? Number(id) : null;
      if (n && Number.isFinite(n)) setSelectedId(n);
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Auto-select first conversation if nothing selected
  useEffect(() => {
    if (selectedId == null && conversations.length > 0) {
      setSelectedId(conversations[0]!.id);
    }
  }, [conversations, selectedId]);

  // ─── Mutations ────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    await fetchList();
    if (selectedId) await fetchDetail(selectedId);
    void fetchMetrics();
  }, [fetchList, fetchDetail, fetchMetrics, selectedId]);

  // ─── Realtime + presence + unread title ───────────────────────────────────

  // Load current actor's agent identity for presence
  const [me, setMe] = useState<{
    agent_id: number | null;
    email: string;
    name: string;
    viewing_conversation_id: number | null;
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/support/me');
        const body = await res.json();
        if (body.ok) {
          setMe({
            agent_id: body.data.agent?.id ?? null,
            email: body.data.actor.email,
            name: body.data.agent?.display_name ?? body.data.actor.email,
            viewing_conversation_id: null,
          });
        }
      } catch {
        // non-fatal
      }
    })();
  }, []);

  // Helper for realtime to format toast labels
  const getConversationLabel = useCallback(
    (id: number) => {
      const c = conversations.find((x) => x.id === id);
      if (!c) return `Conversation #${id}`;
      return c.customer_name ?? c.customer_phone;
    },
    [conversations],
  );

  useSupportRealtime({
    onRefresh: refresh,
    selectedConversationId: selectedId,
    getConversationLabel,
  });

  useUnreadTitle(conversations);

  const { onlineAgents } = usePresence(me, selectedId);

  // Total unread across all open conversations (for header badge)
  const unreadTotal = useMemo(() => {
    return conversations
      .filter((c) => c.status === 'open' || c.status === 'escalated')
      .reduce((s, c) => s + c.unread_count, 0);
  }, [conversations]);

  // ─── Render ───────────────────────────────────────────────────────────────
  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  return (
    <div className="space-y-3">
      {/* Realtime controls row */}
      <div className="flex items-center justify-end">
        <NotificationControls onlineAgents={onlineAgents} unreadTotal={unreadTotal} />
      </div>

      <MetricsBar metrics={metrics} />

      {bannerError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive p-2 text-sm flex items-center justify-between">
          <span>⚠ {bannerError}</span>
          <button onClick={() => setBannerError(null)} className="text-xs hover:underline">dismiss</button>
        </div>
      )}

      <ToastList />
      <IncomingCallModal />

      {/* 3-panel grid — collapses to 1 col on mobile, 2 cols on tablet, 3 on desktop */}
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] xl:grid-cols-[320px_1fr_360px] gap-3 min-h-[700px]">
        <ConversationsList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={setSelectedId}
          filterStatus={filterStatus}
          setFilterStatus={setFilterStatus}
          filterAssigned={filterAssigned}
          setFilterAssigned={setFilterAssigned}
          search={search}
          setSearch={setSearch}
        />

        <ChatPanel
          detail={detail}
          conversationRow={selected}
          onRefresh={refresh}
          onError={setBannerError}
        />

        <InfoPanel
          detail={detail}
          agents={agents}
          onRefresh={refresh}
          onError={setBannerError}
        />
      </div>
    </div>
  );
}
