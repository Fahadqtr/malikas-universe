/**
 * /bulk-ai — Bulk AI image upload + auto-draft creation.
 *
 * Phase 7 step 2: full pipeline.
 *
 * Pipeline per file:
 *   1. Validate (JPG/PNG/WebP, ≤5 MB)
 *   2. Upload (4 concurrent) → product-images/bulk-temp/{uuid}.{ext}
 *   3. AI analyze (3 concurrent) → Claude Haiku vision (Malika Style)
 *   4. Auto-create DRAFT product (ai_generated=true, ai_confidence)
 *   5. Link image to product_images
 *   6. Surface confidence badge + "Review" link → /products/{master_sku}
 *
 * Nothing is published automatically. Every AI draft starts as 'draft' and
 * waits for owner review.
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { BulkAIUploader } from './bulk-uploader';

export const dynamic = 'force-dynamic';

export default async function BulkAIPage() {
  await getActor();

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-6 md:p-8 space-y-6">
        <header>
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Home
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight mt-1">Bulk AI Upload</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Drop product images here — 100+ at a time. Each image is uploaded, then Claude vision auto-creates
            a <strong className="text-foreground">draft product</strong> in bilingual Malika Style. Confidence badge
            tells you which drafts need review. Nothing publishes automatically — every draft waits for you.
          </p>
        </header>

        <BulkAIUploader />
      </div>
    </main>
  );
}
