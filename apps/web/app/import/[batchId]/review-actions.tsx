'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card } from '@/components/ui';

export function ImportReviewActions({
  batchId,
  status,
  hasRows,
}: {
  batchId: number;
  status: string;
  hasRows: boolean;
}) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function commitAll() {
    if (!confirm('Commit all auto-import + review-required rows? This will insert products.')) return;
    setError(null);
    setInfo(null);
    setWorking(true);
    try {
      const res = await fetch(`/api/import/${batchId}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!json.ok) setError(json.error?.message ?? 'Commit failed');
      else {
        setInfo(`Inserted ${json.data.inserted} products, ${json.data.failed} failed.`);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown');
    } finally {
      setWorking(false);
    }
  }

  async function rollback() {
    if (!confirm('Roll back this entire import batch? Products will be soft-deleted.')) return;
    setError(null);
    setInfo(null);
    setWorking(true);
    try {
      const res = await fetch(`/api/import/${batchId}/rollback`, { method: 'POST' });
      const json = await res.json();
      if (!json.ok) setError(json.error?.message ?? 'Rollback failed');
      else {
        setInfo(`Rolled back ${json.data.rolled_back_count} products.`);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown');
    } finally {
      setWorking(false);
    }
  }

  const canCommit = hasRows && status !== 'completed' && status !== 'rolled_back';
  const canRollback = status === 'completed';

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Actions</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Review the staged rows below, then commit. You can always rollback.
          </p>
        </div>
        <div className="flex gap-3">
          {canCommit && (
            <Button onClick={commitAll} disabled={working}>
              {working ? 'Working…' : 'Commit all valid rows'}
            </Button>
          )}
          {canRollback && (
            <Button variant="destructive" onClick={rollback} disabled={working}>
              {working ? 'Working…' : 'Rollback batch'}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3 mt-3">
          {error}
        </div>
      )}
      {info && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-3 mt-3">
          {info}
        </div>
      )}
    </Card>
  );
}
