'use client';

/**
 * useUnread — keeps the total unread badge + browser title accurate.
 *
 * Source of truth: the conversation list rows (each carries unread_count).
 * Whenever the list changes, we recompute and update the document title.
 */

import { useEffect } from 'react';
import { setUnreadInTitle } from '@/lib/notifications';
import type { ConversationRow } from './conversations-list';

export function useUnreadTitle(conversations: ConversationRow[]) {
  useEffect(() => {
    let total = 0;
    for (const c of conversations) {
      if (c.status === 'open' || c.status === 'escalated') total += c.unread_count;
    }
    setUnreadInTitle(total);
    return () => setUnreadInTitle(0);
  }, [conversations]);
}
