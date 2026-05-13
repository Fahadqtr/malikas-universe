'use client';

/**
 * MINIMAL login page — password only, no redirects, no magic link.
 * Diagnostic version: shows the Supabase URL it's hitting + full error.
 */
import { useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  // Show which Supabase URL we're hitting (diagnostic)
  const supabaseUrl =
    typeof window !== 'undefined' ? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '(not set)' : '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setErrorDetail(null);
    setLoading(true);

    try {
      const supabase = createBrowserSupabaseClient();
      console.log('[login] using supabase url:', supabaseUrl);

      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        console.error('[login] sign-in error:', signInError);
        setError(signInError.message);
        setErrorDetail(JSON.stringify(signInError, null, 2));
        setLoading(false);
        return;
      }

      console.log('[login] success, user:', data.user?.email);
      window.location.href = '/';
    } catch (e) {
      console.error('[login] caught error:', e);
      setError(e instanceof Error ? e.message : 'Unknown error');
      setErrorDetail(e instanceof Error ? (e.stack ?? null) : null);
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md bg-card border border-border rounded-lg p-6 space-y-4 shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Malika&apos;s Universe</h1>
          <p className="text-sm text-muted-foreground">Sign in (diagnostic mode)</p>
        </div>

        <div className="text-xs text-muted-foreground bg-muted/50 border border-border rounded-md p-2 break-all">
          <span className="font-medium">Supabase URL: </span>
          <code>{supabaseUrl}</code>
        </div>

        <div className="space-y-2">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="you@example.com"
            autoComplete="email"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            autoComplete="current-password"
          />
        </div>

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2 space-y-2">
            <div className="font-medium">{error}</div>
            {errorDetail && (
              <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-all opacity-80">
                {errorDetail}
              </pre>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>

        {/* Magic link button intentionally removed for diagnostic mode */}
      </form>
    </main>
  );
}
