'use client';

/**
 * Login page.
 *
 * Two modes on a single route:
 *   • sign-in    — email + password (default).
 *   • recovery   — reached from a Supabase password-reset link. The reset link
 *                  carries a recovery token in the URL hash; Supabase's browser
 *                  client turns it into a short-lived session and fires
 *                  `PASSWORD_RECOVERY`. In this mode we hide the sign-in form and
 *                  show "set a new password" instead.
 *
 * Security: only the anon key is used (browser client). No service-role, no admin
 * API. Errors are shown as safe generic messages — no raw error JSON, stack
 * traces, Supabase URL, or auth details are exposed.
 */
import { useEffect, useRef, useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';

type Mode = 'signin' | 'recovery';

const MIN_PASSWORD_LENGTH = 12;

/**
 * Only allow same-origin, absolute internal paths for post-login redirects.
 * Rejects external URLs, protocol-relative (`//host`), backslash tricks and
 * paths containing whitespace/newlines — falls back to "/".
 */
export function safeInternalPath(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (/\s/.test(raw)) return '/';
  return raw;
}

/** Validate a new password: length >= 12 and both entries match. */
export function validateNewPassword(pw: string, confirm: string): { ok: boolean; error?: string } {
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (pw !== confirm) {
    return { ok: false, error: 'Passwords do not match.' };
  }
  return { ok: true };
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const clientRef = useRef<ReturnType<typeof createBrowserSupabaseClient> | null>(null);

  // Build the browser client on load (not only on submit) so it can process the
  // recovery token in the URL and fire PASSWORD_RECOVERY.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    clientRef.current = supabase;

    // A recovery link lands with `type=recovery` in the URL hash.
    if (typeof window !== 'undefined' && window.location.hash.includes('type=recovery')) {
      setMode('recovery');
    }

    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setMode('recovery');
    });

    return () => data.subscription.unsubscribe();
  }, []);

  function getClient() {
    if (!clientRef.current) clientRef.current = createBrowserSupabaseClient();
    return clientRef.current;
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const { error: signInError } = await getClient().auth.signInWithPassword({ email, password });
      if (signInError) {
        setError('Email or password is incorrect.');
        setLoading(false);
        return;
      }
      const redirect =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('redirect')
          : null;
      window.location.href = safeInternalPath(redirect);
    } catch {
      setError('Something went wrong. Please try again.');
      setLoading(false);
    }
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const check = validateNewPassword(newPassword, confirmPassword);
    if (!check.ok) {
      setError(check.error ?? 'Invalid password.');
      return;
    }

    setLoading(true);
    try {
      const supabase = getClient();
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        setError('Could not update the password. The reset link may have expired — request a new one.');
        setLoading(false);
        return;
      }

      // Password changed — end the recovery session and clear the token from the URL.
      await supabase.auth.signOut();
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }

      setNewPassword('');
      setConfirmPassword('');
      setMode('signin');
      setNotice('Password updated successfully. Please sign in with your new password.');
      setLoading(false);
    } catch {
      setError('Something went wrong. Please try again.');
      setLoading(false);
    }
  }

  const inputClass =
    'w-full px-3 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-md bg-card border border-border rounded-lg p-6 space-y-4 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Malika&apos;s Universe</h1>
          <p className="text-sm text-muted-foreground">
            {mode === 'recovery' ? 'Set a new password' : 'Sign in'}
          </p>
        </div>

        {notice && (
          <div
            role="status"
            aria-live="polite"
            className="text-sm text-green-700 dark:text-green-300 bg-green-600/10 border border-green-600/20 rounded-md px-3 py-2"
          >
            {notice}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2"
          >
            {error}
          </div>
        )}

        {mode === 'recovery' ? (
          <form onSubmit={handleSetPassword} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="new-password" className="text-sm font-medium">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputClass}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">At least {MIN_PASSWORD_LENGTH} characters.</p>
            </div>

            <div className="space-y-2">
              <label htmlFor="confirm-password" className="text-sm font-medium">
                Confirm password
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputClass}
                autoComplete="new-password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {loading ? 'Updating…' : 'Set new password'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSignIn} className="space-y-4">
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
                className={inputClass}
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
                className={inputClass}
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
