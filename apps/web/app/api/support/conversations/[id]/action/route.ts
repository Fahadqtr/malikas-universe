/**
 * POST /api/support/conversations/[id]/action
 *
 * Quick-action helper. Returns a PRE-FILLED reply draft the human can edit
 * and then send via /reply (mode='human'). Also applies sensible defaults
 * (e.g. refund_issue → priority=high + tag).
 *
 * NEVER auto-sends. NEVER auto-issues refunds or coupons. Per spec rules.
 *
 * Body: { action: ActionId, extra?: { ... } }
 *
 * Returns: { draft_ar, draft_en, applied: { ... } }
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import type { Database } from '@malikas/db';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type Ctx = { params: { id: string } };

const ACTIONS = [
  'recommend_products',
  'escalate',
  'send_coupon',
  'request_photos',
  'refund_issue',
  'fake_product_claim',
  'delivery_issue',
] as const;

const Body = z.object({
  action: z.enum(ACTIONS),
  extra: z.record(z.string()).optional(),
});

type ActionConfig = {
  draft_ar: string;
  draft_en: string;
  /** Side effects to apply: priority, status, tags, ai_enabled */
  applies: {
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    status?: 'open' | 'escalated' | 'resolved';
    ai_enabled?: boolean;
    tag?: string;
  };
  /** Internal note kind */
  note_kind: 'note' | 'action' | 'escalation';
};

const TEMPLATES: Record<(typeof ACTIONS)[number], ActionConfig> = {
  recommend_products: {
    draft_ar: 'هلا فيك! خليني أنصحك بمنتجات تناسبك:\n\n[اكتب المنتجات هنا]\n\nأي وحدة تشدّك؟',
    draft_en: "Hi! Let me recommend a few products for you:\n\n[type product names here]\n\nWhich one catches your eye?",
    applies: {},
    note_kind: 'action',
  },
  escalate: {
    draft_ar: 'شكراً لتواصلك. سأحوّل محادثتك لمختصة لتساعدك بشكل أفضل، تكفي إعطنا لحظة.',
    draft_en: 'Thanks for reaching out. I\'m forwarding you to a specialist who can help further — one moment please.',
    applies: { status: 'escalated', priority: 'high', ai_enabled: false, tag: 'escalated' },
    note_kind: 'escalation',
  },
  send_coupon: {
    draft_ar: 'بسعدنا نقدّم لك خصم! [ضع رقم الكود + قيمة الخصم] — يصلح لـ [وضّحي شروط الاستخدام].',
    draft_en: "We'd love to offer you a discount! Code: [INSERT_CODE] — valid for [conditions].",
    applies: { tag: 'coupon_offered' },
    note_kind: 'action',
  },
  request_photos: {
    draft_ar: 'لمساعدتك أكثر، ممكن ترسلين صور للمنتج (الكرتون + المنتج نفسه + الفاتورة لو متوفرة)؟',
    draft_en: 'To help you better, could you send us photos? (Box + the product itself + receipt if available)',
    applies: { tag: 'awaiting_photos' },
    note_kind: 'action',
  },
  refund_issue: {
    draft_ar: 'آسفين على هذي التجربة. خلاص فهمت، خليني آخذ تفاصيلك واتأكد من سياسة الاسترجاع وأرد لك خلال الـ24 ساعة الجاية.',
    draft_en: "I'm sorry for this experience. Let me take your details, check our return policy, and get back to you within 24 hours.",
    applies: { priority: 'high', ai_enabled: false, tag: 'refund' },
    note_kind: 'escalation',
  },
  fake_product_claim: {
    draft_ar: 'شكراً لإبلاغنا، نأخذ هذا الموضوع بجدية كاملة. الفريق المختص يحتاج صور واضحة + رقم الباركود + إيصال الشراء لفحص الادعاء.',
    draft_en: "Thank you for reporting — we take this very seriously. Our team will need clear photos + the barcode + proof of purchase to investigate.",
    applies: { priority: 'urgent', ai_enabled: false, tag: 'fake_claim', status: 'escalated' },
    note_kind: 'escalation',
  },
  delivery_issue: {
    draft_ar: 'بخصوص الطلب، أنا في Malika ما عندي وصول مباشر لمعلومات التوصيل — أنصحك تتواصلين مع منصة الطلب (Snoonu / Talabat / Rafeeq) وهم بيعرفون يساعدونك بدقة.',
    draft_en: "For delivery questions, I don't have direct access — please contact the delivery platform you ordered from (Snoonu / Talabat / Rafeeq) for accurate tracking.",
    applies: { tag: 'delivery' },
    note_kind: 'action',
  },
};

export const POST = withErrorHandling(async (req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', 'Cannot run quick actions', 403);
  }

  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return err('BAD_ID', 'Invalid conversation id', 400);

  const body = Body.parse(await req.json());
  const cfg = TEMPLATES[body.action];
  const admin = createAdminSupabaseClient();

  // Apply side effects
  const updates: Record<string, unknown> = {};
  if (cfg.applies.priority) updates.priority = cfg.applies.priority;
  if (cfg.applies.status) updates.status = cfg.applies.status;
  if (cfg.applies.ai_enabled !== undefined) updates.ai_enabled = cfg.applies.ai_enabled;

  if (Object.keys(updates).length > 0) {
    await admin
      .from('conversations')
      .update(updates as Database['public']['Tables']['conversations']['Update'])
      .eq('id', id);
  }

  if (cfg.applies.tag) {
    await admin
      .from('conversation_tags')
      .insert({ conversation_id: id, tag: cfg.applies.tag, added_by: actor.email })
      .then(() => undefined);
  }

  // Internal audit note
  await admin.from('support_notes').insert({
    conversation_id: id,
    body: `Quick action: ${body.action.replace(/_/g, ' ')}`,
    kind: cfg.note_kind,
    author_email: actor.email,
    author_name: actor.email,
    metadata: { action: 'quick_action', kind: body.action, applied: cfg.applies },
  });

  return ok({
    action: body.action,
    draft_ar: cfg.draft_ar,
    draft_en: cfg.draft_en,
    applied: cfg.applies,
  });
});
