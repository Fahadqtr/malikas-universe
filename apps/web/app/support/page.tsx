/**
 * /support — Customer Support Center.
 *
 * 3-panel desktop layout:
 *   • Left:   conversation list + filters
 *   • Center: chat thread + composer (with AI/human toggle)
 *   • Right:  customer info + quick actions + notes + assignment
 *
 * URL: /support?id=<conversation_id> selects which conversation to show.
 *
 * Hard rules surfaced in UI:
 *   ✗ No auto-send refund/coupon — every reply has an explicit Send button
 *   ✗ Escalation warnings shown in chat thread
 *   ✓ Conversation history preserved (never deleted from UI)
 *   ✓ Every human action triggers an audit note (handled server-side)
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { SupportDashboard } from './support-dashboard';

export const dynamic = 'force-dynamic';

export default async function SupportPage({ searchParams }: { searchParams: { id?: string } }) {
  await getActor();
  const initialId = searchParams.id ? Number(searchParams.id) : null;

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto p-3 md:p-4 space-y-3">
        <header className="flex items-baseline justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Link href="/" className="hover:text-foreground">Home</Link>
              <span>›</span>
              <span>Support Center</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight mt-1">Customer Support</h1>
          </div>
          <Link
            href="/whatsapp-test"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ↗ Test Console
          </Link>
        </header>

        <SupportDashboard initialConversationId={Number.isFinite(initialId ?? NaN) ? initialId : null} />
      </div>
    </main>
  );
}
