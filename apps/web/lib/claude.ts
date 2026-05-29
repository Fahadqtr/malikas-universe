/**
 * Anthropic Claude wrapper.
 * Centralized client + cost logging + safe JSON output.
 */
import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY not configured. Add it to apps/web/.env.local then restart pnpm dev.',
    );
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

export const MODELS = {
  haiku: process.env.ANTHROPIC_MODEL_HAIKU ?? 'claude-haiku-4-5-20251001',
  sonnet: process.env.ANTHROPIC_MODEL_SONNET ?? 'claude-sonnet-4-6',
} as const;

export type ImageInput = { type: 'url'; url: string } | { type: 'base64'; mediaType: string; data: string };

/**
 * Call Claude with vision + structured JSON output.
 * Returns the parsed JSON object (validated via callback) or throws.
 */
export async function callClaudeJson<T>(opts: {
  model?: keyof typeof MODELS;
  system: string;
  prompt: string;
  image?: ImageInput;
  maxTokens?: number;
  validate: (raw: unknown) => T;
}): Promise<{ data: T; usage: { input: number; output: number } }> {
  const client = getClient();
  const model = MODELS[opts.model ?? 'haiku'];

  const content: Anthropic.ContentBlockParam[] = [];
  if (opts.image) {
    if (opts.image.type === 'url') {
      content.push({
        type: 'image',
        source: { type: 'url', url: opts.image.url },
      } as Anthropic.ImageBlockParam);
    } else {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: opts.image.mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
          data: opts.image.data,
        },
      });
    }
  }
  content.push({ type: 'text', text: opts.prompt });

  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 1500,
    system: opts.system,
    messages: [{ role: 'user', content }],
  });

  // Find the text block
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text content');
  }

  // Extract JSON from text (handles fenced ```json blocks too)
  const raw = extractJson(textBlock.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Claude returned invalid JSON: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  const validated = opts.validate(parsed);

  return {
    data: validated,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
  };
}

/**
 * Extract a JSON object/array from Claude's text response.
 * Handles markdown code fences and extra prose around the JSON.
 */
function extractJson(text: string): string {
  // Strip ```json ... ``` fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1]!.trim();

  // Find first { and last } (or [ and ])
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return text.slice(firstBracket, lastBracket + 1);
  }

  return text.trim();
}

/**
 * Estimate cost in USD from token counts.
 * Pricing as of late 2025 — update when Anthropic changes pricing.
 */
export function estimateCostUsd(model: string, input: number, output: number): number {
  const prices: Record<string, { in: number; out: number }> = {
    'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },     // per 1M tokens
    'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  };
  const p = prices[model] ?? prices['claude-haiku-4-5-20251001']!;
  return (input * p.in + output * p.out) / 1_000_000;
}

// ─── Tool-use loop (used by the WhatsApp agent) ──────────────────────────────

export type AgentTool = {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
};

export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ output: unknown; is_error?: boolean }>;

export type AgentTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'tool_use'; name: string; input: Record<string, unknown> }
  | { role: 'tool_result'; name: string; output: unknown; is_error?: boolean };

export type AgentRun = {
  /** the final assistant message shown to the user */
  reply: string;
  /** every tool call the agent made, in order */
  tool_calls: Array<{ name: string; input: Record<string, unknown>; output: unknown; is_error?: boolean }>;
  /** trace of the full conversation, for logging */
  trace: AgentTurn[];
  /** total usage across all loop iterations */
  usage: { input: number; output: number };
  /** model name for cost calculation */
  model: string;
};

/**
 * Run an agentic conversation with tools.
 *
 *   • system     — system prompt
 *   • messages   — conversation history (oldest → newest). Last entry is what
 *                  we're responding to.
 *   • tools      — declared tools the agent may call
 *   • execute    — callback that runs a tool and returns its result
 *   • maxTurns   — safety cap (default 6 — usually 2-3 is enough)
 *
 * Loop:
 *   1. Send messages + tools to Claude
 *   2. If response contains tool_use blocks → execute them, append results,
 *      go back to step 1
 *   3. If response is plain text → return it as the reply
 *   4. If maxTurns reached → return the last text or a safe fallback
 */
export async function callClaudeAgent(opts: {
  model?: keyof typeof MODELS;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: AgentTool[];
  execute: ToolExecutor;
  maxTurns?: number;
  maxTokens?: number;
}): Promise<AgentRun> {
  const client = getClient();
  const model = MODELS[opts.model ?? 'haiku'];
  const maxTurns = opts.maxTurns ?? 6;

  // Working message buffer — we mutate this as we add tool results
  // Cast to Anthropic's message type so we can append tool_use/tool_result blocks
  const conversation: Anthropic.MessageParam[] = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const trace: AgentTurn[] = opts.messages.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  })) as AgentTurn[];

  const tool_calls: AgentRun['tool_calls'] = [];
  let totalIn = 0;
  let totalOut = 0;
  let finalReply = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 1500,
      system: opts.system,
      tools: opts.tools as Anthropic.Tool[],
      messages: conversation,
    });

    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;

    // Collect any text response
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    // Add the assistant's full response (text + tool_use blocks) to history
    // — Anthropic requires the full content blocks, not just text
    conversation.push({
      role: 'assistant',
      content: response.content,
    });

    // If no tools called, we're done — return text
    if (toolUses.length === 0) {
      finalReply = textBlocks.map((b) => b.text).join('\n').trim();
      trace.push({ role: 'assistant', content: finalReply });
      break;
    }

    // Execute each tool sequentially (could parallelize but adds complexity)
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      trace.push({ role: 'tool_use', name: t.name, input: t.input as Record<string, unknown> });
      let result: { output: unknown; is_error?: boolean };
      try {
        result = await opts.execute(t.name, t.input as Record<string, unknown>);
      } catch (e) {
        result = {
          output: `Tool ${t.name} threw: ${e instanceof Error ? e.message : 'unknown'}`,
          is_error: true,
        };
      }
      tool_calls.push({
        name: t.name,
        input: t.input as Record<string, unknown>,
        output: result.output,
        is_error: result.is_error,
      });
      trace.push({
        role: 'tool_result',
        name: t.name,
        output: result.output,
        is_error: result.is_error,
      });
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: t.id,
        content:
          typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output, null, 2),
        is_error: result.is_error,
      });
    }

    // Feed tool results back as the next user message
    conversation.push({ role: 'user', content: toolResultBlocks });

    // If response.stop_reason === 'end_turn' the model isn't going to do
    // more — break to be safe
    if (response.stop_reason === 'end_turn') {
      finalReply = textBlocks.map((b) => b.text).join('\n').trim();
      if (finalReply) trace.push({ role: 'assistant', content: finalReply });
      break;
    }
  }

  // Fallback if we ran out of turns without a clean text reply
  if (!finalReply) {
    finalReply =
      'عذراً، حدث خطأ تقني. سيتواصل معك أحد فريقنا قريباً.\n' +
      "Sorry — a tech issue. A team member will reach out.";
    trace.push({ role: 'assistant', content: finalReply });
  }

  return {
    reply: finalReply,
    tool_calls,
    trace,
    usage: { input: totalIn, output: totalOut },
    model,
  };
}
