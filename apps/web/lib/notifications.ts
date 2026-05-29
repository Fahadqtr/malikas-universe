'use client';

/**
 * Notifications — toast + sound + browser Notification API.
 *
 * SOUND ARCHITECTURE
 * ──────────────────
 * Modern browsers (Chrome / Safari / Firefox) block audio until the user
 * makes an explicit gesture. AudioContext starts in 'suspended' state
 * and silently produces nothing until you call resume() from inside a
 * user-click handler. We MUST unlock it explicitly.
 *
 * State machine:
 *   disabled   default state (user hasn't enabled yet, never tried to play)
 *   enabled    AudioContext is running, sound will play
 *   blocked    we tried to enable + the browser refused (rare, e.g. policy)
 *
 * Persistence:
 *   • localStorage 'support.sound_enabled' = '1'  — re-attempt on next visit
 *   • localStorage 'support.sound_muted'   = '1'  — user-controlled silence
 *     (separate from enabled — you can be enabled but muted)
 *
 * Two play paths:
 *   1. PRIMARY: Web Audio API oscillator — short tonal beep, no external file
 *   2. FALLBACK: HTMLAudioElement with a pre-generated WAV blob URL
 *      (used when Web Audio creation/resume fails)
 *
 * Public API:
 *   enableSound()         — async, MUST be called from a user click. Returns 'enabled' | 'blocked'.
 *   getSoundState()       — sync, returns current state
 *   playSound(kind)       — fires a beep (no-op if disabled or muted)
 *   testSound()           — explicit test (fires regardless of mute)
 *   setSoundMuted(bool)   — user mute toggle
 *   isSoundMuted()
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ToastSeverity = 'info' | 'warning' | 'critical';

export type ToastInput = {
  title: string;
  body?: string;
  severity?: ToastSeverity;
  href?: string;
  duration_ms?: number;
};

export type Toast = ToastInput & {
  id: string;
  created_at: number;
  duration_ms: number;
};

export type SoundState = 'disabled' | 'enabled' | 'blocked';
export type SoundKind = 'message' | 'escalation' | 'critical';

// ─── Toast bus ──────────────────────────────────────────────────────────────

type Listener = (toasts: Toast[]) => void;

class ToastBus {
  private toasts: Toast[] = [];
  private listeners = new Set<Listener>();

  push(input: ToastInput): Toast {
    const t: Toast = {
      ...input,
      severity: input.severity ?? 'info',
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      created_at: Date.now(),
      duration_ms: input.duration_ms ?? (input.severity === 'critical' ? 0 : 6000),
    };
    this.toasts = [t, ...this.toasts].slice(0, 8);
    this.emit();
    if (t.duration_ms > 0) setTimeout(() => this.dismiss(t.id), t.duration_ms);
    return t;
  }
  dismiss(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }
  clear() {
    this.toasts = [];
    this.emit();
  }
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.toasts);
    return () => this.listeners.delete(l);
  }
  private emit() {
    for (const l of this.listeners) l(this.toasts);
  }
}

export const toastBus = new ToastBus();
export function toast(input: ToastInput): Toast {
  return toastBus.push(input);
}

// ─── Sound: module-level state ──────────────────────────────────────────────

const STATE_KEY = 'support.sound_enabled';
const MUTE_KEY = 'support.sound_muted';

let _ctx: AudioContext | null = null;
let _state: SoundState = 'disabled';
let _fallbackUrl: string | null = null;
const _stateListeners = new Set<(s: SoundState) => void>();

function emitState() {
  for (const l of _stateListeners) l(_state);
}

export function subscribeSoundState(cb: (s: SoundState) => void): () => void {
  _stateListeners.add(cb);
  cb(_state);
  return () => _stateListeners.delete(cb);
}

export function getSoundState(): SoundState {
  return _state;
}

export function isSoundMuted(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(MUTE_KEY) === '1';
}

export function setSoundMuted(muted: boolean) {
  if (typeof window === 'undefined') return;
  if (muted) localStorage.setItem(MUTE_KEY, '1');
  else localStorage.removeItem(MUTE_KEY);
}

// ─── Fallback WAV builder ───────────────────────────────────────────────────
// Generates a short 660Hz sine beep at 8kHz mono → Blob URL we can feed to
// an <audio> element. Built once on enable, reused for every fallback play.

function generateBeepWav(freq = 660, durMs = 160, sampleRate = 8000): Blob {
  const numSamples = Math.floor((sampleRate * durMs) / 1000);
  const bytesPerSample = 2;
  const dataBytes = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  function writeString(offset: number, s: string) {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  }

  // RIFF header
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);             // PCM fmt chunk size
  view.setUint16(20, 1, true);              // PCM format
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, sampleRate, true);     // sample rate
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true);             // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Samples — sine + simple envelope (attack + exp decay)
  const omega = 2 * Math.PI * freq;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t * 60);    // ~16ms attack
    const decay = Math.exp(-t * 7);        // fast decay
    const env = attack * decay * 0.5;
    const v = Math.sin(omega * t) * env;
    const int16 = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    view.setInt16(44 + i * bytesPerSample, int16, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function ensureFallbackUrl(): string | null {
  if (typeof window === 'undefined') return null;
  if (_fallbackUrl) return _fallbackUrl;
  try {
    _fallbackUrl = URL.createObjectURL(generateBeepWav());
    return _fallbackUrl;
  } catch {
    return null;
  }
}

// ─── enableSound — MUST be called from a user gesture ───────────────────────
// Creates AudioContext (some browsers create suspended by default), then
// calls resume() inside the same task as the click. Returns the resulting
// state for the caller to display.

export async function enableSound(): Promise<SoundState> {
  if (typeof window === 'undefined') return 'disabled';

  try {
    if (!_ctx) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        _state = 'blocked';
        emitState();
        return _state;
      }
      _ctx = new Ctx();
    }

    if (_ctx.state === 'suspended') {
      await _ctx.resume();
    }

    if (_ctx.state !== 'running') {
      _state = 'blocked';
      emitState();
      return _state;
    }

    // Build fallback now so first failure later doesn't drop the alert
    ensureFallbackUrl();

    // Play a short confirmation beep inside the same gesture (≈ 80ms)
    try {
      const osc = _ctx.createOscillator();
      const gain = _ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 660;
      osc.connect(gain);
      gain.connect(_ctx.destination);
      const now = _ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.13);
    } catch {
      // Web Audio synthesis failed inside the user gesture — fall back to HTMLAudio
      void playFallback();
    }

    _state = 'enabled';
    localStorage.setItem(STATE_KEY, '1');
    emitState();
    return _state;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[notifications] enableSound failed:', e);
    _state = 'blocked';
    emitState();
    return _state;
  }
}

/**
 * Auto-attempt re-enable on page load if user previously enabled.
 * Most browsers REQUIRE a fresh gesture per visit, but Safari/PWA on iOS
 * may persist the unlock — try cheaply and fall back to 'disabled' if not.
 */
export function tryRestoreSoundState() {
  if (typeof window === 'undefined') return;
  const wasEnabled = localStorage.getItem(STATE_KEY) === '1';
  if (!wasEnabled) {
    _state = 'disabled';
    emitState();
    return;
  }
  // Don't actually create the context here — we still need a fresh gesture.
  // But signal to the UI that the user "wants" it enabled so the button
  // shows "Enable sound (1-click)" prominently.
  _state = 'disabled';
  emitState();
}

// ─── playSound — the public entry ───────────────────────────────────────────

export function playSound(kind: SoundKind = 'message') {
  if (typeof window === 'undefined') return;
  if (_state !== 'enabled') return;
  if (isSoundMuted()) return;

  // Web Audio path
  if (_ctx && _ctx.state === 'running') {
    try {
      playWebAudio(_ctx, kind);
      return;
    } catch {
      // fall through
    }
  }

  // Fallback path
  void playFallback();
}

function playWebAudio(ctx: AudioContext, kind: SoundKind) {
  const cfg: Record<SoundKind, { freq: number; dur: number; beeps: number }> = {
    message: { freq: 660, dur: 0.13, beeps: 1 },
    escalation: { freq: 880, dur: 0.18, beeps: 2 },
    critical: { freq: 1100, dur: 0.22, beeps: 3 },
  };
  const { freq, dur, beeps } = cfg[kind];
  const now = ctx.currentTime;
  for (let i = 0; i < beeps; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const start = now + i * (dur + 0.08);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.3, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }
}

async function playFallback() {
  const url = ensureFallbackUrl();
  if (!url) return;
  try {
    const audio = new Audio(url);
    audio.volume = 0.5;
    await audio.play();
  } catch {
    // Browser blocked — flip state to 'blocked' so UI shows correct status
    if (_state === 'enabled') {
      _state = 'blocked';
      emitState();
    }
  }
}

// ─── Ringing loop — used for "incoming call" style alerts ───────────────────
// Plays a 2-beep pattern every 1.5s until stopped. Auto-times-out after 30s
// so a forgotten alert doesn't ring forever.

const RING_INTERVAL_MS = 1500;
const RING_MAX_DURATION_MS = 30000;

let _ringTimer: ReturnType<typeof setInterval> | null = null;
let _ringStopTimer: ReturnType<typeof setTimeout> | null = null;
let _ringActiveId: string | null = null;
const _ringListeners = new Set<(id: string | null) => void>();

function emitRing() {
  for (const l of _ringListeners) l(_ringActiveId);
}

/**
 * Subscribe to ring state changes. Used by the popup modal to know when
 * to show/hide itself.
 */
export function subscribeRingState(cb: (activeId: string | null) => void): () => void {
  _ringListeners.add(cb);
  cb(_ringActiveId);
  return () => _ringListeners.delete(cb);
}

export function isRinging(): boolean {
  return _ringActiveId !== null;
}

/**
 * Start the looping ring sound. Idempotent — if already ringing for the
 * same id, does nothing. Stops after 30s if not manually stopped.
 *
 * activeId: identifier (typically the conversation id) so the popup can
 *           match the ring to a single event.
 */
export function startRinging(activeId: string) {
  if (typeof window === 'undefined') return;
  // Don't ring if sound isn't unlocked or user has muted
  if (_state !== 'enabled' || isSoundMuted()) {
    // Still surface the popup — but visually only
    _ringActiveId = activeId;
    emitRing();
    return;
  }
  // Already ringing for this id — keep going
  if (_ringActiveId === activeId && _ringTimer) return;

  // Stop any previous ring first
  stopRingingInternal(false);

  _ringActiveId = activeId;
  emitRing();

  // First beep immediately, then every interval
  playRingPattern();
  _ringTimer = setInterval(() => playRingPattern(), RING_INTERVAL_MS);
  _ringStopTimer = setTimeout(() => stopRinging('timeout'), RING_MAX_DURATION_MS);
}

/**
 * Stop the ring. Called from popup Accept/Dismiss, or after timeout.
 */
export function stopRinging(_reason: 'accepted' | 'dismissed' | 'timeout' = 'accepted') {
  stopRingingInternal(true);
}

function stopRingingInternal(emit: boolean) {
  if (_ringTimer) {
    clearInterval(_ringTimer);
    _ringTimer = null;
  }
  if (_ringStopTimer) {
    clearTimeout(_ringStopTimer);
    _ringStopTimer = null;
  }
  if (_ringActiveId !== null) {
    _ringActiveId = null;
    if (emit) emitRing();
  }
}

function playRingPattern() {
  if (isSoundMuted() || _state !== 'enabled') return;
  // Two short beeps with a small gap — classic "incoming" cadence
  if (_ctx && _ctx.state === 'running') {
    try {
      const ctx = _ctx;
      const now = ctx.currentTime;
      const cfg = [
        { freq: 880, dur: 0.18, start: 0 },
        { freq: 880, dur: 0.18, start: 0.28 },
      ];
      for (const c of cfg) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = c.freq;
        osc.connect(gain);
        gain.connect(ctx.destination);
        const s = now + c.start;
        gain.gain.setValueAtTime(0.0001, s);
        gain.gain.exponentialRampToValueAtTime(0.35, s + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, s + c.dur);
        osc.start(s);
        osc.stop(s + c.dur + 0.02);
      }
      return;
    } catch {
      // fall through to HTMLAudio fallback
    }
  }
  void playFallback();
}

/** Explicit test — bypasses mute (user clicked Test Sound). */
export async function testSound() {
  if (typeof window === 'undefined') return;
  if (_state !== 'enabled') {
    // Try to enable on the fly
    const s = await enableSound();
    if (s !== 'enabled') return;
  }
  if (_ctx && _ctx.state === 'running') {
    try {
      playWebAudio(_ctx, 'message');
      return;
    } catch {
      // fall through
    }
  }
  void playFallback();
}

// ─── Browser Notification API ───────────────────────────────────────────────

export type BrowserNotifSetting = 'unknown' | 'granted' | 'denied' | 'default';

export function getBrowserNotifSetting(): BrowserNotifSetting {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unknown';
  return Notification.permission as BrowserNotifSetting;
}

export async function requestBrowserNotifPermission(): Promise<BrowserNotifSetting> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unknown';
  const result = await Notification.requestPermission();
  return result as BrowserNotifSetting;
}

export function showBrowserNotification(opts: {
  title: string;
  body?: string;
  href?: string;
  tag?: string;
}) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try {
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag, icon: '/favicon.ico' });
    if (opts.href) {
      n.onclick = () => {
        window.focus();
        window.location.href = opts.href!;
        n.close();
      };
    }
  } catch {
    // Constructor blocked by browser — fail silently
  }
}

// ─── Composite helper ───────────────────────────────────────────────────────

export function notify(opts: {
  title: string;
  body?: string;
  severity?: ToastSeverity;
  href?: string;
  sound?: SoundKind | null;
  browserTag?: string;
}) {
  toast({ title: opts.title, body: opts.body, severity: opts.severity, href: opts.href });
  if (opts.sound !== null) {
    playSound(opts.sound ?? (opts.severity === 'critical' ? 'critical' : 'message'));
  }
  showBrowserNotification({
    title: opts.title,
    body: opts.body,
    href: opts.href,
    tag: opts.browserTag,
  });
}

// ─── Title unread counter ───────────────────────────────────────────────────

let _originalTitle: string | null = null;

export function setUnreadInTitle(count: number) {
  if (typeof document === 'undefined') return;
  if (_originalTitle === null) {
    _originalTitle = document.title.replace(/^\(\d+\)\s*/, '');
  }
  document.title = count > 0 ? `(${count}) ${_originalTitle}` : _originalTitle!;
}
