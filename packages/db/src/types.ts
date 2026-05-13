/**
 * Database types — AUTO-GENERATED from Supabase.
 * Run: `pnpm db:types`
 *
 * Until first generation, this file exports a placeholder Database type
 * so the rest of the codebase compiles.
 */

export type Database = {
  public: {
    Tables: Record<string, { Row: unknown; Insert: unknown; Update: unknown }>;
    Views: Record<string, { Row: unknown }>;
    Functions: Record<string, unknown>;
    Enums: Record<string, unknown>;
  };
};

// After running `pnpm db:types`, this file is overwritten with real types.
