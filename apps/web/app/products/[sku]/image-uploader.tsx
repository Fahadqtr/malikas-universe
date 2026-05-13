'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

type ImageRow = {
  id: number;
  cdn_url: string;
  filename: string;
  is_primary: boolean;
  format: string | null;
  file_size_kb: number | null;
  uploaded_at: string;
};

export function ImageUploader({
  masterSku,
  initialImages,
}: {
  masterSku: string;
  initialImages: ImageRow[];
}) {
  const router = useRouter();
  const [images, setImages] = useState(initialImages);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File, isPrimary: boolean) {
    setError(null);
    setUploading(true);

    const fd = new FormData();
    fd.append('file', file);
    fd.append('master_sku', masterSku);
    fd.append('is_primary', String(isPrimary));

    try {
      const res = await fetch('/api/images/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? 'Upload failed');
        setUploading(false);
        return;
      }
      // Add to local state (avoid full refresh)
      setImages((prev) => {
        const next = isPrimary ? prev.map((i) => ({ ...i, is_primary: false })) : prev.slice();
        next.unshift(json.data.image);
        return next;
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      const noPrimary = !images.some((i) => i.is_primary);
      handleFile(file, noPrimary);
    }
  }

  async function setPrimary(imageId: number) {
    // Optimistic UI
    setImages((prev) =>
      prev.map((i) => ({ ...i, is_primary: i.id === imageId })),
    );

    const res = await fetch(`/api/images/${imageId}`, { method: 'PATCH' });
    const json = await res.json();
    if (!json.ok) {
      setError(json.error?.message ?? 'Could not set primary');
      router.refresh();
    } else {
      router.refresh();
    }
  }

  async function deleteImage(imageId: number) {
    if (!confirm('Delete this image?')) return;
    setImages((prev) => prev.filter((i) => i.id !== imageId));
    const res = await fetch(`/api/images/${imageId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.ok) {
      setError(json.error?.message ?? 'Delete failed');
    }
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {/* Upload control */}
      <label className="block">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={onFileChange}
          disabled={uploading}
          className="hidden"
        />
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Uploading…' : '+ Upload image'}
        </Button>
      </label>

      <p className="text-xs text-muted-foreground">
        JPG / PNG / WebP. Max 5 MB. First upload becomes primary automatically.
      </p>

      {error && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded p-2">
          {error}
        </div>
      )}

      {/* Image grid */}
      {images.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No images yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {images.map((img) => (
            <div
              key={img.id}
              className={`relative group border rounded-md overflow-hidden ${
                img.is_primary ? 'border-primary ring-2 ring-primary/30' : 'border-border'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.cdn_url}
                alt={img.filename}
                className="w-full aspect-square object-cover bg-muted"
              />
              {img.is_primary && (
                <span className="absolute top-1 left-1 text-[10px] bg-primary text-primary-foreground rounded px-1.5 py-0.5">
                  PRIMARY
                </span>
              )}
              <div className="p-1.5 text-xs flex flex-col gap-1">
                <div className="truncate" title={img.filename}>{img.filename}</div>
                <div className="flex gap-1">
                  {!img.is_primary && (
                    <button
                      type="button"
                      onClick={() => setPrimary(img.id)}
                      className="text-xs text-primary hover:underline"
                    >
                      Set primary
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => deleteImage(img.id)}
                    className="text-xs text-destructive hover:underline ml-auto"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
