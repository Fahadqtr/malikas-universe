'use client';

/**
 * NotificationControls — top-right strip on /support.
 *
 * Layout (left → right):
 *   • Online agents pill
 *   • SOUND STATUS:
 *       - if 'disabled': "Enable sound" button (prominent — required first)
 *       - if 'enabled':  "Test sound" button + mute toggle
 *       - if 'blocked':  red status + retry button
 *   • Browser notification permission button (only if 'default' or 'unknown')
 *   • Notification drawer button with unread badge
 *
 * Sound and mute are SEPARATE concerns:
 *   • enable  = unlock browser audio (one-time gesture)
 *   • mute    = user wants silence (still "enabled" technically)
 */

import { useEffect, useState } from 'react';
import {
  enableSound,
  getBrowserNotifSetting,
  getSoundState,
  isSoundMuted,
  requestBrowserNotifPermission,
  setSoundMuted,
  startRinging,
  subscribeSoundState,
  testSound,
  tryRestoreSoundState,
  type BrowserNotifSetting,
  type SoundState,
} from '@/lib/notifications';
import { Button, Card } from '@/components/ui';
import type { PresencePayload } from '@/lib/realtime';
import { presentIncomingCall } from './incoming-call-modal';

export function NotificationControls({
  onlineAgents,
  unreadTotal,
}: {
  onlineAgents: PresencePayload[];
  unreadTotal: number;
}) {
  const [soundState, setSoundState] = useState<SoundState>('disabled');
  const [muted, setMuted] = useState(false);
  const [notifSetting, setNotifSetting] = useState<BrowserNotifSetting>('unknown');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    tryRestoreSoundState();
    setMuted(isSoundMuted());
    setNotifSetting(getBrowserNotifSetting());
    setSoundState(getSoundState());
    return subscribeSoundState(setSoundState);
  }, []);

  async function handleEnable() {
    if (working) return;
    setWorking(true);
    try {
      await enableSound();
    } finally {
      setWorking(false);
    }
  }

  async function handleTest() {
    if (working) return;
    setWorking(true);
    try {
      await testSound();
    } finally {
      setWorking(false);
    }
  }

  function toggleMute() {
    const next = !muted;
    setSoundMuted(next);
    setMuted(next);
  }

  async function requestNotif() {
    const result = await requestBrowserNotifPermission();
    setNotifSetting(result);
  }

  return (
    <>
      <div className="flex items-center gap-2 text-xs flex-wrap">
        {/* Online agents */}
        {onlineAgents.length > 0 && (
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-green-100 text-green-800 border border-green-300"
            title={onlineAgents.map((a) => a.name).join(', ')}
          >
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="font-medium">{onlineAgents.length} online</span>
          </div>
        )}

        {/* Sound status — three branches */}
        {soundState === 'disabled' && (
          <button
            type="button"
            onClick={handleEnable}
            disabled={working}
            className="px-3 py-1 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5 shadow-sm"
            title="Browsers block audio until you click. One-time setup."
          >
            🔇 <span>Enable sound</span>
          </button>
        )}

        {soundState === 'enabled' && (
          <>
            <span
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-100 text-green-800 border border-green-300"
              title="Audio unlocked — alerts will play"
            >
              🔊 <span className="font-medium">Sound enabled</span>
            </span>
            <button
              type="button"
              onClick={handleTest}
              disabled={working}
              className="px-2 py-1 rounded-md border border-border hover:bg-muted disabled:opacity-50"
              title="Play a test beep"
            >
              🔔 Test
            </button>
            <button
              type="button"
              onClick={() => {
                // Force-fire the incoming-call modal + ring with fake data
                presentIncomingCall({
                  conversation_id: -1,
                  customer_phone: '+97455500000',
                  customer_name: 'Test Customer',
                  language: 'ar',
                  message_body: 'هذي رسالة اختبار — اضغط Dismiss لإيقاف الرنين',
                  is_escalation: false,
                });
                startRinging('conv--1');
              }}
              className="px-2 py-1 rounded-md border border-purple-300 bg-purple-50 text-purple-900 hover:bg-purple-100"
              title="Force the incoming-call modal + ring to appear (for testing UI)"
            >
              📞 Test ring
            </button>
            <button
              type="button"
              onClick={toggleMute}
              className={`px-2 py-1 rounded-md border ${
                muted
                  ? 'border-yellow-400 bg-yellow-50 text-yellow-900'
                  : 'border-border hover:bg-muted'
              }`}
              title={muted ? 'Unmute (currently silenced)' : 'Mute alert sound'}
            >
              {muted ? '🔕 Muted' : '🔔'}
            </button>
          </>
        )}

        {soundState === 'blocked' && (
          <>
            <span
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-100 text-red-800 border border-red-300"
              title="Browser refused to play audio. Check site permissions in the address bar."
            >
              🚫 <span className="font-medium">Browser blocked sound</span>
            </span>
            <button
              type="button"
              onClick={handleEnable}
              disabled={working}
              className="px-2 py-1 rounded-md border border-red-300 hover:bg-red-50 text-red-900 disabled:opacity-50"
            >
              Retry
            </button>
          </>
        )}

        {/* Browser notification permission */}
        {(notifSetting === 'default' || notifSetting === 'unknown') && (
          <button
            type="button"
            onClick={requestNotif}
            className="px-2 py-1 rounded-md bg-blue-100 text-blue-900 border border-blue-300 hover:bg-blue-200"
          >
            🔔 Enable browser alerts
          </button>
        )}
        {notifSetting === 'denied' && (
          <span
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-yellow-100 text-yellow-900 border border-yellow-300"
            title="Browser notifications are blocked. Enable them from the site settings (lock icon in address bar)."
          >
            🔕 Browser alerts blocked
          </span>
        )}

        {/* Notification drawer */}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="relative px-2 py-1 rounded-md border border-border hover:bg-muted"
          title="Notifications history"
        >
          📜
          {unreadTotal > 0 && (
            <span className="absolute -top-1 -right-1 text-[9px] font-bold bg-destructive text-destructive-foreground rounded-full w-4 h-4 flex items-center justify-center">
              {unreadTotal > 9 ? '9+' : unreadTotal}
            </span>
          )}
        </button>
      </div>

      {drawerOpen && <NotificationDrawer onClose={() => setDrawerOpen(false)} />}
    </>
  );
}

// ─── Drawer ─────────────────────────────────────────────────────────────────

type DrawerNotif = {
  id: number;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  conversation_id: number | null;
  read_at: string | null;
  created_at: string;
};

function NotificationDrawer({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<DrawerNotif[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unread' | string>('all');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/support/notifications?limit=50');
        const body = await res.json();
        if (body.ok) setItems(body.data.items);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered =
    filter === 'all'
      ? items
      : filter === 'unread'
        ? items.filter((n) => !n.read_at)
        : items.filter((n) => n.kind === filter);

  async function markAllRead() {
    await fetch('/api/support/notifications/read-all', { method: 'POST' });
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <Card className="w-[420px] max-w-full !rounded-none !p-0 overflow-y-auto shadow-2xl flex flex-col">
        <div className="p-3 border-b border-border flex items-center justify-between sticky top-0 bg-card">
          <div>
            <div className="font-semibold">Notifications</div>
            <div className="text-xs text-muted-foreground">
              {items.filter((n) => !n.read_at).length} unread · {items.length} total
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>

        <div className="p-2 border-b border-border flex gap-1 flex-wrap text-xs">
          {(['all', 'unread', 'new_message', 'escalation', 'sla_breach'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-2 py-1 rounded ${
                filter === f ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-accent'
              }`}
            >
              {f.replace(/_/g, ' ')}
            </button>
          ))}
          <div className="flex-1" />
          <button
            type="button"
            onClick={markAllRead}
            className="text-xs text-primary hover:underline"
          >
            Mark all read
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-border">
          {loading ? (
            <div className="p-4 text-sm text-muted-foreground text-center">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground text-center">No notifications.</div>
          ) : (
            filtered.map((n) => (
              <a
                key={n.id}
                href={n.conversation_id ? `/support?id=${n.conversation_id}` : '#'}
                className={`block p-3 hover:bg-muted/30 ${!n.read_at ? 'bg-blue-50/50' : ''}`}
              >
                <div className="flex items-start gap-2">
                  <span className="text-lg">
                    {n.severity === 'critical' ? '🚨' : n.severity === 'warning' ? '⚠' : 'ℹ'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{n.title}</div>
                    {n.body && <div className="text-xs text-muted-foreground line-clamp-2">{n.body}</div>}
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {new Date(n.created_at).toLocaleString()} · {n.kind.replace(/_/g, ' ')}
                    </div>
                  </div>
                  {!n.read_at && <span className="w-2 h-2 rounded-full bg-blue-500 mt-1.5" />}
                </div>
              </a>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
