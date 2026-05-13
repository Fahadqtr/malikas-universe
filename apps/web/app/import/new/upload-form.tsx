'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Select, Label } from '@/components/ui';

export function UploadForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [platform, setPlatform] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Pick a file first.');
      return;
    }
    setSubmitting(true);
    const fd = new FormData();
    fd.append('file', file);
    if (platform) fd.append('source_platform', platform);

    try {
      const res = await fetch('/api/import/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? 'Upload failed');
        setSubmitting(false);
        return;
      }
      router.push(`/import/${json.data.batch_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Card className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="file" required>Excel / CSV file</Label>
          <input
            ref={fileRef}
            id="file"
            type="file"
            accept=".xlsx,.xls,.csv,.tsv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm border border-input bg-background rounded-md px-3 py-2"
          />
          {file && (
            <p className="text-xs text-muted-foreground">
              {file.name} · {(file.size / 1024).toFixed(0)} KB
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="platform">Source platform (optional)</Label>
          <Select id="platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">Auto-detect from column headers</option>
            <option value="snoonu">Snoonu</option>
            <option value="shopify">Shopify</option>
            <option value="talabat">Talabat</option>
            <option value="rafeeq">Rafeeq</option>
            <option value="import">Generic / manual</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            Auto-detect inspects header names and picks the matching preset.
          </p>
        </div>

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
            {error}
          </div>
        )}
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting || !file}>
          {submitting ? 'Uploading & parsing…' : 'Upload & preview'}
        </Button>
      </div>
    </form>
  );
}
