/**
 * Tools the WhatsApp agent can call.
 *
 *   • search_products       — text/brand/category search
 *   • find_products_by_concern — query by skin/hair concern (acne, dryness, frizz…)
 *   • get_product_by_sku    — full details for one product
 *   • escalate_to_human     — flag conversation for human follow-up
 *
 * Every tool that reads products applies hard filters:
 *   • product_status = 'active' (approved only — no drafts shown to customers)
 *   • deleted_at IS NULL
 *
 * Returns are JSON-serializable plain objects/strings (Claude consumes them as text).
 */

import { createAdminSupabaseClient } from '@/lib/supabase/server';
import type { AgentTool, ToolExecutor } from '@/lib/claude';

// ─── Tool DEFINITIONS (sent to Claude) ──────────────────────────────────────

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'search_products',
    description:
      'Search the active product catalog by free-text query, brand, and/or category. Returns up to 5 products with master_sku, names (EN+AR), brand, category, price, stock_status, and image_url. Use this when the customer asks for a specific product, brand, or category.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free text to match against product_name_en, product_name_ar, and keywords. Optional. Example: "vitamin c serum", "ميديكيوب", "lip tint".',
        },
        brand: {
          type: 'string',
          description: 'Brand name to filter by, e.g. "Medicube", "Anua". Case-insensitive.',
        },
        category: {
          type: 'string',
          description:
            'Main category name, one of: "Korean Skincare", "Thai Products", "Hair Care", "Makeup", "Body Care", "Perfumes", "Beauty Tools", "Bags & Accessories", "Gifts & Sets", "Kids & Toys", "Trending Products".',
        },
        max_results: {
          type: 'integer',
          description: 'Max number of products to return (default 5, max 10).',
          minimum: 1,
          maximum: 10,
        },
      },
    },
  },
  {
    name: 'find_products_by_concern',
    description:
      'Find products that help with a SKIN or HAIR CONCERN, not by name. Use this when the customer describes a problem rather than a product. Examples: "acne", "dry skin", "frizz", "dark spots", "حب الشباب", "بشرة جافة".',
    input_schema: {
      type: 'object',
      properties: {
        concern: {
          type: 'string',
          description:
            'Customer concern in English OR Arabic. Mapped server-side to keywords across products.',
        },
        max_results: {
          type: 'integer',
          description: 'Max products to return (default 3).',
          minimum: 1,
          maximum: 5,
        },
      },
      required: ['concern'],
    },
  },
  {
    name: 'get_product_by_sku',
    description:
      'Get full details for one product by its master SKU. Returns price, stock, descriptions (EN+AR), usage steps, image, brand, category. Use when you need the full details for a product the customer is asking about.',
    input_schema: {
      type: 'object',
      properties: {
        master_sku: {
          type: 'string',
          description: 'The product SKU, e.g. "MK-SKIN-0042".',
        },
      },
      required: ['master_sku'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Flag this conversation for human follow-up. Call when: customer mentions a refund > 100 QAR, complaint about damaged/fake product, asks about an order or delivery tracking, is abusive or angry, or when you genuinely cannot help after 3+ tries.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: [
            'refund_over_100',
            'fake_claim',
            'abusive',
            'repeat_complaint',
            'low_confidence',
            'manual',
            'complex_query',
          ],
          description: 'Why this is being escalated.',
        },
        summary: {
          type: 'string',
          description:
            '2-3 sentence summary for the human agent: the customer ask, what was tried, any SKUs discussed.',
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description:
            'critical = abuse/legal risk, high = active complaint, medium = unresolved Q, low = info request.',
        },
      },
      required: ['reason', 'summary', 'severity'],
    },
  },
];

// ─── Concern → keywords map ─────────────────────────────────────────────────
// Maps free-text customer concerns to product keywords across EN+AR.
// Conservative: only well-known mappings, no medical claims.

const CONCERN_MAP: Record<string, string[]> = {
  // Skin
  acne: ['acne', 'breakout', 'pimple', 'حب الشباب', 'حبوب', 'salicylic'],
  dryness: ['dry', 'hydrating', 'moisturizing', 'جاف', 'ترطيب', 'مرطب'],
  oily: ['oily', 'sebum', 'mattifying', 'دهني', 'لمعان'],
  pores: ['pore', 'minimize', 'مسام', 'تقليل المسام'],
  dark_spots: ['brightening', 'dark spot', 'vitamin c', 'تفتيح', 'بقع داكنة'],
  aging: ['anti-aging', 'wrinkle', 'retinol', 'تجاعيد', 'شد البشرة'],
  sun: ['sunscreen', 'spf', 'sun protection', 'واقي شمس', 'حماية من الشمس'],
  redness: ['soothing', 'calming', 'sensitive', 'تهدئة', 'احمرار'],
  // Hair
  frizz: ['frizz', 'smoothing', 'هيشان', 'فرد'],
  dandruff: ['scalp', 'dandruff', 'قشرة', 'فروة'],
  hair_loss: ['strengthening', 'keratin', 'protein', 'تساقط', 'كيراتين'],
  damaged_hair: ['repair', 'damaged', 'تالف', 'علاج الشعر'],
  // Body
  body_dryness: ['body lotion', 'body cream', 'كريم جسم', 'لوشن'],
};

function expandConcern(concern: string): string[] {
  const lower = concern.toLowerCase().trim();
  const keys: string[] = [];

  // Direct map keys
  for (const [k, kws] of Object.entries(CONCERN_MAP)) {
    if (lower.includes(k.replace(/_/g, ' ')) || kws.some((kw) => lower.includes(kw.toLowerCase()))) {
      keys.push(...kws);
    }
  }
  // Always include the raw concern as a fallback search term
  keys.push(lower);
  return Array.from(new Set(keys));
}

// ─── Tool RESULT shapes (compact for token efficiency) ───────────────────────

type ProductBrief = {
  master_sku: string;
  name_en: string;
  name_ar: string;
  brand: string;
  category: string;
  price_qar: number;
  discount_price_qar: number | null;
  stock_status: string;
  image_url: string | null;
};

type ProductFull = ProductBrief & {
  product_type: string | null;
  size: string | null;
  description_en: string | null;
  description_ar: string | null;
  usage_en: string | null;
  usage_ar: string | null;
  keywords_en: string[] | null;
};

// ─── Tool EXECUTOR factory ──────────────────────────────────────────────────

/**
 * Returns a ToolExecutor bound to a given conversation. The conversation_id
 * is used when the agent calls escalate_to_human so we can write into the
 * escalations table.
 */
export function createAgentExecutor(args: {
  conversationId: number | null;
  customerPhone: string;
}): {
  execute: ToolExecutor;
  /** All escalations that were triggered during this run (for the route to act on) */
  escalations: Array<{ reason: string; summary: string; severity: string }>;
  /** All products surfaced via tools, deduped by SKU */
  matched_products: ProductBrief[];
} {
  const admin = createAdminSupabaseClient();
  const escalations: Array<{ reason: string; summary: string; severity: string }> = [];
  const matchedMap = new Map<string, ProductBrief>();

  const execute: ToolExecutor = async (name, input) => {
    try {
      if (name === 'search_products') {
        const result = await searchProducts(admin, {
          query: input.query as string | undefined,
          brand: input.brand as string | undefined,
          category: input.category as string | undefined,
          max_results: clampInt(input.max_results, 1, 10, 5),
        });
        for (const p of result) matchedMap.set(p.master_sku, p);
        return { output: result };
      }

      if (name === 'find_products_by_concern') {
        const concern = String(input.concern ?? '').trim();
        if (!concern) {
          return { output: { error: 'concern is required' }, is_error: true };
        }
        const keywords = expandConcern(concern);
        const result = await searchByKeywords(admin, keywords, clampInt(input.max_results, 1, 5, 3));
        for (const p of result) matchedMap.set(p.master_sku, p);
        return { output: result };
      }

      if (name === 'get_product_by_sku') {
        const sku = String(input.master_sku ?? '').trim();
        if (!sku) return { output: { error: 'master_sku required' }, is_error: true };
        const result = await getProductBySku(admin, sku);
        if (result) {
          matchedMap.set(result.master_sku, {
            master_sku: result.master_sku,
            name_en: result.name_en,
            name_ar: result.name_ar,
            brand: result.brand,
            category: result.category,
            price_qar: result.price_qar,
            discount_price_qar: result.discount_price_qar,
            stock_status: result.stock_status,
            image_url: result.image_url,
          });
        }
        return { output: result ?? { error: `No active product with SKU ${sku}` } };
      }

      if (name === 'escalate_to_human') {
        const reason = String(input.reason ?? 'manual');
        const summary = String(input.summary ?? '');
        const severity = String(input.severity ?? 'medium');
        escalations.push({ reason, summary, severity });

        // Best-effort write to escalations table (won't block reply if it fails)
        try {
          await admin.from('escalations').insert({
            conversation_id: args.conversationId,
            customer_phone: args.customerPhone,
            reason,
            severity,
            summary,
            status: 'open',
          });
        } catch (e) {
          console.error('[agent] escalation write failed:', e);
        }
        return {
          output: {
            escalated: true,
            reason,
            severity,
            message:
              'Conversation flagged for human follow-up. Tell the customer politely a team member will reach out soon.',
          },
        };
      }

      return { output: { error: `Unknown tool: ${name}` }, is_error: true };
    } catch (e) {
      return {
        output: `Tool ${name} failed: ${e instanceof Error ? e.message : 'unknown'}`,
        is_error: true,
      };
    }
  };

  return {
    execute,
    escalations,
    get matched_products() {
      return Array.from(matchedMap.values());
    },
  };
}

// ─── Search helpers ──────────────────────────────────────────────────────────

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function searchProducts(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  opts: { query?: string; brand?: string; category?: string; max_results: number },
): Promise<ProductBrief[]> {
  let q = admin
    .from('products')
    .select(
      `master_sku, product_name_en, product_name_ar, price, discount_price,
       stock_status, image_url,
       brand:brands(id, name, name_ar),
       category:categories(id, name)`,
    )
    .eq('product_status', 'active')
    .is('deleted_at', null);

  if (opts.brand) {
    // Resolve brand name → brand_id
    const { data: b } = await admin.from('brands').select('id').ilike('name', opts.brand).maybeSingle();
    if (b) q = q.eq('brand_id', b.id);
  }
  if (opts.category) {
    const { data: c } = await admin
      .from('categories')
      .select('id')
      .ilike('name', opts.category)
      .maybeSingle();
    if (c) q = q.eq('category_id', c.id);
  }
  if (opts.query) {
    const escaped = opts.query.replace(/[%_]/g, '');
    q = q.or(
      `product_name_en.ilike.%${escaped}%,product_name_ar.ilike.%${escaped}%,master_sku.ilike.%${escaped}%`,
    );
  }
  q = q.order('updated_at', { ascending: false }).limit(opts.max_results);

  const { data, error } = await q;
  if (error) throw new Error(`search_products: ${error.message}`);
  return (data ?? []).map(toProductBrief);
}

async function searchByKeywords(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  keywords: string[],
  maxResults: number,
): Promise<ProductBrief[]> {
  if (keywords.length === 0) return [];

  // Build OR clause across name_en, name_ar, and keywords arrays.
  // PostgREST: keywords_en.cs.{kw} matches if array contains kw.
  const clauses: string[] = [];
  for (const kw of keywords.slice(0, 10)) {
    const escaped = kw.replace(/[%_]/g, '');
    clauses.push(`product_name_en.ilike.%${escaped}%`);
    clauses.push(`product_name_ar.ilike.%${escaped}%`);
    clauses.push(`description_en.ilike.%${escaped}%`);
  }

  const { data, error } = await admin
    .from('products')
    .select(
      `master_sku, product_name_en, product_name_ar, price, discount_price,
       stock_status, image_url,
       brand:brands(id, name, name_ar),
       category:categories(id, name)`,
    )
    .eq('product_status', 'active')
    .is('deleted_at', null)
    .or(clauses.join(','))
    .order('updated_at', { ascending: false })
    .limit(maxResults);

  if (error) throw new Error(`find_products_by_concern: ${error.message}`);
  return (data ?? []).map(toProductBrief);
}

async function getProductBySku(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  sku: string,
): Promise<ProductFull | null> {
  const { data, error } = await admin
    .from('products')
    .select(
      `master_sku, product_name_en, product_name_ar, product_type, size,
       price, discount_price, stock_status, image_url,
       description_en, description_ar, usage_en, usage_ar, keywords_en,
       brand:brands(id, name, name_ar),
       category:categories(id, name)`,
    )
    .eq('master_sku', sku)
    .eq('product_status', 'active')
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new Error(`get_product_by_sku: ${error.message}`);
  if (!data) return null;

  const brief = toProductBrief(data);
  const row = data as Record<string, unknown>;
  return {
    ...brief,
    product_type: (row.product_type as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    description_en: (row.description_en as string | null) ?? null,
    description_ar: (row.description_ar as string | null) ?? null,
    usage_en: (row.usage_en as string | null) ?? null,
    usage_ar: (row.usage_ar as string | null) ?? null,
    keywords_en: (row.keywords_en as string[] | null) ?? null,
  };
}

function toProductBrief(row: Record<string, unknown>): ProductBrief {
  const brand = (row.brand as { name?: string } | null)?.name ?? 'Unknown';
  const category = (row.category as { name?: string } | null)?.name ?? '';
  return {
    master_sku: String(row.master_sku),
    name_en: (row.product_name_en as string | null) ?? '',
    name_ar: (row.product_name_ar as string | null) ?? '',
    brand,
    category,
    price_qar: Number(row.price ?? 0),
    discount_price_qar: row.discount_price != null ? Number(row.discount_price) : null,
    stock_status: (row.stock_status as string | null) ?? 'unknown',
    image_url: (row.image_url as string | null) ?? null,
  };
}
