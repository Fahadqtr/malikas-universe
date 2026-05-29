'use client';

/**
 * IncomingCallModal — full-screen "incoming call" popup that shows
 * when a new customer message arrives in a conversation that isn't open.
 *
 * Behavior:
 *   • Subscribes to subscribeRingState() — appears when an id is active
 *   • Big pulsing avatar circle + customer name/phone
 *   • Message preview (RTL if Arabic)
 *   • Accept → navigate to /support?id=... + stopRinging
 *   • Dismiss → just stopRinging (popup closes)
 *   • Auto-closes after 30s timeout (in sync with stopRinging timeout)
 *
 * Uses window.location for nav so it works even without router context.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { stopRinging, subscribeRingState } from '@/lib/notifications';

export type IncomingCallPayload = {
  conversation_id: number;
  customer_name: string | null;
  customer_phone: string;
  message_body: string;
  language: string | null;
  is_escalation?: boolean;
};

// Module-level pending payloads keyed by id — set by the realtime hook,
// consumed by this modal. Avoids prop-drilling.
const _pendingById = new Map<string, IncomingCallPayload>();
const _payloadListeners = new Set<(p: IncomingCallPayload | null) => void>();

export function presentIncomingCall(payload: IncomingCallPayload) {
  const id = `conv-${payload.conversation_id}`;
  _pendingById.set(id, payload);
  for (const l of _payloadListeners) l(payload);
}

export function clearIncomingCall(conversationId?: number) {
  if (conversationId == null) {
    _pendingById.clear();
  } else {
    _pendingById.delete(`conv-${conversationId}`);
  }
}

export function IncomingCallModal() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [payload, setPayload] = useState<IncomingCallPayload | null>(null);

  // Listen to ring state changes
  useEffect(() => {
    return subscribeRingState((id) => {
      setActiveId(id);
      if (id === null) {
        setPayload(null);
      } else {
        setPayload(_pendingById.get(id) ?? null);
      }
    });
  }, []);

  // Listen to fresh payloads arriving while ringing (rare — multiple messages)
  useEffect(() => {
    const listener = (p: IncomingCallPayload | null) => {
      if (p) setPayload(p);
    };
    _payloadListeners.add(listener);
    return () => {
      _payloadListeners.delete(listener);
    };
  }, []);

  if (!activeId || !payload) return null;

  function accept() {
    stopRinging('accepted');
    clearIncomingCall(payload!.conversation_id);
    // Navigate without reloading the SPA
    const url = `/support?id=${payload!.conversation_id}`;
    window.history.pushState({}, '', url);
    // Force the SupportDashboard to react to the new query
    // by dispatching a popstate event
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  function dismiss() {
    stopRinging('dismissed');
    clearIncomingCall(payload!.conversation_id);
  }

  const isAr = /[؀-ۿ]/.test(payload.message_body);
  const initial =
    (payload.customer_name ?? payload.customer_phone).trim().charAt(0).toUpperCase() ||
    '?';

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        // Click on backdrop = dismiss
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="bg-card rounded-2xl shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95">
        {/* Top: pulsing avatar + label */}
        <div
          className={`p-8 text-center text-white ${
            payload.is_escalation
              ? 'bg-gradient-to-br from-red-600 to-orange-600'
              : 'bg-gradient-to-br from-green-600 to-emerald-600'
          }`}
        >
          <div className="text-xs uppercase tracking-wider opacity-80 mb-2">
            {payload.is_escalation ? '⚠ Escalated message' : 'Incoming customer message'}
          </div>

          {/* Animated avatar */}
          <div className="relative inline-flex items-center justify-center mb-4">
            <span className="absolute inline-flex w-28 h-28 rounded-full bg-white/30 animate-ping" />
            <span className="absolute inline-flex w-24 h-24 rounded-full bg-white/20 animate-pulse" />
            <span className="relative inline-flex w-20 h-20 rounded-full bg-white text-foreground items-center justify-center text-3xl font-bold shadow-lg">
              {initial}
            </span>
          </div>

          <div className="text-xl font-semibold mb-1">
            {payload.customer_name ?? payload.customer_phone}
          </div>
          {payload.customer_name && (
            <div className="text-xs font-mono opacity-80">{payload.customer_phone}</div>
          )}
          {payload.language && (
            <div className="text-[10px] uppercase tracking-wider opacity-70 mt-1">
              {payload.language === 'ar' ? 'العربية' : payload.language === 'mixed' ? 'AR + EN' : 'English'}
            </div>
          )}
        </div>

        {/* Message preview */}
        <div className="p-5 bg-card">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Message
          </div>
          <div
            dir={isAr ? 'rtl' : 'ltr'}
            className="text-sm leading-relaxed bg-muted/50 rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap"
          >
            {payload.message_body}
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 bg-muted/30 border-t border-border flex gap-2">
          <Button
            variant="secondary"
            onClick={dismiss}
            className="flex-1 !py-3"
            title="Stop the sound but keep the conversation in the list"
          >
            ✗ Dismiss
          </Button>
          <Button onClick={accept} className="flex-1 !py-3" title="Open this conversation now">
            ✓ Accept & open
          </Button>
        </div>

        <div className="px-4 pb-3 text-[10px] text-muted-foreground text-center">
          Auto-stops after 30s · Esc to dismiss
        </div>
      </div>

      {/* Esc key dismiss */}
      <EscDismissHook onEsc={dismiss} />
    </div>
  );
}

function EscDismissHook({ onEsc }: { onEsc: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onEsc();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEsc]);
  return null;
}
