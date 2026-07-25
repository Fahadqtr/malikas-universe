/**
 * /whatsapp-live — Meta WhatsApp Cloud API status + control panel.
 *
 * Shows:
 *   • Config checklist (env vars set / missing — never the actual token)
 *   • Live mode flag (WHATSAPP_LIVE_ENABLED)
 *   • Meta ping (verifies token against the phone number)
 *   • Webhook URL helper (auto-built from request host — works through tunnels)
 *   • Test send form (sends a real WhatsApp via Meta API)
 *   • Recent webhook logs (last 30 events, inbound + outbound)
 *
 * Auth: owner / editor only. Owner needed to use the test-send form.
 *
 * Companion doc: docs/whatsapp-live-setup.md
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { WhatsappLiveDashboard } from './live-dashboard';

export const dynamic = 'force-dynamic';

export default async function WhatsappLivePage() {
  const actor = await getActor();

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-[1200px] mx-auto p-4 md:p-6 space-y-4">
        <header>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground">Home</Link>
            <span>›</span>
            <span>WhatsApp Live</span>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-2 mt-1">
            <h1 className="text-2xl font-bold tracking-tight">WhatsApp Live Connection</h1>
            <div className="flex items-center gap-2">
              <Link
                href="/whatsapp-test"
                className="text-xs text-primary hover:underline"
              >
                ↗ Local test console
              </Link>
              <Link
                href="/support"
                className="text-xs text-primary hover:underline"
              >
                ↗ Support dashboard
              </Link>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Connect Malika&apos;s WhatsApp Business number through Meta Cloud API.
            See <code className="text-xs bg-muted px-1 py-0.5 rounded">docs/whatsapp-live-setup.md</code> for step-by-step setup.
          </p>
        </header>

        <WhatsappLiveDashboard actorRole={actor.role} />
      </div>
    </main>
  );
}
