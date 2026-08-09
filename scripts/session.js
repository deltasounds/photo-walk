/* =====================================================================
   session.js — content loading, the timeline, and session state.

   The central idea: the whole workshop is flattened into ONE ordered
   array of steps. A segment with a rhythm contributes one step per
   phase; a segment without one contributes a single step. After that
   flattening there is no nesting anywhere else in the app — advancing
   is `index + 1`, and every screen is a function of `steps[index]`.

   Everything the plan can vary (which missions run, how long a rhythm
   is, how many theory cards there are) is absorbed here, so the render
   layer never counts missions or assumes eight collection slots.
   ===================================================================== */

import { MIN, now } from './clock.js';

const BASE_KEY = 'photo-walk:session:v1';
const STATE_VERSION = 1;

/**
 * Rehearsal runs are stored under their own key.
 *
 * A compressed dry run must never leave a session behind that the real
 * workshop then offers to resume — the whole point of rehearsing is to
 * arrive on the day with the app in a known state.
 */
export const storeKeyFor = (speed = 1) => (speed > 1 ? `${BASE_KEY}:rehearsal` : BASE_KEY);

/* ---------- Content loading -------------------------------------------- */

const getJSON = async (path) => {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json();
};

/**
 * Loads the plan, then loads exactly the mission and theory files the
 * plan references. Adding a mission is therefore a content-only change:
 * drop the file in, add the line to plan.json, and it loads itself.
 */
export async function loadContent(base = 'content') {
  const plan = await getJSON(`${base}/plan.json`);

  const missionRefs = plan.segments
    .filter((s) => s.type === 'mission')
    .map((s) => s.ref);

  const theoryRefs = plan.segments
    .filter((s) => s.type === 'theory')
    .flatMap((s) => (Array.isArray(s.ref) ? s.ref : [s.ref]));

  const [copy, troubleshooting, missionList, theoryList] = await Promise.all([
    getJSON(`${base}/copy.json`),
    getJSON(`${base}/troubleshooting.json`),
    Promise.all(missionRefs.map((r) => getJSON(`${base}/missions/${r}.json`))),
    Promise.all(theoryRefs.map((r) => getJSON(`${base}/theory/${r}.json`))),
  ]);

  const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));

  return {
    plan,
    copy,
    troubleshooting,
    missions: byId(missionList),
    theory: byId(theoryList),
  };
}

/* ---------- Timeline ---------------------------------------------------- */

/**
 * Phases for one segment.
 *
 * Theory is the special case: its phases are generated from the `ref`
 * array and share the segment's minutes evenly, so adding a fifth or
 * sixth concept later needs no rhythm and no code — they redistribute.
 */
function phasesFor(segment, plan, content) {
  if (segment.rhythm) {
    const rhythm = plan.rhythms[segment.rhythm];
    if (!rhythm) throw new Error(`Unknown rhythm "${segment.rhythm}"`);
    return rhythm.map((p) => ({ ...p, contentRef: segment.ref }));
  }

  if (segment.type === 'theory') {
    const refs = Array.isArray(segment.ref) ? segment.ref : [segment.ref];
    const each = segment.min / refs.length;
    return refs.map((ref) => ({
      id: ref,
      label: content.theory[ref]?.title ?? ref,
      min: each,
      contentRef: ref,
    }));
  }

  return [{ id: 'main', label: null, min: segment.min, contentRef: segment.ref }];
}

/**
 * Flattens plan segments into the linear step array.
 * `dropped` holds mission ids removed mid-session to recover time; they
 * vanish from the timeline and from the collection alike.
 */
export function buildTimeline(plan, content, dropped = [], speed = 1) {
  const steps = [];
  let offset = 0;
  let segmentIndex = 0;
  /* Rehearsal compresses every duration by the same factor, so the
     rhythm and the drift arithmetic stay proportionally identical to
     the real thing — only the wall clock shrinks. */
  const scale = (min) => Math.max(1000, Math.round((min * MIN) / speed));

  for (const segment of plan.segments) {
    if (segment.type === 'mission' && dropped.includes(segment.ref)) continue;

    const phases = phasesFor(segment, plan, content);

    phases.forEach((phase, i) => {
      const durationMs = scale(phase.min);
      steps.push({
        index: steps.length,
        segmentIndex,
        segmentType: segment.type,
        segmentRef: segment.ref,
        slot: segment.slot ?? null,
        rhythm: segment.rhythm ?? null,
        phaseId: phase.id,
        phaseLabel: phase.label ?? null,
        phaseIndex: i,
        phaseCount: phases.length,
        contentRef: phase.contentRef,
        durationMs,
        /* The real scheduled length, unaffected by rehearsal speed. The
           plan and overview lists describe the workshop's shape, so they
           show this rather than the compressed clock. */
        realMin: phase.min,
        plannedOffsetMs: offset,
        cueAtMs: phase.cueAt != null ? scale(phase.cueAt) : null,
        cue: phase.cue ?? null,
        capture: Boolean(phase.capture),
        isFirstPhase: i === 0,
        isLastPhase: i === phases.length - 1,
      });
      offset += durationMs;
    });

    segmentIndex += 1;
  }

  return steps;
}

/**
 * The collection slots, derived from whichever missions survive in the
 * plan — never hardcoded to eight. Drop a mission and the collection
 * becomes seven images rather than breaking.
 */
export function collectionSlots(plan, content, dropped = []) {
  const slots = [];
  for (const segment of plan.segments) {
    if (segment.slot === 'opening') {
      slots.push({ id: 'opening', kind: 'bookend',
                   label: content.copy.welcome.slot_label });
    } else if (segment.type === 'mission') {
      if (dropped.includes(segment.ref)) continue;
      const m = content.missions[segment.ref];
      slots.push({ id: segment.ref, kind: 'mission',
                   label: m.slot_label, title: m.title });
    } else if (segment.slot === 'closing') {
      slots.push({ id: 'closing', kind: 'bookend',
                   label: content.copy.closing.slot_label });
    }
  }
  return slots;
}

/* ---------- State ------------------------------------------------------- */

function blankState() {
  return {
    v: STATE_VERSION,
    status: 'idle',            // idle | running | paused | done
    startedAt: null,
    stepIndex: 0,
    stepStartedAt: null,
    pausedAt: null,
    lastSeenAt: null,
    totalPausedMs: 0,
    stepPausedMs: 0,
    participants: [],
    shortlist: [],             // { id, participantId, slotId, frame, note }
    collection: {},            // participantId → { title, reflection, picks, titles }
    dropped: [],
    firedCues: [],             // "stepIndex:cue" — so a cue fires once only
    /* Manual by default. Auto-advancing saves taps, but it takes the
       session out of the facilitator's hands at exactly the moments
       they are least able to look at a phone — mid-sentence with a
       child, or still walking to the next spot. The timer running over
       is information; being moved on without asking is a loss of control. */
    settings: { autoAdvance: false, sound: true },
  };
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function readStored(key) {
  let raw;
  try { raw = localStorage.getItem(key); } catch { return null; }
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    return saved?.v === STATE_VERSION ? saved : null;
  } catch {
    return null;
  }
}

export function clearStored(speed = 1) {
  try { localStorage.removeItem(storeKeyFor(speed)); } catch { /* nothing to clear */ }
}

/**
 * Looks at a stored session WITHOUT loading it.
 *
 * The setup screen has to know whether to offer "resume", but must not
 * adopt the stored participants and shortlist before the facilitator has
 * chosen — otherwise typing two names on top of a restored session
 * silently produces four participants and a shortlist from yesterday.
 */
/** Beyond this gap, a stored session is yesterday's, not a slept phone. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function peekStored(content, speed = 1) {
  const saved = readStored(storeKeyFor(speed));
  if (!saved || saved.status === 'idle') return null;

  const steps = buildTimeline(content.plan, content, saved.dropped ?? [], speed);
  const step = steps[Math.min(saved.stepIndex ?? 0, steps.length - 1)];
  const idleMs = saved.lastSeenAt ? Date.now() - saved.lastSeenAt : Infinity;

  return {
    status: saved.status,
    participants: (saved.participants ?? []).map((p) => p.name),
    marks: (saved.shortlist ?? []).length,
    step,
    idleMs,
    /* Live sessions rejoin themselves; anything older, or already
       finished, goes back through the setup screen so a stale run is
       never mistaken for the one you are about to lead. */
    resumable: (saved.status === 'running' || saved.status === 'paused')
               && idleMs < STALE_AFTER_MS,
  };
}

export function createSession(content, { speed = 1 } = {}) {
  const storeKey = storeKeyFor(speed);
  let state = blankState();
  let steps = buildTimeline(content.plan, content, state.dropped, speed);
  const listeners = new Set();

  const notify = () => { for (const fn of listeners) fn(api); };

  const persist = () => {
    try {
      /* Stamped on every write so a reload can tell "the phone slept for
         ten minutes" from "this is last week's session". */
      state.lastSeenAt = Date.now();
      localStorage.setItem(storeKey, JSON.stringify(state));
    } catch {
      /* Private mode or quota. The session still runs in memory. */
    }
  };

  const commit = () => { persist(); notify(); };

  const rebuild = () => { steps = buildTimeline(content.plan, content, state.dropped, speed); };

  /* ---- time ---------------------------------------------------------- */

  const pauseOffset = (t) => (state.status === 'paused' ? t - state.pausedAt : 0);

  const totalMs = () => steps.reduce((sum, s) => sum + s.durationMs, 0);

  const api = {
    /* ---- introspection ---- */
    get state() { return state; },
    get steps() { return steps; },
    get step() { return steps[Math.min(state.stepIndex, steps.length - 1)]; },
    get content() { return content; },
    get totalMs() { return totalMs(); },
    get isLastStep() { return state.stepIndex >= steps.length - 1; },

    slots() { return collectionSlots(content.plan, content, state.dropped); },

    /** Missions still in the plan, in order — used by the drop dialog. */
    remainingMissions() {
      const current = api.step;
      return steps
        .filter((s) => s.segmentType === 'mission'
                    && s.isFirstPhase
                    && s.segmentIndex > current.segmentIndex)
        .map((s) => ({ ref: s.segmentRef, ...content.missions[s.segmentRef] }));
    },

    /* ---- clocks ---- */

    elapsed(t = now()) {
      if (!state.startedAt) return 0;
      return t - state.startedAt - state.totalPausedMs - pauseOffset(t);
    },

    stepElapsed(t = now()) {
      if (!state.stepStartedAt) return 0;
      return t - state.stepStartedAt - state.stepPausedMs - pauseOffset(t);
    },

    stepRemaining(t = now()) {
      return api.step.durationMs - api.stepElapsed(t);
    },

    sessionRemaining(t = now()) {
      return totalMs() - api.elapsed(t);
    },

    /**
     * How far behind (positive) or ahead (negative) of the plan we are.
     *
     * Measured at the moment the current step *began* — elapsed minus
     * step-elapsed — rather than continuously, so the number is stable
     * while a step runs instead of ticking upward and alarming everyone.
     */
    drift(t = now()) {
      if (!state.startedAt) return 0;
      const atStepStart = api.elapsed(t) - api.stepElapsed(t);
      return atStepStart - api.step.plannedOffsetMs;
    },

    /**
     * Phases run themselves; segments do not.
     *
     * Auto-advancing inside a mission keeps the 15-minute rhythm without
     * 36 taps a session. Auto-advancing *across* a segment boundary is
     * refused: the group may still be walking to the next location, and
     * being marched into Mission 4 from a pocket is how a facilitator
     * loses their place. A capture phase also always waits, so nobody
     * gets skipped past entering their frame numbers.
     */
    shouldAutoAdvance(t = now()) {
      if (state.status !== 'running') return false;
      if (!state.settings.autoAdvance) return false;
      const s = api.step;
      if (s.capture || s.isLastPhase) return false;
      return api.stepRemaining(t) <= 0;
    },

    /** Cue fired at most once per step. Returns the cue name or null. */
    dueCue(t = now()) {
      const s = api.step;
      if (!s.cueAtMs || state.status !== 'running') return null;
      const key = `${s.index}:${s.cue}`;
      if (state.firedCues.includes(key)) return null;
      if (api.stepElapsed(t) < s.cueAtMs) return null;
      state.firedCues.push(key);
      persist();
      return s.cue;
    },

    /* ---- transitions ---- */

    start() {
      const t = now();
      state.status = 'running';
      state.startedAt = t;
      state.stepIndex = 0;
      state.stepStartedAt = t;
      state.totalPausedMs = 0;
      state.stepPausedMs = 0;
      commit();
    },

    advance() {
      if (state.stepIndex >= steps.length - 1) {
        state.status = 'done';
      } else {
        state.stepIndex += 1;
        state.stepStartedAt = now();
        state.stepPausedMs = 0;
      }
      commit();
    },

    back() {
      if (state.stepIndex === 0) return;
      state.stepIndex -= 1;
      state.stepStartedAt = now();
      state.stepPausedMs = 0;
      if (state.status === 'done') state.status = 'running';
      commit();
    },

    /** Jump to the first step of a segment — the timeline overview. */
    jumpToSegment(segmentIndex) {
      const target = steps.find((s) => s.segmentIndex === segmentIndex);
      if (target) api.jumpToStep(target.index);
    },

    /** Jump to an exact step, including a phase inside the current segment. */
    jumpToStep(index) {
      if (index < 0 || index >= steps.length) return;
      state.stepIndex = index;
      state.stepStartedAt = now();
      state.stepPausedMs = 0;
      if (state.status === 'done') state.status = 'running';
      commit();
    },

    pause() {
      if (state.status !== 'running') return;
      state.status = 'paused';
      state.pausedAt = now();
      commit();
    },

    resume() {
      if (state.status !== 'paused') return;
      const held = now() - state.pausedAt;
      state.totalPausedMs += held;
      state.stepPausedMs += held;
      state.pausedAt = null;
      state.status = 'running';
      commit();
    },

    /* ---- schedule recovery ---- */

    /**
     * Removes a mission from the rest of the session.
     *
     * The timeline is rebuilt, which renumbers every step after the cut,
     * so the current position is re-found by identity (segment + phase)
     * rather than by index — otherwise dropping Mission 5 while standing
     * in Mission 3 would silently teleport the facilitator forward.
     */
    dropMission(ref) {
      if (state.dropped.includes(ref)) return;

      const anchor = api.step;
      /* Segment order captured before the rebuild renumbers everything. */
      const order = [...new Set(steps.map((s) => s.segmentRef))];

      state.dropped.push(ref);
      rebuild();

      let target = steps.find(
        (s) => s.segmentRef === anchor.segmentRef && s.phaseId === anchor.phaseId,
      );

      if (!target) {
        /* The mission we were standing in is the one that went. Land at
           the *start* of the next surviving segment, not part-way through
           its rhythm — arriving in the middle of Mission 4's shoot phase
           with no prompt given is worse than the overrun we just fixed. */
        const from = order.indexOf(anchor.segmentRef);
        for (const nextRef of order.slice(from + 1)) {
          target = steps.find((s) => s.segmentRef === nextRef && s.isFirstPhase);
          if (target) break;
        }
        target ??= steps[steps.length - 1];
        state.stepStartedAt = now();
        state.stepPausedMs = 0;
      }

      state.stepIndex = target.index;
      commit();
    },

    get speed() { return speed; },

    /** Trim every remaining sharing phase to `min` minutes. */
    trimSharing(min = 2) {
      const cur = api.step;
      const target = Math.round((min * MIN) / speed);
      let changed = false;
      for (const s of steps) {
        if (s.index <= cur.index) continue;
        if (s.phaseId !== 'mark') continue;
        if (s.durationMs > target) { s.durationMs = target; changed = true; }
      }
      if (changed) { recomputeOffsets(); commit(); }
    },

    /** Spread an overrun across the remaining shoot phases. */
    absorbDrift(t = now()) {
      const over = api.drift(t);
      if (over <= 0) return;
      const cur = api.step;
      const shoots = steps.filter((s) => s.index > cur.index && s.phaseId === 'shoot');
      if (!shoots.length) return;
      /* Never cut a shoot phase below three minutes — past that the
         mission stops being a mission and becomes a walk-past. */
      const floor = Math.round((3 * MIN) / speed);
      const share = Math.floor(over / shoots.length);
      for (const s of shoots) {
        s.durationMs = Math.max(floor, s.durationMs - share);
      }
      recomputeOffsets();
      commit();
    },

    /* ---- participants ---- */

    addParticipant(name) {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const p = { id: uid(), name: trimmed };
      state.participants.push(p);
      state.collection[p.id] = { title: '', reflection: '', picks: {}, titles: {} };
      commit();
      return p;
    },

    removeParticipant(id) {
      state.participants = state.participants.filter((p) => p.id !== id);
      state.shortlist = state.shortlist.filter((e) => e.participantId !== id);
      delete state.collection[id];
      commit();
    },

    /* ---- shortlist ---- */

    addShortlist(participantId, slotId, frame, note = '') {
      const entry = {
        id: uid(),
        participantId,
        slotId,
        frame: frame.trim(),
        note: note.trim(),
      };
      if (!entry.frame && !entry.note) return null;
      state.shortlist.push(entry);
      commit();
      return entry;
    },

    updateShortlist(id, patch) {
      const e = state.shortlist.find((x) => x.id === id);
      if (!e) return;
      Object.assign(e, patch);
      commit();
    },

    removeShortlist(id) {
      state.shortlist = state.shortlist.filter((e) => e.id !== id);
      for (const c of Object.values(state.collection)) {
        for (const [slot, pick] of Object.entries(c.picks)) {
          if (pick === id) delete c.picks[slot];
        }
      }
      commit();
    },

    shortlistFor(participantId, slotId) {
      return state.shortlist.filter(
        (e) => e.participantId === participantId && e.slotId === slotId,
      );
    },

    /**
     * Which participant/slot pairs have no candidate yet.
     * Surfaced during the walk, while the gap can still be fixed —
     * discovering it in the gallery session is discovering it too late.
     */
    coverageGaps(upToSlotId = null) {
      const slots = api.slots();
      const limit = upToSlotId
        ? slots.findIndex((s) => s.id === upToSlotId)
        : slots.length - 1;
      const gaps = [];
      for (const p of state.participants) {
        for (const slot of slots.slice(0, limit + 1)) {
          if (!api.shortlistFor(p.id, slot.id).length) {
            gaps.push({ participant: p, slot });
          }
        }
      }
      return gaps;
    },

    /* ---- collection ---- */

    setPick(participantId, slotId, entryId) {
      const c = state.collection[participantId];
      if (!c) return;
      if (entryId) c.picks[slotId] = entryId;
      else delete c.picks[slotId];
      commit();
    },

    setCollectionField(participantId, field, value) {
      const c = state.collection[participantId];
      if (!c) return;
      c[field] = value;
      commit();
    },

    setImageTitle(participantId, slotId, title) {
      const c = state.collection[participantId];
      if (!c) return;
      if (title) c.titles[slotId] = title;
      else delete c.titles[slotId];
      commit();
    },

    /* ---- settings & lifecycle ---- */

    setSetting(key, value) {
      state.settings[key] = value;
      commit();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    save: persist,

    /** Adopts the stored session. Returns true if one was found. */
    restore() {
      const saved = readStored(storeKey);
      if (!saved) return false;
      state = { ...blankState(), ...saved };
      rebuild();
      state.stepIndex = Math.min(state.stepIndex, steps.length - 1);
      notify();
      return state.status !== 'idle';
    },

    reset() {
      state = blankState();
      rebuild();
      clearStored(speed);
      notify();
    },
  };

  /** Re-derives planned offsets after any duration edit. */
  function recomputeOffsets() {
    let offset = 0;
    for (const s of steps) {
      s.plannedOffsetMs = offset;
      offset += s.durationMs;
    }
  }

  return api;
}
