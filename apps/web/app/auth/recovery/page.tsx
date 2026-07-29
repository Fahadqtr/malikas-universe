'use client';

/**
 * Prefetch-safe password recovery landing page.
 *
 * Link format (fragment, NOT query — never reaches the server or link-scanners):
 *   https://malikas-universe.vercel.app/auth/recovery#token_hash=...&type=recovery
 *
 * On load we only READ the token from the hash, keep it in memory, and clear the
 * hash. We do NOT verify the token automatically (that is what Gmail's prefetch
 * abuses). Verification (`verifyOtp`) runs only when the user clicks
 * "Continue password reset". After verification the user sets a new password
 * via `updateUser`, and we sign out.
 *
 * Security: anon browser client only. No service-role, no admin API. The token
 * is never written to localStorage/sessionStorage/cookies or logged, and errors
 * are shown as safe generic messages.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import {
  parseRecoveryHash,
  isValidRecoveryParams,
  validateNewPassword,
  RECOVERY_ERRORS,
  MIN_RECOVERY_PASSWORD_LENGTH,
} from './recovery-logic';

type Stage = 'verify' | 'setPassword' | 'done';

export default function RecoveryPage() {
  const [stage, setStage] = useState<Stage>('verify');
  const [linkValid, setLinkValid] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tokenHashRef = useRef<string | null>(null);
  const clientRef = useRef<ReturnType<typeof createBrowserSupabaseClient> | null>(null);
  const busyRef = useRef(false);

  // On load: read the token from the fragment, keep it in memory, and clear the
  // hash immediately. NO verification happens here — only on an explicit click.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const { tokenHash, type } = parseRecoveryHash(window.location.hash);
    // Remove the token from the URL/history right away.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    if (isValidRecoveryParams(type, tokenHash)) {
      tokenHashRef.current = tokenHash;
      setLinkValid(true);
    } else {
      setLinkValid(false);
      setError(RECOVERY_ERRORS.invalidLink);
    }
  }, []);

  function getClient() {
    if (!clientRef.current) clientRef.current = createBrowserSupabaseClient();
    return clientRef.current;
  }

  async function handleContinue() {
    if (busyRef.current) return; // single-flight guard against double clicks
    const token = tokenHashRef.current;
    if (!token) {
      setError(RECOVERY_ERRORS.invalidLink);
      return;
    }
    busyRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const { error: verifyError } = await getClient().auth.verifyOtp({
        token_hash: token,
        type: 'recovery',
      });
      if (verifyError) {
        setError(RECOVERY_ERRORS.invalidLink);
        return;
      }
      setStage('setPassword');
    } catch {
      setError(RECOVERY_ERRORS.verifyFailed);
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;

    const check = validateNewPassword(newPassword, confirmPassword);
    if (!check.ok) {
      setError(check.error ?? 'Invalid password.');
      return;
    }

    busyRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const supabase = getClient();
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        setError(RECOVERY_ERRORS.updateFailed);
        return;
      }
      await supabase.auth.signOut();
      tokenHashRef.current = null;
      setNewPassword('');
      setConfirmPassword('');
      setNotice('Password updated successfully');
      setStage('done');
    } catch {
      setError(RECOVERY_ERRORS.updateFailed);
    } finally {
      busyRef.current = false;
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
          <p className="text-sm text-muted-foreground">Reset your password</p>
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

        {stage === 'done' ? (
          <Link
            href="/login"
            className="inline-flex w-full items-center justify-center bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Go to sign in
          </Link>
        ) : stage === 'setPassword' ? (
          <form onSubmit={handleSetPassword} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="new-password" className="text-sm font-medium">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                required
                minLength={MIN_RECOVERY_PASSWORD_LENGTH}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputClass}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                At least {MIN_RECOVERY_PASSWORD_LENGTH} characters.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="confirm-password" className="text-sm font-medium">
                Confirm password
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                minLength={MIN_RECOVERY_PASSWORD_LENGTH}
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
          // stage === 'verify'
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Click below to continue resetting your password.
            </p>
            <button
              type="button"
              onClick={handleContinue}
              disabled={loading || !linkValid}
              className="w-full bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {loading ? 'Verifying…' : 'Continue password reset'}
            </button>
            {!linkValid && (
              <Link href="/login" className="block text-center text-sm text-primary hover:underline">
                Back to sign in
              </Link>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
