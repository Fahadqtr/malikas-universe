'use client';

/**
 * SlaBadge — surfaces how long a customer has been waiting on a reply.
 *
 * Rules:
 *   • If last message is OUTBOUND (from us), customer isn't waiting → no badge
 *   • If last message is INBOUND:
 *       <5m       → green   "5m"
 *       5-15m     → yellow  "12m"
 *       >15m      → red     "1h"
 *   • If status == 'resolved' → no badge (closed)
 *
 * Updates itself every 30 seconds via state without re-fetching.
 */

import { useEffect, useState } from 'react';

export type SlaProps = {
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  status: string;
};

export function SlaBadge({ lastInboundAt, lastOutboundAt, status }: SlaProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  if (status === 'resolved' || status === 'spam') return null;
  if (!lastInboundAt) return null;

  // Customer waiting iff last inbound > last outbound
  const ibTs = new Date(lastInboundAt).getTime();
  const obTs = lastOutboundAt ? new Date(lastOutboundAt).getTime() : 0;
  if (obTs >= ibTs) return null; // we already replied

  const waitMs = now - ibTs;
  const min = Math.floor(waitMs / 60000);

  let color: string;
  let label: string;

  if (min < 5) {
    color = 'bg-green-100 text-green-800 border-green-300';
    label = `${min}m`;
  } else if (min < 15) {
    color = 'bg-yellow-100 text-yellow-900 border-yellow-300';
    label = `${min}m`;
  } else if (min < 60) {
    color = 'bg-red-100 text-red-800 border-red-300';
    label = `${min}m ⚠`;
  } else {
    const hr = Math.floor(min / 60);
    color = 'bg-red-200 text-red-900 border-red-400';
    label = hr < 24 ? `${hr}h ⚠` : `${Math.floor(hr / 24)}d ⚠`;
  }

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${color}`}
      title={`Customer waiting since ${new Date(lastInboundAt).toLocaleTimeString()}`}
    >
      ⏱ {label}
    </span>
  );
}
