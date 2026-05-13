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
