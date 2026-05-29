'use client';

/**
 * useSupportRealtime — wires Supabase Realtime into the support dashboard.
 *
 * Subscribes ONCE for the lifetime of the dashboard and dispatches:
 *   - new inbound message → refresh list + detail, fire toast + sound + browser notif
 *   - new escalation → critical toast
 *   - new notification_events row → drawer + toast
 *   - any conversation/note update → refresh
 *
 * Refresh is debounced — multiple events in <300ms trigger ONE refetch.
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  subscribeToSupport,
  type MessageRow,
  type ConversationRowRaw,
  type EscalationRow,
  type NotificationRow,
  type SupportNoteRow,
  getSupabaseBrowserClient,
} from '@/lib/realtime';
import { notify, startRinging } from '@/lib/notifications';
import { presentIncomingCall } from './incoming-call-modal';

export type UseSupportRealtimeOpts = {
  /** Called when state may have changed — fetcher should refetch list + detail */
  onRefresh: () => void;
  /** The currently-open conversation id, so we can scope toasts */
  selectedConversationId: number | null;
  /** Map of conversation_id → short label (for toast text) */
  getConversationLabel: (id: number) => string;
};

export function useSupportRealtime(opts: UseSupportRealtimeOpts) {
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const debouncedRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => optsRef.current.onRefresh(), 300);
  }, []);

  useEffect(() => {
    const unsub = subscribeToSupport({
      onMessageInsert: (m: MessageRow) => {
        debouncedRefresh();
        // Only fire popup/toast for customer (inbound) messages NOT already open
        if (m.direction === 'inbound' && m.conversation_id !== optsRef.current.selectedConversationId) {
          // Toast (passive)
          notify({
            title: 'New customer message',
            body: optsRef.current.getConversationLabel(m.conversation_id) + ' — ' +
                  (m.body.slice(0, 80) + (m.body.length > 80 ? '…' : '')),
            severity: 'info',
            href: `/support?id=${m.conversation_id}`,
            sound: null, // sound is handled by startRinging() below
            browserTag: `msg-${m.conversation_id}`,
          });
          // Incoming-call popup + persistent ring
          void (async () => {
            const supabase = getSupabaseBrowserClient();
            const { data } = await supabase
              .from('conversations')
              .select('id, customer_phone, customer_name, language, escalated')
              .eq('id', m.conversation_id)
              .maybeSingle();
            if (!data) return;
            presentIncomingCall({
              conversation_id: data.id as number,
              customer_phone: data.customer_phone as string,
              customer_name: (data.customer_name as string | null) ?? null,
              language: (data.language as string | null) ?? null,
              message_body: m.body,
              is_escalation: !!data.escalated,
            });
            startRinging(`conv-${data.id}`);
          })();
        }
      },
      onMessageUpdate: () => debouncedRefresh(),
      onConversationInsert: (c: ConversationRowRaw) => {
        debouncedRefresh();
        notify({
          title: 'New conversation started',
          body: c.customer_name ?? c.customer_phone,
          severity: 'info',
          href: `/support?id=${c.id}`,
          sound: 'message',
        });
      },
      onConversationUpdate: (c: ConversationRowRaw, old?: ConversationRowRaw) => {
        debouncedRefresh();
        // Surface fresh escalations as warnings
        if (c.escalated && old && !old.escalated) {
          notify({
            title: '⚠ Escalated',
            body: optsRef.current.getConversationLabel(c.id),
            severity: 'warning',
            href: `/support?id=${c.id}`,
            sound: 'escalation',
            browserTag: `esc-${c.id}`,
          });
        }
        // Priority bumped to urgent
        if (c.priority === 'urgent' && old?.priority !== 'urgent') {
          notify({
            title: '🚨 URGENT priority',
            body: optsRef.current.getConversationLabel(c.id),
            severity: 'critical',
            href: `/support?id=${c.id}`,
            sound: 'critical',
            browserTag: `urgent-${c.id}`,
          });
        }
      },
      onSupportNoteInsert: (_n: SupportNoteRow) => {
        debouncedRefresh();
      },
      onEscalationInsert: (e: EscalationRow) => {
        debouncedRefresh();
        const severity: 'warning' | 'critical' =
          e.severity === 'critical' || e.severity === 'high' ? 'critical' : 'warning';
        notify({
          title: `Escalation: ${e.reason.replace(/_/g, ' ')}`,
          body: e.summary?.slice(0, 100) ?? 'Customer flagged for human follow-up',
          severity,
          href: e.conversation_id ? `/support?id=${e.conversation_id}` : '/support',
          sound: null, // ring handles it
          browserTag: `esc-${e.id}`,
        });
        // Ring + popup for high/critical escalations on a conversation that
        // isn't currently open
        if (
          e.conversation_id &&
          e.conversation_id !== optsRef.current.selectedConversationId &&
          (e.severity === 'critical' || e.severity === 'high')
        ) {
          void (async () => {
            const supabase = getSupabaseBrowserClient();
            const { data } = await supabase
              .from('conversations')
              .select('id, customer_phone, customer_name, language')
              .eq('id', e.conversation_id!)
              .maybeSingle();
            if (!data) return;
            presentIncomingCall({
              conversation_id: data.id as number,
              customer_phone: data.customer_phone as string,
              customer_name: (data.customer_name as string | null) ?? null,
              language: (data.language as string | null) ?? null,
              message_body: e.summary ?? `Escalation: ${e.reason}`,
              is_escalation: true,
            });
            startRinging(`conv-${data.id}`);
          })();
        }
      },
      onNotificationInsert: (n: NotificationRow) => {
        debouncedRefresh();
        const sev = n.severity === 'critical' ? 'critical' : n.severity === 'warning' ? 'warning' : 'info';
        notify({
          title: n.title,
          body: n.body ?? undefined,
          severity: sev,
          href: n.conversation_id ? `/support?id=${n.conversation_id}` : '/support',
          sound: sev === 'critical' ? 'critical' : sev === 'warning' ? 'escalation' : 'message',
          browserTag: `notif-${n.id}`,
        });
      },
    });

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unsub();
    };
  }, [debouncedRefresh]);
}
