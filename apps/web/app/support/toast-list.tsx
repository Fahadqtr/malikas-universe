'use client';

/**
 * Floating ToastList — bottom-right stack of toasts.
 * Subscribes to the global toastBus from lib/notifications.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toastBus, type Toast } from '@/lib/notifications';

export function ToastList() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    return toastBus.subscribe(setToasts);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 w-[360px] max-w-[calc(100vw-32px)] pointer-events-none">
      {toasts.map((t) => {
        const color =
          t.severity === 'critical'
            ? 'border-red-500 bg-red-50 text-red-900'
            : t.severity === 'warning'
              ? 'border-yellow-500 bg-yellow-50 text-yellow-900'
              : 'border-blue-500 bg-blue-50 text-blue-900';
        const icon = t.severity === 'critical' ? '🚨' : t.severity === 'warning' ? '⚠' : 'ℹ';

        const Body = (
          <div
            className={`pointer-events-auto rounded-md shadow-lg border-l-4 ${color} p-3 cursor-pointer hover:shadow-xl transition-shadow`}
            onClick={() => toastBus.dismiss(t.id)}
          >
            <div className="flex items-start gap-2">
              <span className="text-lg">{icon}</span>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm truncate">{t.title}</div>
                {t.body && (
                  <div className="text-xs opacity-80 mt-0.5 line-clamp-2 break-words">{t.body}</div>
                )}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toastBus.dismiss(t.id);
                }}
                className="text-xs opacity-60 hover:opacity-100"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        );

        return t.href ? (
          <Link key={t.id} href={t.href} onClick={() => toastBus.dismiss(t.id)}>
            {Body}
          </Link>
        ) : (
          <div key={t.id}>{Body}</div>
        );
      })}
    </div>
  );
}
