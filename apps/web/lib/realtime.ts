'use client';

/**
 * Realtime channel manager for the Support Center.
 *
 * Wraps Supabase Realtime so the rest of the UI subscribes to typed events
 * instead of raw postgres_changes blobs.
 *
 * Channels:
 *   • `support`         — table changes (messages, conversations, support_notes,
 *                         escalations, notification_events)
 *   • `support-presence`— who is online, what each agent is viewing
 *   • `conv-<id>`       — per-conversation typing indicators (broadcast only)
 *
 * Design choices:
 *   • Single Supabase client per browser session (createBrowserSupabaseClient)
 *   • One shared `support` channel for the dashboard — all listeners attach
 *     to it via .on() so we don't open a websocket per component
 *   • Presence and typing use Supabase's broadcast/presence features, NOT
 *     postgres tables (transient state)
 *
 * Public API:
 *   getSupabaseBrowserClient()  — singleton accessor
 *   subscribeToSupport(handlers) — table-change subscriptions
 *   joinPresence(agent)          — track presence, returns leave() fn
 *   joinTypingChannel(convId, agent) — typing broadcast
 *
 * Cleanup pattern:
 *   const unsub = subscribeToSupport({...});
 *   // ...later
 *   unsub();
 */

import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

// ─── Singleton browser client ────────────────────────────────────────────────

let _client: SupabaseClient | null = null;
export function getSupabaseBrowserClient(): SupabaseClient {
  if (!_client) _client = createBrowserSupabaseClient() as unknown as SupabaseClient;
  return _client;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type SupportEventHandlers = {
  onMessageInsert?: (row: MessageRow) => void;
  onMessageUpdate?: (row: MessageRow) => void;
  onConversationInsert?: (row: ConversationRowRaw) => void;
  onConversationUpdate?: (row: ConversationRowRaw, old?: ConversationRowRaw) => void;
  onSupportNoteInsert?: (row: SupportNoteRow) => void;
  onEscalationInsert?: (row: EscalationRow) => void;
  onNotificationInsert?: (row: NotificationRow) => void;
};

export type MessageRow = {
  id: number;
  conversation_id: number;
  direction: 'inbound' | 'outbound';
  body: string;
  ai_model: string | null;
  created_at: string;
};

export type ConversationRowRaw = {
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
  total_messages: number;
};

export type SupportNoteRow = {
  id: number;
  conversation_id: number;
  kind: 'note' | 'system' | 'action' | 'escalation';
  body: string;
  created_at: string;
};

export type EscalationRow = {
  id: number;
  conversation_id: number | null;
  reason: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  summary: string | null;
  created_at: string;
};

export type NotificationRow = {
  id: number;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string | null;
  conversation_id: number | null;
  target_agent: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

// ─── Support table subscriptions ─────────────────────────────────────────────

let _supportChannel: RealtimeChannel | null = null;

export function subscribeToSupport(handlers: SupportEventHandlers): () => void {
  const supabase = getSupabaseBrowserClient();

  // Reuse channel if already subscribed; just add listeners.
  // Supabase channels can have multiple postgres_changes listeners.
  if (_supportChannel) {
    attachHandlers(_supportChannel, handlers);
    // Return a no-op for now; full teardown happens when the singleton is reset
    return () => {};
  }

  _supportChannel = supabase.channel('support-realtime');

  attachHandlers(_supportChannel, handlers);

  _supportChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      // eslint-disable-next-line no-console
      console.log('[realtime] support-realtime subscribed');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      // eslint-disable-next-line no-console
      console.warn('[realtime] support-realtime status:', status);
    }
  });

  return () => {
    if (_supportChannel) {
      supabase.removeChannel(_supportChannel);
      _supportChannel = null;
    }
  };
}

function attachHandlers(channel: RealtimeChannel, h: SupportEventHandlers) {
  // Wrapping in a generic 'postgres_changes' subscribe. We use any-cast because
  // the Supabase types for postgres_changes config are awkward to express.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const on = (table: string, event: 'INSERT' | 'UPDATE' | '*', cb: (payload: any) => void) => {
    (channel as any).on(
      'postgres_changes',
      { event, schema: 'public', table },
      cb,
    );
  };

  if (h.onMessageInsert) on('messages', 'INSERT', (p) => h.onMessageInsert!(p.new as MessageRow));
  if (h.onMessageUpdate) on('messages', 'UPDATE', (p) => h.onMessageUpdate!(p.new as MessageRow));
  if (h.onConversationInsert)
    on('conversations', 'INSERT', (p) => h.onConversationInsert!(p.new as ConversationRowRaw));
  if (h.onConversationUpdate)
    on('conversations', 'UPDATE', (p) =>
      h.onConversationUpdate!(p.new as ConversationRowRaw, p.old as ConversationRowRaw),
    );
  if (h.onSupportNoteInsert)
    on('support_notes', 'INSERT', (p) => h.onSupportNoteInsert!(p.new as SupportNoteRow));
  if (h.onEscalationInsert)
    on('escalations', 'INSERT', (p) => h.onEscalationInsert!(p.new as EscalationRow));
  if (h.onNotificationInsert)
    on('notification_events', 'INSERT', (p) =>
      h.onNotificationInsert!(p.new as NotificationRow),
    );
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ─── Presence ────────────────────────────────────────────────────────────────

export type PresencePayload = {
  agent_id: number | null;
  email: string;
  name: string;
  viewing_conversation_id: number | null;
};

export type PresenceMap = Record<string, PresencePayload[]>;

let _presenceChannel: RealtimeChannel | null = null;

export function joinPresence(
  me: PresencePayload,
  onSync: (state: PresenceMap) => void,
): () => void {
  const supabase = getSupabaseBrowserClient();
  if (_presenceChannel) {
    supabase.removeChannel(_presenceChannel);
    _presenceChannel = null;
  }
  _presenceChannel = supabase.channel('support-presence', {
    config: { presence: { key: me.email } },
  });

  _presenceChannel.on('presence', { event: 'sync' }, () => {
    onSync(_presenceChannel!.presenceState() as PresenceMap);
  });

  _presenceChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await _presenceChannel!.track(me);
    }
  });

  return () => {
    if (_presenceChannel) {
      supabase.removeChannel(_presenceChannel);
      _presenceChannel = null;
    }
  };
}

export async function updatePresenceViewing(
  me: PresencePayload,
  viewing_conversation_id: number | null,
) {
  if (!_presenceChannel) return;
  await _presenceChannel.track({ ...me, viewing_conversation_id });
}

// ─── Typing indicators (per-conversation broadcast) ──────────────────────────

const _typingChannels = new Map<number, RealtimeChannel>();

export type TypingEvent = {
  who: 'human' | 'ai' | 'customer';
  agent_name?: string;
  is_typing: boolean;
};

export function joinTypingChannel(
  conversationId: number,
  onTyping: (e: TypingEvent) => void,
): () => void {
  const supabase = getSupabaseBrowserClient();
  let channel = _typingChannels.get(conversationId);

  if (!channel) {
    channel = supabase.channel(`conv-${conversationId}-typing`);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (channel as any).on('broadcast', { event: 'typing' }, (payload: any) => {
      onTyping(payload.payload as TypingEvent);
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
    channel.subscribe();
    _typingChannels.set(conversationId, channel);
  }

  return () => {
    const ch = _typingChannels.get(conversationId);
    if (ch) {
      supabase.removeChannel(ch);
      _typingChannels.delete(conversationId);
    }
  };
}

export async function sendTyping(conversationId: number, ev: TypingEvent) {
  const ch = _typingChannels.get(conversationId);
  if (!ch) return;
  await ch.send({ type: 'broadcast', event: 'typing', payload: ev });
}
