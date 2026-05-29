'use client';

/**
 * usePresence — joins the support-presence channel and reports who's online
 * + what each agent is viewing.
 *
 * Returns:
 *   onlineAgents       — list of {email, name, viewing_conversation_id}
 *   isAgentViewing(id) — is anyone else looking at this conversation?
 *   updateViewing(id)  — call when selected conversation changes
 */

import { useCallback, useEffect, useState } from 'react';
import { joinPresence, updatePresenceViewing, type PresencePayload } from '@/lib/realtime';

export function usePresence(me: PresencePayload | null, selectedConvId: number | null) {
  const [state, setState] = useState<PresencePayload[]>([]);

  useEffect(() => {
    if (!me) return;
    const unsub = joinPresence(me, (presenceState) => {
      const flat: PresencePayload[] = [];
      for (const list of Object.values(presenceState)) {
        for (const p of list) flat.push(p);
      }
      setState(flat);
    });
    return () => unsub();
  }, [me?.email]); // eslint-disable-line react-hooks/exhaustive-deps

  // When selected conversation changes, broadcast new viewing state
  useEffect(() => {
    if (!me) return;
    void updatePresenceViewing(me, selectedConvId);
  }, [selectedConvId, me]);

  const otherAgentsViewing = useCallback(
    (convId: number): PresencePayload[] => {
      if (!me) return [];
      return state.filter(
        (p) => p.viewing_conversation_id === convId && p.email !== me.email,
      );
    },
    [state, me],
  );

  return {
    onlineAgents: state,
    otherAgentsViewing,
  };
}
