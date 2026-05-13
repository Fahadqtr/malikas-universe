export function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function extractSize(s: string): string | null {
  const m = s.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ml|g|kg|pcs|pack|patches|pads|count|ct)/i);
  return m ? `${m[1]}${m[2]}` : null;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0]![j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }
  return matrix[b.length]![a.length]!;
}

export function similarity(a: string, b: string): number {
  const distance = levenshtein(normalize(a), normalize(b));
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

export function slug(s: string, maxLen = 12): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}
