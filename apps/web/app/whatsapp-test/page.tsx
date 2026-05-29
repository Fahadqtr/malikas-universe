/**
 * /whatsapp-test — Admin chat interface to test the WhatsApp agent locally.
 *
 * Does NOT touch Meta API. Sends messages to /api/whatsapp/reply-test which
 * runs the same agent code that the live webhook will use.
 *
 * Useful for:
 *   • Testing agent tone (Arabic Gulf vs English)
 *   • Verifying product searches return correct results
 *   • Triggering escalations to see what happens
 *   • Comparing costs/latency per turn
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { TestChat } from './test-chat';

export const dynamic = 'force-dynamic';

export default async function WhatsappTestPage() {
  await getActor();

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto p-4 md:p-6 space-y-4">
        <header>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground">Home</Link>
            <span>›</span>
            <span>WhatsApp Test</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight mt-1">WhatsApp Agent — Test Console</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Send messages to the AI agent locally. Same code path as the live webhook,
            but no message goes out over WhatsApp. Conversations are saved to the
            <code className="text-xs bg-muted/50 px-1 py-0.5 rounded mx-1">conversations</code>
            table so you can review and reset.
          </p>
        </header>

        <TestChat />
      </div>
    </main>
  );
}
