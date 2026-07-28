/**
 * Unit tests for the Bulk-AI Recovery UI logic (pure functions) + a small
 * source-contract check on the client components. Runs under Vitest's default
 * node environment — no DOM / testing-library needed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  initialFormState,
  toFormValue,
  validateForm,
  buildOverrides,
  subcategoriesForCategory,
  clearIncompatibleSubcategory,
  applyRecoverySuccess,
  canSubmit,
  markBusy,
  releaseBusy,
  recoveryErrorMessage,
  isServerSideError,
  summarizeFailingPayload,
  productHref,
  NETWORK_ERROR_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  type RecoveryFormState,
  type SubcategoryRow,
} from '../recovery-logic';

const SUBS: SubcategoryRow[] = [
  { id: 91, name: 'Serums', category_id: 5 },
  { id: 92, name: 'Cleansers', category_id: 5 },
  { id: 93, name: 'Lipstick', category_id: 7 },
];

function baseForm(over: Partial<RecoveryFormState> = {}): RecoveryFormState {
  return {
    productNameEn: 'Glow Serum',
    productNameAr: 'سيروم التوهج',
    descriptionEn: '',
    descriptionAr: '',
    usageEn: '',
    usageAr: '',
    brandId: '',
    brandName: '',
    categoryId: '',
    subcategoryId: '',
    ...over,
  };
}

// ─── A. Initial form state ────────────────────────────────────────────────────
describe('A. initial form state', () => {
  it('maps suggestion text into the form, preserving EN + AR', () => {
    const f = initialFormState({
      product_name_en: 'Serum',
      product_name_ar: 'سيروم',
      description_en: 'desc',
      usage_ar: 'استخدام',
    });
    expect(f.productNameEn).toBe('Serum');
    expect(f.productNameAr).toBe('سيروم');
    expect(f.descriptionEn).toBe('desc');
    expect(f.usageAr).toBe('استخدام');
  });

  it('turns null/undefined/missing into empty strings', () => {
    const f = initialFormState({ product_name_en: null, product_name_ar: undefined });
    expect(f.productNameEn).toBe('');
    expect(f.productNameAr).toBe('');
    expect(f.descriptionEn).toBe('');
    expect(f.usageEn).toBe('');
    expect(initialFormState(null).productNameEn).toBe('');
    expect(toFormValue(undefined)).toBe('');
    expect(toFormValue(null)).toBe('');
  });

  it('starts brand/category/subcategory selections empty', () => {
    const f = initialFormState({ brand_hint: 'Anua', category_hint: 'Skincare' });
    expect(f.brandId).toBe('');
    expect(f.brandName).toBe('');
    expect(f.categoryId).toBe('');
    expect(f.subcategoryId).toBe('');
  });
});

// ─── B. Overrides payload ─────────────────────────────────────────────────────
describe('B. overrides payload', () => {
  it('omits empty text fields', () => {
    const o = buildOverrides(baseForm());
    expect(o.productNameEn).toBe('Glow Serum');
    expect(o.productNameAr).toBe('سيروم التوهج');
    expect(o).not.toHaveProperty('descriptionEn');
    expect(o).not.toHaveProperty('usageAr');
    expect(o).not.toHaveProperty('brandId');
    expect(o).not.toHaveProperty('brandName');
    expect(o).not.toHaveProperty('categoryId');
    expect(o).not.toHaveProperty('subcategoryId');
  });

  it('sends brandId (existing) and never brandName when both are set', () => {
    const o = buildOverrides(baseForm({ brandId: 10, brandName: 'New Brand' }));
    expect(o.brandId).toBe(10);
    expect(o).not.toHaveProperty('brandName');
  });

  it('sends brandName only when no existing brand is selected', () => {
    const o = buildOverrides(baseForm({ brandId: '', brandName: 'Fresh Brand' }));
    expect(o.brandName).toBe('Fresh Brand');
    expect(o).not.toHaveProperty('brandId');
  });

  it('sends category + subcategory as numbers when compatible', () => {
    const o = buildOverrides(baseForm({ categoryId: 5, subcategoryId: 91 }), SUBS);
    expect(o.categoryId).toBe(5);
    expect(o.subcategoryId).toBe(91);
    expect(typeof o.categoryId).toBe('number');
    expect(typeof o.subcategoryId).toBe('number');
  });

  it('drops a subcategory that does not belong to the chosen category', () => {
    const o = buildOverrides(baseForm({ categoryId: 5, subcategoryId: 93 }), SUBS); // 93 → cat 7
    expect(o.categoryId).toBe(5);
    expect(o).not.toHaveProperty('subcategoryId');
  });
});

// ─── C. Validation ────────────────────────────────────────────────────────────
describe('C. validation', () => {
  it('blocks submit when EN name is empty', () => {
    const { ok, errors } = validateForm(baseForm({ productNameEn: '   ' }));
    expect(ok).toBe(false);
    expect(errors.productNameEn).toBeTruthy();
  });
  it('blocks submit when AR name is empty', () => {
    const { ok, errors } = validateForm(baseForm({ productNameAr: '' }));
    expect(ok).toBe(false);
    expect(errors.productNameAr).toBeTruthy();
  });
  it('passes when both names are present', () => {
    expect(validateForm(baseForm()).ok).toBe(true);
  });
  it('never sends non-positive/invalid brand or category ids', () => {
    const o = buildOverrides(baseForm({ brandId: 0 as unknown as number, categoryId: -1 as unknown as number }));
    expect(o).not.toHaveProperty('brandId');
    expect(o).not.toHaveProperty('categoryId');
  });
});

// ─── Category → subcategory helpers ───────────────────────────────────────────
describe('category/subcategory helpers', () => {
  it('filters subcategories by category', () => {
    expect(subcategoriesForCategory(SUBS, 5).map((s) => s.id)).toEqual([91, 92]);
    expect(subcategoriesForCategory(SUBS, '')).toEqual([]);
  });
  it('clears an incompatible subcategory on category change', () => {
    const changed = clearIncompatibleSubcategory(baseForm({ categoryId: 7, subcategoryId: 91 }), SUBS);
    expect(changed.subcategoryId).toBe('');
    const kept = clearIncompatibleSubcategory(baseForm({ categoryId: 5, subcategoryId: 91 }), SUBS);
    expect(kept.subcategoryId).toBe(91);
  });
});

// ─── D. Success reducer ───────────────────────────────────────────────────────
describe('D. success reducer', () => {
  const start = { items: [{ id: 1 }, { id: 2 }, { id: 3 }], total: 3 };

  it('removes exactly one draft and decrements total once', () => {
    const next = applyRecoverySuccess(start, 2);
    expect(next.items.map((i) => i.id)).toEqual([1, 3]);
    expect(next.total).toBe(2);
  });

  it('is idempotent: repeating a success does not double-decrement or go negative', () => {
    const once = applyRecoverySuccess(start, 2);
    const twice = applyRecoverySuccess(once, 2); // already removed
    expect(twice.items.map((i) => i.id)).toEqual([1, 3]);
    expect(twice.total).toBe(2);

    const emptied = applyRecoverySuccess({ items: [], total: 0 }, 99);
    expect(emptied.total).toBe(0);
  });
});

// ─── E. Busy guard (synchronous per-draft ref lock) ───────────────────────────
//
// The dashboard's real guard is a synchronous Set held in a useRef: acquire
// checks + adds before any await; release runs in `finally`. These tests model
// that exact algorithm (a plain Set == busyRef.current) so the acquire/release
// semantics are pinned regardless of React batching.
function makeLock() {
  const set = new Set<number>();
  return {
    acquire(id: number): boolean {
      if (set.has(id)) return false; // guard BEFORE any work
      set.add(id);
      return true;
    },
    release(id: number) {
      set.delete(id);
    },
    has: (id: number) => set.has(id),
  };
}

describe('E. busy guard (synchronous ref lock)', () => {
  it('1) first acquire for a draft succeeds', () => {
    const lock = makeLock();
    expect(lock.acquire(1)).toBe(true);
  });

  it('2) a second acquire before release fails', () => {
    const lock = makeLock();
    expect(lock.acquire(1)).toBe(true);
    expect(lock.acquire(1)).toBe(false);
  });

  it('3) another draft can acquire at the same time', () => {
    const lock = makeLock();
    expect(lock.acquire(1)).toBe(true);
    expect(lock.acquire(2)).toBe(true); // independent lock per draft
    expect(lock.has(1)).toBe(true);
    expect(lock.has(2)).toBe(true);
  });

  it('4) release allows a fresh attempt', () => {
    const lock = makeLock();
    lock.acquire(1);
    lock.release(1);
    expect(lock.acquire(1)).toBe(true);
  });

  it('5) release happens after success', async () => {
    const lock = makeLock();
    async function submit(id: number, work: () => Promise<void>) {
      if (!lock.acquire(id)) return;
      try {
        await work();
      } finally {
        lock.release(id);
      }
    }
    await submit(1, async () => {}); // success path
    expect(lock.has(1)).toBe(false); // released → retriable
    expect(lock.acquire(1)).toBe(true);
  });

  it('6) release happens after a network/API failure', async () => {
    const lock = makeLock();
    async function submit(id: number, work: () => Promise<void>) {
      if (!lock.acquire(id)) return;
      try {
        await work();
      } catch {
        /* swallow — mirrors the dashboard catch */
      } finally {
        lock.release(id);
      }
    }
    await submit(1, async () => {
      throw new Error('network down');
    });
    expect(lock.has(1)).toBe(false); // still released on error
    expect(lock.acquire(1)).toBe(true);
  });
});

// The pure Set helpers remain available for reuse and are kept covered here.
describe('busy-set helpers (pure)', () => {
  it('canSubmit / markBusy / releaseBusy compose correctly', () => {
    let busy: ReadonlySet<number> = new Set();
    expect(canSubmit(busy, 1)).toBe(true);
    busy = markBusy(busy, 1);
    expect(canSubmit(busy, 1)).toBe(false);
    expect(canSubmit(busy, 2)).toBe(true);
    busy = releaseBusy(busy, 1);
    expect(canSubmit(busy, 1)).toBe(true);
  });
});

// ─── F. API error normalization ───────────────────────────────────────────────
describe('F. error normalization', () => {
  it('maps known codes to clear, non-generic messages', () => {
    for (const code of [
      'BAD_REQUEST', 'DRAFT_NOT_FOUND', 'DRAFT_NOT_RECOVERABLE', 'INVALID_SUGGESTION',
      'BAD_BRAND', 'BAD_CATEGORY', 'BAD_SUBCATEGORY', 'RECOVERY_INCONSISTENT', 'RECOVERY_PRODUCT_FAILED',
    ]) {
      const msg = recoveryErrorMessage(code);
      expect(msg).toBeTruthy();
      expect(msg).not.toBe(GENERIC_ERROR_MESSAGE);
    }
  });

  it('never surfaces a raw DB message (only the code is consulted)', () => {
    const msg = recoveryErrorMessage('RECOVERY_PRODUCT_FAILED');
    expect(msg).not.toMatch(/null value|violates|column|constraint|postgres/i);
    // unknown code → generic, still no raw text
    expect(recoveryErrorMessage('SOME_WEIRD_CODE')).toBe(GENERIC_ERROR_MESSAGE);
  });

  it('uses a fixed message for network errors', () => {
    expect(recoveryErrorMessage(undefined, { isNetwork: true })).toBe(NETWORK_ERROR_MESSAGE);
    expect(recoveryErrorMessage('BAD_BRAND', { isNetwork: true })).toBe(NETWORK_ERROR_MESSAGE);
  });

  it('flags server-side faults distinctly from field errors', () => {
    expect(isServerSideError('RECOVERY_INCONSISTENT')).toBe(true);
    expect(isServerSideError('RECOVERY_PRODUCT_FAILED')).toBe(true);
    expect(isServerSideError('BAD_BRAND')).toBe(false);
  });
});

// ─── misc display helpers ─────────────────────────────────────────────────────
describe('display helpers', () => {
  it('summarizes a failing payload without dumping full JSON', () => {
    const s = summarizeFailingPayload({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 });
    expect(s).toContain('a, b, c, d, e, f');
    expect(s).toContain('+1 more');
    expect(summarizeFailingPayload(null)).toBe('');
    expect(summarizeFailingPayload([1, 2, 3])).toBe('');
  });
  it('builds the product link', () => {
    expect(productHref('MK-SKN-0001')).toBe('/products/MK-SKN-0001');
  });
});

// ─── Source contract: client components go through the API, not Supabase ──────
describe('source contract (client components)', () => {
  const dir = path.resolve(__dirname, '..');
  const dashboard = readFileSync(path.join(dir, 'recovery-dashboard.tsx'), 'utf8');
  const card = readFileSync(path.join(dir, 'recovery-draft-card.tsx'), 'utf8');

  it('dashboard calls the recover API (GET + POST)', () => {
    expect(dashboard).toContain('/api/bulk-ai/recover');
    expect(dashboard).toMatch(/method:\s*'POST'/);
  });

  it('client components never import a Supabase client', () => {
    expect(dashboard).not.toMatch(/@\/lib\/supabase/);
    expect(dashboard).not.toContain('createAdminSupabaseClient');
    expect(dashboard).not.toContain('createServerSupabaseClient');
    expect(card).not.toMatch(/@\/lib\/supabase/);
  });

  it('7) dashboard holds the busy lock in a useRef (real synchronous lock)', () => {
    expect(dashboard).toContain('useRef');
    expect(dashboard).toMatch(/busyRef\s*=\s*useRef/);
  });

  it('8) the guard check precedes the fetch call', () => {
    const guardIdx = dashboard.indexOf('busyRef.current.has');
    const addIdx = dashboard.indexOf('busyRef.current.add');
    const fetchIdx = dashboard.indexOf("fetch('/api/bulk-ai/recover'");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx); // guard before network
    expect(addIdx).toBeLessThan(fetchIdx);   // lock acquired before network
  });

  it('9) the lock is released inside a finally block', () => {
    expect(dashboard).toMatch(/finally\s*\{[\s\S]*busyRef\.current\.delete/);
  });
});
