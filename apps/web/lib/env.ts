/**
 * Type-safe environment variables.
 * Validates at startup. Crash early if anything is missing.
 *
 * Usage:
 *   import { env } from '@/lib/env';
 *   const url = env.NEXT_PUBLIC_SUPABASE_URL;
 */
import { z } from 'zod';

/**
 * Permissive URL: accepts a valid URL OR an empty/blank string.
 * Use for non-required URLs so missing services don't crash the app at boot.
 */
const optionalUrl = z
  .union([z.string().url(), z.literal(''), z.undefined()])
  .transform((v) => (v ? v : undefined))
  .optional();

const serverSchema = z.object({
  // Environment
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'staging', 'prod']).default('local'),
  APP_URL: optionalUrl,

  // Supabase — required (the app cannot run without DB)
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1).optional(), // not strictly needed by web app at runtime

  // R2 — optional in dev (image uploads will error gracefully if used)
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ENDPOINT: optionalUrl,

  // Anthropic — optional in dev (AI calls will error gracefully if used)
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL_HAIKU: z.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_MODEL_SONNET: z.string().default('claude-sonnet-4-6'),

  // Voyage (embeddings)
  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_MODEL: z.string().default('voyage-3'),

  // WhatsApp
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v20.0'),
  OWNER_WHATSAPP_NUMBER: z.string().optional(),

  // Redis (only required for image worker + WhatsApp queue)
  REDIS_URL: z.string().optional(),

  // Shopify
  SHOPIFY_SHOP_DOMAIN: z.string().optional(),
  SHOPIFY_ADMIN_TOKEN: z.string().optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),

  // Monitoring
  SENTRY_DSN: z.string().optional(),
  SLACK_ALERT_WEBHOOK: optionalUrl,

  // Dev flags
  SKIP_AUTH: z.string().optional().transform((v) => v === 'true'),
  MOCK_AI: z.string().optional().transform((v) => v === 'true'),
});

/**
 * Strip common mistakes from a Supabase project URL.
 * Users sometimes paste the REST endpoint (.../rest/v1) or include a trailing slash.
 * supabase-js expects only the project origin.
 */
function normalizeSupabaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')           // remove trailing slashes
    .replace(/\/rest\/v\d+$/, '')  // remove /rest/v1
    .replace(/\/auth\/v\d+$/, '')  // remove /auth/v1
    .replace(/\/realtime\/v\d+$/, '') // remove /realtime/v1
    .replace(/\/storage\/v\d+$/, ''); // remove /storage/v1
}

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1).transform(normalizeSupabaseUrl).pipe(z.string().url()),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_CDN_URL: optionalUrl,
});

/**
 * Parses process.env into a strongly-typed env object.
 * Throws if required vars are missing.
 */
function parseEnv() {
  const isServer = typeof window === 'undefined';

  const clientVars = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_CDN_URL: process.env.NEXT_PUBLIC_CDN_URL,
  };

  const client = clientSchema.parse(clientVars);

  if (!isServer) {
    return { ...client } as z.infer<typeof clientSchema> & Partial<z.infer<typeof serverSchema>>;
  }

  const server = serverSchema.parse(process.env);
  return { ...client, ...server };
}

export const env = parseEnv();
