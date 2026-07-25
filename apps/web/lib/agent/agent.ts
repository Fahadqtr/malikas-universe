/**
 * Main WhatsApp agent loop.
 *
 * Responsibilities:
 *   1. Find/create the conversations row for this customer phone
 *   2. Load recent message history (so the agent has context)
 *   3. Save the inbound message
 *   4. Run Claude with tools (MALIKA_WHATSAPP_SYSTEM_PROMPT + AGENT_TOOLS)
 *   5. Save the outbound reply
 *   6. Log usage + tool calls + escalations
 *
 * Returns the reply, matched products, escalations, and a trace.
 *
 * Same function powers:
 *   • /api/whatsapp/reply-test  (local testing)
 *   • /api/whatsapp/webhook     (live customer messages)
 *
 * The only difference: webhook also calls lib/whatsapp.ts to send the reply
 * back to the customer over WhatsApp Cloud API. The test endpoint just
 * returns the reply in JSON.
 */

import { createAdminSupabaseClient } from '@/lib/supabase/server';
import type { Json } from '@malikas/db';
import { callClaudeAgent, estimateCostUsd, MODELS } from '@/lib/claude';
import { MALIKA_WHATSAPP_SYSTEM_PROMPT } from './prompts';
import { AGENT_TOOLS, createAgentExecutor } from './tools';

const MAX_HISTORY_MESSAGES = 8; // last 8 turns for context — keeps cost low

export type AgentResult = {
  conversation_id: number;
  reply: string;
  matched_products: Array<{
    master_sku: string;
    name_en: string;
    name_ar: string;
    brand: string;
    category: string;
    price_qar: number;
    image_url: string | null;
  }>;
  escalations: Array<{ reason: string; summary: string; severity: string }>;
  tool_calls: Array<{ name: string; input: Record<string, unknown>; output: unknown }>;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number; latency_ms: number };
  language: 'ar' | 'en' | 'mixed';
};

export async function runWhatsappAgent(args: {
  customer_phone: string;
  customer_name?: string;
  message_body: string;
  media_url?: string;
}): Promise<AgentResult> {
  const t0 = Date.now();
  const admin = createAdminSupabaseClient();
  const phone = normalizePhone(args.customer_phone);
  const language = detectLanguage(args.message_body);

  // ── 1. Find or create the conversation ────────────────────────────────────
  const conversation = await upsertConversation(admin, {
    phone,
    name: args.customer_name,
    language,
  });

  // ── 2. Save the inbound message ──────────────────────────────────────────
  await admin.from('messages').insert({
    conversation_id: conversation.id,
    direction: 'inbound',
    body: args.message_body,
    media_url: args.media_url ?? null,
  });

  // ── 3. Load recent history (so agent has context) ────────────────────────
  const history = await loadRecentMessages(admin, conversation.id, MAX_HISTORY_MESSAGES);

  // The most recent inbound message we just saved IS the last entry in history
  // (we'll re-derive the messages array from it for the agent call).
  const agentMessages = history.map((m) => ({
    role: m.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
    content: m.body,
  }));

  // ── 4. Run the agent ──────────────────────────────────────────────────────
  const executor = createAgentExecutor({
    conversationId: conversation.id,
    customerPhone: phone,
  });

  const run = await callClaudeAgent({
    model: 'haiku',
    system: MALIKA_WHATSAPP_SYSTEM_PROMPT,
    messages: agentMessages,
    tools: AGENT_TOOLS,
    execute: executor.execute,
    maxTurns: 6,
    maxTokens: 1200,
  });

  // ── 5. Save the outbound reply ───────────────────────────────────────────
  await admin.from('messages').insert({
    conversation_id: conversation.id,
    direction: 'outbound',
    body: run.reply,
    ai_model: run.model,
    tools_called: run.tool_calls.map((t) => ({ name: t.name, input: t.input })) as Json,
  });

  // ── 6. Update conversation aggregates + escalation flag ──────────────────
  const wasEscalated = executor.escalations.length > 0;
  await admin
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      total_messages: (conversation.total_messages ?? 0) + 2, // inbound + outbound
      escalated: wasEscalated || conversation.escalated || false,
      status: wasEscalated ? 'escalated' : conversation.status,
    })
    .eq('id', conversation.id);

  // ── 7. Log AI usage (non-fatal) ──────────────────────────────────────────
  const latency_ms = Date.now() - t0;
  const cost_usd = estimateCostUsd(run.model, run.usage.input, run.usage.output);
  void admin
    .from('ai_usage_log')
    .insert({
      conversation_id: conversation.id,
      model: run.model,
      operation: wasEscalated ? 'whatsapp_agent+escalation' : 'whatsapp_agent',
      input_tokens: run.usage.input,
      output_tokens: run.usage.output,
      cost_usd,
      latency_ms,
      success: true,
    })
    .then(() => undefined);

  return {
    conversation_id: conversation.id,
    reply: run.reply,
    matched_products: executor.matched_products.map((p) => ({
      master_sku: p.master_sku,
      name_en: p.name_en,
      name_ar: p.name_ar,
      brand: p.brand,
      category: p.category,
      price_qar: p.price_qar,
      image_url: p.image_url,
    })),
    escalations: executor.escalations,
    tool_calls: run.tool_calls.map((t) => ({
      name: t.name,
      input: t.input,
      output: t.output,
    })),
    usage: {
      input_tokens: run.usage.input,
      output_tokens: run.usage.output,
      cost_usd,
      latency_ms,
    },
    language,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePhone(raw: string): string {
  // Strip whitespace and any non-digit except leading +
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) {
    return '+' + trimmed.slice(1).replace(/\D/g, '');
  }
  return trimmed.replace(/\D/g, '');
}

function detectLanguage(text: string): 'ar' | 'en' | 'mixed' {
  const hasArabic = /[؀-ۿ]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  if (hasArabic && hasLatin) return 'mixed';
  if (hasArabic) return 'ar';
  return 'en';
}

async function upsertConversation(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  args: { phone: string; name?: string | undefined; language: 'ar' | 'en' | 'mixed' },
): Promise<{ id: number; status: string; total_messages: number; escalated: boolean }> {
  // Try to fetch existing
  const { data: existing } = await admin
    .from('conversations')
    .select('id, status, total_messages, escalated')
    .eq('customer_phone', args.phone)
    .maybeSingle();

  if (existing) {
    return {
      id: existing.id,
      status: existing.status ?? 'open',
      total_messages: existing.total_messages ?? 0,
      escalated: existing.escalated ?? false,
    };
  }

  const { data: created, error } = await admin
    .from('conversations')
    .insert({
      customer_phone: args.phone,
      customer_name: args.name ?? null,
      language: args.language,
      status: 'open',
    })
    .select('id, status, total_messages, escalated')
    .single();

  if (error || !created) {
    throw new Error(`upsertConversation: ${error?.message ?? 'unknown'}`);
  }
  return {
    id: created.id,
    status: created.status ?? 'open',
    total_messages: created.total_messages ?? 0,
    escalated: created.escalated ?? false,
  };
}

async function loadRecentMessages(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  conversationId: number,
  limit: number,
): Promise<Array<{ direction: 'inbound' | 'outbound'; body: string }>> {
  const { data } = await admin
    .from('messages')
    .select('direction, body, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  // Return in chronological order (oldest first)
  return ((data ?? []) as Array<{ direction: 'inbound' | 'outbound'; body: string }>)
    .slice()
    .reverse();
}
