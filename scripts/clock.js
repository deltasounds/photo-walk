/* =====================================================================
   clock.js — time, formatting, ticking, and keeping the screen awake.

   One rule governs this file: every duration is derived from absolute
   timestamps, never accumulated by a counter. A `setInterval` that
   decrements a number drifts under load and stops entirely when iOS
   backgrounds the tab or the screen locks — both of which will happen
   many times across a two-hour walk with the phone in a pocket.

   The ticker here only decides *when to repaint*. What it paints is
   always recomputed as (start + duration) − Date.now(), so a tick that
   arrives late, or not at all, costs a stale pixel and never a wrong time.
   ===================================================================== */

export const MIN = 60_000;

export const now = () => Date.now();

/* ---------- Formatting ------------------------------------------------ */

/** "8:42", "1:04:11", and negative time as "−0:37" for overdue steps. */
export function formatClock(ms) {
  const neg = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const body = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
  return neg ? `−${body}` : body;
}

/** "2h 20m" — for plan totals, where hours read better than 140 min. */
export function formatDuration(ms) {
  const mins = Math.round(ms / MIN);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Whole minutes with an explicit sign: "+6 min", "−2 min", "on time". */
export function formatDrift(ms) {
  const mins = Math.round(ms / MIN);
  if (mins === 0) return 'on time';
  return mins > 0 ? `+${mins} min` : `−${Math.abs(mins)} min`;
}

/** "about four minutes left" — used for the spoken time cues. */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six',
               'seven', 'eight', 'nine', 'ten'];
export function minutesInWords(n) {
  return WORDS[n] ?? String(n);
}

/* ---------- Ticker ---------------------------------------------------- */

/**
 * Repaint driver. Fires roughly 4x a second while visible, and forces an
 * immediate tick when the tab becomes visible again so returning from a
 * locked screen never shows a stale countdown, even for one frame.
 */
export function createTicker(onTick, intervalMs = 250) {
  let id = null;

  const fire = () => onTick(now());

  const onVisibility = () => {
    if (document.visibilityState === 'visible') fire();
  };

  return {
    start() {
      if (id !== null) return;
      id = setInterval(fire, intervalMs);
      document.addEventListener('visibilitychange', onVisibility);
      fire();
    },
    stop() {
      if (id !== null) clearInterval(id);
      id = null;
      document.removeEventListener('visibilitychange', onVisibility);
    },
    fire,
  };
}

/* ---------- Wake lock -------------------------------------------------- */

/**
 * Holds a screen wake lock for the length of the session.
 *
 * The lock is dropped by the OS whenever the tab is hidden, so it has to
 * be re-acquired on every return to visibility — without that, the screen
 * stays awake exactly once and then quietly stops, which is worse than
 * not having it at all because the facilitator has learned to trust it.
 *
 * Unsupported browsers degrade silently; `supported` lets the UI say so.
 */
export function createWakeLock() {
  const supported = 'wakeLock' in navigator;
  let sentinel = null;
  let wanted = false;

  async function acquire() {
    if (!supported || !wanted || sentinel) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch {
      /* Denied (often low battery). Nothing to do but carry on. */
      sentinel = null;
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') acquire();
  };

  document.addEventListener('visibilitychange', onVisibility);

  return {
    supported,
    get active() { return sentinel !== null; },
    enable() { wanted = true; return acquire(); },
    async disable() {
      wanted = false;
      try { await sentinel?.release(); } catch { /* already gone */ }
      sentinel = null;
    },
  };
}

/* ---------- Cue (sound + haptics) -------------------------------------- */

/**
 * A short two-tone chime at phase changes, so the facilitator does not
 * have to watch the phone to know a phase ended.
 *
 * The AudioContext must be created and resumed inside a real user
 * gesture or mobile browsers will refuse to play anything later; `arm()`
 * is therefore called from the Start button, not at load.
 */
export function createCue() {
  let ctx = null;
  let armed = false;

  function arm() {
    if (armed) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    ctx.resume?.();
    armed = true;
  }

  function tone(freq, startAt, dur, gainPeak) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    /* Ramped, not switched — an abrupt gain change clicks audibly. */
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(gainPeak, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + dur + 0.02);
  }

  return {
    arm,
    get armed() { return armed; },
    /**
     * `kind` shapes the chime: 'phase' for an ordinary phase change,
     * 'segment' for a mission boundary (lower, two notes, more final),
     * 'nudge' for the optional-variation prompt (single soft note).
     */
    play(kind = 'phase') {
      if (!armed || !ctx) return;
      if (ctx.state === 'suspended') ctx.resume?.();
      const t = ctx.currentTime + 0.01;
      if (kind === 'segment') {
        tone(523.25, t, 0.18, 0.22);
        tone(783.99, t + 0.19, 0.30, 0.22);
      } else if (kind === 'nudge') {
        tone(880.0, t, 0.14, 0.12);
      } else {
        tone(659.25, t, 0.16, 0.18);
      }
    },
    buzz(pattern = [80]) {
      navigator.vibrate?.(pattern);
    },
  };
}
