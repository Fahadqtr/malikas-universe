'use client';

/**
 * BulkAIUploader — drag-drop multi-file uploader + AI processing pipeline.
 *
 * STAGES
 *   queued          file picked, waiting to upload
 *   uploading       upload in progress (progress bar)
 *   analyzing       Claude vision running
 *   draft_created   ✅ product created, confidence >= 0.90  (green badge)
 *   needs_review    ⚠ product created, confidence < 0.90  (yellow badge)
 *                   OR product insert failed and AI output went to ai_drafts
 *   failed          AI errored after all retry attempts  (red badge)
 *   error           upload failed (separate from AI failure)
 *
 * Concurrency: 4 parallel uploads, 3 parallel AI jobs.
 * AI auto-triggers via useEffect — uploads & AI interleave for max throughput.
 *
 * Retry with exponential backoff
 *   On AI failure, the entry is queued for retry with delay 1s → 2s → 4s.
 *   After 3 attempts → stage='failed', user can click "Retry AI" manually.
 *
 * A single failed product never blocks the queue.
 *
 * In-memory queue only (no Redis). Future BullMQ wrapper can replace the
 * effect by pulling 'uploaded' entries from Redis and POSTing to the same
 * /api/bulk-ai/process endpoint.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card } from '@/components/ui';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UPLOAD_CONCURRENCY = 4;
const AI_CONCURRENCY = 3;

// Retry with exponential backoff — 1s, 2s, 4s
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

type Stage =
  | 'queued'
  | 'uploading'
  | 'uploaded'        // internal — entries here immediately get picked by AI effect
  | 'analyzing'
  | 'draft_created'
  | 'needs_review'
  | 'failed'
  | 'error';

type UploadResult = {
  id: string;
  path: string;
  url: string;
  original_filename: string;
  size_bytes: number;
  content_type: string;
  uploaded_at: string;
};

type AIResult =
  | {
      status: 'ready' | 'needs_review';
      master_sku: string;
      product_id: number;
      confidence: number;
      fields_filled: number;
      meta: AIMeta;
    }
  | {
      // Product insert failed but AI output was saved to the ai_drafts safety table
      status: 'draft_saved_to_safety_net';
      ai_draft_id: number;
      confidence: number;
      fields_filled: number;
      meta: AIMeta;
      error: { code: string; message: string; failing_table: string; failing_column: string | null };
    }
  | {
      // Product insert AND ai_drafts both failed — AI work is in this response
      status: 'ai_output_preserved_in_response';
      ai_draft_id: null;
      confidence: number;
      fields_filled: number;
      meta: AIMeta;
      suggestion: Record<string, unknown>;
      error: {
        code: string;
        message: string;
        failing_table: string;
        failing_column: string | null;
        operator_hint: string;
      };
    };

type AIMeta = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  fallback_used: boolean;
};

type FileEntry = {
  key: string;
  file: File;
  previewUrl: string;
  stage: Stage;
  progress: number;        // upload progress only, 0..1
  error?: string;
  uploadResult?: UploadResult;
  aiResult?: AIResult;
  aiAttempts: number;      // 0..MAX_ATTEMPTS — how many times AI has been attempted
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function validateFile(file: File): string | null {
  if (!ALLOWED_TYPES.has(file.type)) return `Unsupported type: ${file.type || 'unknown'}`;
  if (file.size > MAX_BYTES) return `Too large: ${(file.size / 1024 / 1024).toFixed(1)} MB > 5 MB`;
  return null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

/**
 * Upload one file with progress reporting via XMLHttpRequest.
 */
function uploadOne(file: File, onProgress: (p: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/bulk-ai/upload');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && body.ok) {
          resolve(body.data as UploadResult);
        } else {
          reject(new Error(body?.error?.message ?? `HTTP ${xhr.status}`));
        }
      } catch {
        reject(new Error('Invalid server response'));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('Upload aborted'));

    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

/**
 * Call the AI processor. Throws on hard server errors so the retry layer
 * decides whether to back off and try again.
 *
 * Returns AIResult including the safety-net shape when the server falls back.
 */
async function processOne(input: {
  image_url: string;
  original_filename: string;
}): Promise<AIResult> {
  const res = await fetch('/api/bulk-ai/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  let body: { ok: boolean; data?: AIResult; error?: { code: string; message: string; details?: unknown } };
  try {
    body = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status} — invalid JSON response`);
  }
  if (!res.ok || !body.ok) {
    const code = body?.error?.code ?? `HTTP_${res.status}`;
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    const e = new Error(`[${code}] ${msg}`);
    // Mark schema errors as non-retriable so we don't waste backoff cycles
    (e as Error & { code?: string }).code = code;
    throw e;
  }
  return body.data as AIResult;
}

/** Limited-concurrency queue runner. */
async function runQueue<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  const queue = items.slice();
  async function next() {
    while (queue.length > 0) {
      const job = queue.shift()!;
      await worker(job);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
}

/** Sleep helper for backoff. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is this error class worth retrying? Schema/auth errors aren't. */
function isRetriable(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const code = (err as Error & { code?: string }).code;
  if (!code) return true;
  // Don't loop on these — operator must fix them
  const fatal = new Set([
    'SCHEMA_OUT_OF_DATE',
    'NO_FALLBACK_BRAND',
    'FORBIDDEN',
    'VALIDATION_ERROR',
  ]);
  return !fatal.has(code);
}

// ─── Component ──────────────────────────────────────────────────────────────

export function BulkAIUploader() {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  // Tracks which entries are currently in an in-flight AI call so the
  // useEffect below doesn't double-fire them.
  const aiInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      for (const e of entries) URL.revokeObjectURL(e.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Stats ────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const s = {
      total: entries.length,
      queued: 0,
      uploading: 0,
      analyzing: 0,
      draft_created: 0,
      needs_review: 0,
      failed: 0,
      error: 0,
      cost_usd: 0,
    };
    for (const e of entries) {
      if (e.stage === 'queued') s.queued++;
      else if (e.stage === 'uploading') s.uploading++;
      else if (e.stage === 'analyzing') s.analyzing++;
      else if (e.stage === 'draft_created') s.draft_created++;
      else if (e.stage === 'needs_review') s.needs_review++;
      else if (e.stage === 'failed') s.failed++;
      else if (e.stage === 'error') s.error++;
      // 'uploaded' is a transient state, count it under analyzing for the UI
      else if (e.stage === 'uploaded') s.analyzing++;
      if (e.aiResult) s.cost_usd += e.aiResult.meta.cost_usd;
    }
    return s;
  }, [entries]);

  // ─── Mutator ──────────────────────────────────────────────────────────────
  const updateEntry = useCallback((key: string, patch: Partial<FileEntry>) => {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }, []);

  // ─── Add files ────────────────────────────────────────────────────────────
  const addFiles = useCallback((files: File[]) => {
    const newEntries: FileEntry[] = [];
    for (const file of files) {
      const validationError = validateFile(file);
      const previewUrl = URL.createObjectURL(file);
      newEntries.push({
        key: `${file.name}_${file.size}_${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl,
        stage: validationError ? 'error' : 'queued',
        progress: 0,
        error: validationError ?? undefined,
        aiAttempts: 0,
      });
    }
    setEntries((prev) => [...prev, ...newEntries]);
  }, []);

  // ─── Drag-drop ────────────────────────────────────────────────────────────
  function onDragEnter(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation();
    dragDepthRef.current++;
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation();
    dragDepthRef.current--;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragging(false);
    }
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) addFiles(files);
  }
  function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) addFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeEntry(key: string) {
    setEntries((prev) => {
      const e = prev.find((x) => x.key === key);
      if (e) URL.revokeObjectURL(e.previewUrl);
      return prev.filter((x) => x.key !== key);
    });
  }

  function clearAll() {
    for (const e of entries) URL.revokeObjectURL(e.previewUrl);
    setEntries([]);
    setBannerError(null);
  }

  function clearCompleted() {
    setEntries((prev) => {
      const keep: FileEntry[] = [];
      for (const e of prev) {
        if (e.stage === 'draft_created' || e.stage === 'needs_review') {
          URL.revokeObjectURL(e.previewUrl);
        } else {
          keep.push(e);
        }
      }
      return keep;
    });
  }

  // ─── AI processing with retry + exponential backoff ───────────────────────
  const runAI = useCallback(async (entry: FileEntry) => {
    let lastErr: Error | null = null;

    for (let attempt = entry.aiAttempts; attempt < MAX_ATTEMPTS; attempt++) {
      updateEntry(entry.key, { stage: 'analyzing', aiAttempts: attempt + 1, error: undefined });

      try {
        const ai = await processOne({
          image_url: entry.uploadResult!.url,
          original_filename: entry.uploadResult!.original_filename,
        });

        // Translate server response into UI stage
        if (ai.status === 'ready') {
          updateEntry(entry.key, { stage: 'draft_created', aiResult: ai });
        } else if (ai.status === 'needs_review') {
          updateEntry(entry.key, { stage: 'needs_review', aiResult: ai });
        } else if (ai.status === 'draft_saved_to_safety_net') {
          updateEntry(entry.key, {
            stage: 'needs_review',
            aiResult: ai,
            error: `Recovered to safety net: ${ai.error.message}`,
          });
        } else if (ai.status === 'ai_output_preserved_in_response') {
          // Both DB writes failed; AI work is preserved in the response.
          // Mark as needs_review so the user sees the AI cost/confidence and
          // the operator hint about running migration 0005.
          updateEntry(entry.key, {
            stage: 'needs_review',
            aiResult: ai,
            error: `${ai.error.message} — ${ai.error.operator_hint}`,
          });
        }
        return; // ✓ success — exit retry loop
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error('AI processing failed');

        // Fatal errors stop retries and bubble a banner so user can fix them
        if (!isRetriable(lastErr)) {
          if (lastErr.message.includes('SCHEMA_OUT_OF_DATE')) {
            setBannerError(
              'Database is missing AI columns. Run migration 0005 in Supabase SQL Editor, then click "Retry AI failures".',
            );
          }
          break;
        }

        // Backoff before next attempt — 1s, 2s, 4s
        if (attempt + 1 < MAX_ATTEMPTS) {
          await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
        }
      }
    }

    updateEntry(entry.key, {
      stage: 'failed',
      error: lastErr?.message ?? 'AI processing failed after retries',
    });
  }, [updateEntry]);

  // ─── AI auto-trigger ──────────────────────────────────────────────────────
  // Every time entries change, fill open AI slots with any 'uploaded' entries.
  useEffect(() => {
    const inFlight = aiInFlightRef.current;
    const openSlots = AI_CONCURRENCY - inFlight.size;
    if (openSlots <= 0) return;

    const waiting = entries.filter(
      (e) => e.stage === 'uploaded' && !inFlight.has(e.key) && e.uploadResult,
    );
    if (waiting.length === 0) return;

    const batch = waiting.slice(0, openSlots);
    for (const entry of batch) {
      inFlight.add(entry.key);
      // Reserve immediately so the next effect run doesn't grab it
      updateEntry(entry.key, { stage: 'analyzing' });

      (async () => {
        try {
          await runAI(entry);
        } finally {
          inFlight.delete(entry.key);
          // Trigger another effect pass to pick up newly-uploaded files
          setEntries((prev) => [...prev]);
        }
      })();
    }
  }, [entries, runAI, updateEntry]);

  // ─── Upload all queued ────────────────────────────────────────────────────
  async function uploadAll() {
    if (uploading) return;
    setBannerError(null);
    setUploading(true);

    const toUpload = entries.filter((e) => e.stage === 'queued');
    await runQueue(
      toUpload,
      async (entry) => {
        updateEntry(entry.key, { stage: 'uploading', progress: 0 });
        try {
          const result = await uploadOne(entry.file, (p) =>
            updateEntry(entry.key, { progress: p }),
          );
          // Flipping to 'uploaded' triggers the AI auto-effect
          updateEntry(entry.key, { stage: 'uploaded', progress: 1, uploadResult: result });
        } catch (err) {
          updateEntry(entry.key, {
            stage: 'error',
            error: err instanceof Error ? err.message : 'Upload failed',
          });
        }
      },
      UPLOAD_CONCURRENCY,
    );

    setUploading(false);
  }

  async function retryUploadErrors() {
    setEntries((prev) =>
      prev.map((e) =>
        e.stage === 'error' && !validateFile(e.file)
          ? { ...e, stage: 'queued', error: undefined, progress: 0 }
          : e,
      ),
    );
    setTimeout(() => uploadAll(), 50);
  }

  function retryFailedAI() {
    setBannerError(null);
    setEntries((prev) =>
      prev.map((e) =>
        e.stage === 'failed' && e.uploadResult
          ? { ...e, stage: 'uploaded', error: undefined, aiAttempts: 0 }
          : e,
      ),
    );
  }

  function retryOneAI(key: string) {
    setBannerError(null);
    setEntries((prev) =>
      prev.map((e) =>
        e.key === key && e.stage === 'failed' && e.uploadResult
          ? { ...e, stage: 'uploaded', error: undefined, aiAttempts: 0 }
          : e,
      ),
    );
  }

  // ─── Derived flags ────────────────────────────────────────────────────────
  const canUpload = !uploading && entries.some((e) => e.stage === 'queued');
  const hasUploadErrors = entries.some((e) => e.stage === 'error');
  const hasFailedAI = entries.some((e) => e.stage === 'failed');
  const hasCompleted = entries.some((e) => e.stage === 'draft_created' || e.stage === 'needs_review');
  const busy =
    uploading ||
    entries.some((e) => e.stage === 'uploading' || e.stage === 'analyzing' || e.stage === 'uploaded');

  return (
    <div className="space-y-6">
      {/* Banner error — for fatal/global issues like missing migration */}
      {bannerError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive p-4 text-sm">
          <div className="font-semibold mb-1">⚠ Setup required</div>
          <div>{bannerError}</div>
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`relative rounded-xl border-2 border-dashed transition-all p-12 text-center cursor-pointer
          ${isDragging
            ? 'border-primary bg-primary/5 scale-[1.01]'
            : 'border-border bg-card hover:border-primary/50 hover:bg-muted/30'}
        `}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          onChange={onFilePick}
          className="hidden"
        />

        <div className="flex flex-col items-center gap-3 pointer-events-none">
          <div
            className={`w-16 h-16 rounded-full flex items-center justify-center text-3xl ${
              isDragging ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
            }`}
          >
            📥
          </div>
          <div className="space-y-1">
            <div className="text-lg font-medium">
              {isDragging ? 'Drop them here' : 'Drag images here, or click to browse'}
            </div>
            <div className="text-sm text-muted-foreground">
              JPG · PNG · WebP · max 5 MB · 100+ at a time · AI auto-creates bilingual drafts
            </div>
          </div>
        </div>
      </div>

      {/* Stats + actions */}
      {entries.length > 0 && (
        <Card className="!p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <Stat label="Total" value={stats.total} />
              {stats.queued > 0 && <Stat label="Queued" value={stats.queued} color="text-muted-foreground" />}
              {stats.uploading > 0 && <Stat label="Uploading" value={stats.uploading} color="text-blue-600" />}
              {stats.analyzing > 0 && <Stat label="Analyzing" value={stats.analyzing} color="text-purple-600" />}
              {stats.draft_created > 0 && <Stat label="Draft created" value={stats.draft_created} color="text-green-700" />}
              {stats.needs_review > 0 && <Stat label="Needs review" value={stats.needs_review} color="text-yellow-600" />}
              {stats.failed > 0 && <Stat label="AI failed" value={stats.failed} color="text-destructive" />}
              {stats.error > 0 && <Stat label="Upload errors" value={stats.error} color="text-destructive" />}
              {stats.cost_usd > 0 && <Stat label="AI cost" value={fmtUsd(stats.cost_usd)} color="text-muted-foreground" />}
            </div>
            <div className="flex flex-wrap gap-2">
              {hasUploadErrors && !uploading && (
                <Button variant="secondary" size="sm" onClick={retryUploadErrors}>
                  Retry upload errors
                </Button>
              )}
              {hasFailedAI && (
                <Button variant="secondary" size="sm" onClick={retryFailedAI}>
                  Retry AI failures
                </Button>
              )}
              {hasCompleted && (
                <Button variant="ghost" size="sm" onClick={clearCompleted}>
                  Clear completed
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={clearAll} disabled={busy}>
                Clear all
              </Button>
              <Button onClick={uploadAll} disabled={!canUpload}>
                {uploading
                  ? 'Uploading…'
                  : `Upload & AI ${stats.queued} file${stats.queued === 1 ? '' : 's'}`}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Preview grid */}
      {entries.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {entries.map((entry) => (
            <EntryTile
              key={entry.key}
              entry={entry}
              onRemove={() => removeEntry(entry.key)}
              onRetryAI={() => retryOneAI(entry.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="leading-tight">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`text-xl font-semibold ${color ?? ''}`}>{value}</div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  // green >90, yellow >75, red <75
  const color =
    pct > 90
      ? 'bg-green-600 text-white'
      : pct > 75
        ? 'bg-yellow-500 text-white'
        : 'bg-red-600 text-white';
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${color}`} title="AI confidence">
      {pct}%
    </span>
  );
}

function EntryTile({
  entry,
  onRemove,
  onRetryAI,
}: {
  entry: FileEntry;
  onRemove: () => void;
  onRetryAI: () => void;
}) {
  const stageColor: Record<Stage, string> = {
    queued: 'bg-muted text-muted-foreground',
    uploading: 'bg-blue-500 text-white',
    uploaded: 'bg-slate-500 text-white',
    analyzing: 'bg-purple-500 text-white animate-pulse',
    draft_created: 'bg-green-600 text-white',
    needs_review: 'bg-yellow-500 text-white',
    failed: 'bg-destructive text-destructive-foreground',
    error: 'bg-destructive text-destructive-foreground',
  };

  const stageLabel: Record<Stage, string> = {
    queued: 'queued',
    uploading: 'uploading',
    uploaded: 'uploaded',
    analyzing: 'analyzing…',
    draft_created: 'draft created',
    needs_review: 'needs review',
    failed: 'AI failed',
    error: 'upload error',
  };

  const isActive = entry.stage === 'uploading' || entry.stage === 'analyzing';

  // master_sku may be present for happy path; safety-net path uses ai_draft_id
  const masterSku =
    entry.aiResult && 'master_sku' in entry.aiResult ? entry.aiResult.master_sku : undefined;
  const safetyDraftId =
    entry.aiResult && 'ai_draft_id' in entry.aiResult && entry.aiResult.ai_draft_id != null
      ? entry.aiResult.ai_draft_id
      : undefined;
  const isPreservedOnly =
    entry.aiResult?.status === 'ai_output_preserved_in_response';

  return (
    <div className="relative group border border-border rounded-lg overflow-hidden bg-card">
      {/* Image */}
      <div className="aspect-square bg-muted relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={entry.previewUrl} alt={entry.file.name} className="w-full h-full object-cover" />

        {/* Stage + confidence */}
        <div className="absolute top-1.5 left-1.5 flex gap-1 items-center">
          <span className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${stageColor[entry.stage]}`}>
            {stageLabel[entry.stage]}
          </span>
          {entry.aiResult && <ConfidenceBadge confidence={entry.aiResult.confidence} />}
          {entry.aiAttempts > 1 && entry.stage !== 'failed' && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground" title="Retry attempts">
              ↻{entry.aiAttempts}
            </span>
          )}
        </div>

        {!isActive && (
          <button
            type="button"
            onClick={onRemove}
            className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 text-white text-sm hover:bg-black/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Remove"
          >
            ×
          </button>
        )}

        {entry.stage === 'uploading' && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="text-white text-sm font-medium">{Math.round(entry.progress * 100)}%</div>
          </div>
        )}

        {entry.stage === 'analyzing' && (
          <div className="absolute inset-0 bg-purple-900/40 flex items-center justify-center">
            <div className="text-white text-xs font-medium px-3 py-1 rounded bg-purple-900/70">
              ✨ AI analyzing…
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-2 py-1.5 text-xs space-y-1">
        <div className="truncate font-medium" title={entry.file.name}>
          {entry.file.name}
        </div>
        <div className="text-muted-foreground flex justify-between gap-1">
          <span>{fmtBytes(entry.file.size)}</span>
          {entry.aiResult && (
            <span title="AI cost for this image">{fmtUsd(entry.aiResult.meta.cost_usd)}</span>
          )}
        </div>

        {entry.stage === 'uploading' && (
          <div className="h-1 bg-muted rounded overflow-hidden">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${entry.progress * 100}%` }} />
          </div>
        )}

        {(entry.stage === 'error' || entry.stage === 'failed') && entry.error && (
          <div className="text-destructive text-[11px] leading-tight break-words" title={entry.error}>
            {entry.error.length > 90 ? entry.error.slice(0, 90) + '…' : entry.error}
          </div>
        )}

        {/* Safety-net recovery note (needs_review with no master_sku) */}
        {entry.stage === 'needs_review' && safetyDraftId && (
          <div className="text-yellow-700 text-[11px] leading-tight">
            ⚠ Saved to safety net (draft #{safetyDraftId}). Recover from review screen.
          </div>
        )}

        {/* Preserved-only fallback (no draft, no product — AI work in response) */}
        {isPreservedOnly && (
          <div className="text-yellow-700 text-[11px] leading-tight">
            ⚠ AI output preserved but not saved. Run migration 0005 + retry.
          </div>
        )}

        {/* Generated SKU */}
        {masterSku && (
          <div className="text-[11px] text-muted-foreground truncate font-mono" title={masterSku}>
            {masterSku}
          </div>
        )}

        {/* Action links */}
        <div className="flex justify-between gap-2 pt-1">
          {entry.uploadResult && (
            <a
              href={entry.uploadResult.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground text-[11px]"
              title="View uploaded image"
            >
              Image →
            </a>
          )}

          {masterSku && (
            <a
              href={`/products/${masterSku}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline text-[11px] font-medium"
              title="Open draft to review and complete"
            >
              Review →
            </a>
          )}

          {entry.stage === 'failed' && (
            <button
              type="button"
              onClick={onRetryAI}
              className="text-primary hover:underline text-[11px] font-medium"
            >
              Retry AI
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
