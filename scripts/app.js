/* =====================================================================
   app.js — wiring.

   Holds the three things that are neither pure state nor pure markup:
   the tick loop, the event delegation, and the sheets.

   Repaint discipline matters here. A full stage rebuild happens only on
   a step change or a structural edit (a mark added, a pick made). The
   tick loop touches three text nodes and one width, and nothing else —
   otherwise typing a collection title while the clock ticks would lose
   the caret four times a second.
   ===================================================================== */

import {
  createTicker, createWakeLock, createCue, formatClock, formatDrift, formatDuration,
} from './clock.js';
import { loadContent, createSession, peekStored, clearStored } from './session.js';
import {
  renderStage, renderTroubleshooting, renderOverview, renderDriftSheet,
  collectionsAsText, segmentLabel, captureRow, el,
} from './render.js';

const $ = (sel) => document.querySelector(sel);

const screenSetup = $('#screen-setup');
const screenRun   = $('#screen-run');
const stage       = $('#stage');
const live        = $('#live');
const sheet       = $('#sheet');
const sheetTitle  = $('#sheet-title');
const sheetBody   = $('#sheet-body');

const DRIFT_ALERT_MS = 3 * 60_000;

/**
 * Rehearsal speed from `?fast=N` — every duration divided by N, so the
 * full 140-minute session can be walked end to end in a few minutes.
 *
 * Clamped rather than trusted, and surfaced as a standing banner: a
 * compressed run that is not obviously compressed is a trap on the day.
 */
const SPEED = (() => {
  const raw = Number(new URLSearchParams(location.search).get('fast'));
  if (!Number.isFinite(raw) || raw <= 1) return 1;
  return Math.min(600, Math.round(raw));
})();

let session = null;
let ticker  = null;
const wakeLock = createWakeLock();
const cue      = createCue();

/** Transient view state that is not worth persisting. */
let ui = { variationRevealed: null, promptRevealed: false, galleryParticipant: null };
let lastPaintedStep = -1;

/* ---------- Boot --------------------------------------------------------- */

async function boot() {
  let content;
  try {
    content = await loadContent();
  } catch (err) {
    stage.replaceChildren(el('p', { class: 'note note-warn',
      text: `Could not load workshop content. ${err.message}` }));
    showScreen('run');
    return;
  }

  session = createSession(content, { speed: SPEED });

  document.querySelector('[data-bind="session-title"]').textContent = content.plan.title;
  document.querySelector('[data-bind="session-subtitle"]').textContent = content.plan.subtitle ?? '';

  if (SPEED > 1) {
    const total = Math.round(session.totalMs / 60_000);
    $('#rehearsal').textContent =
      `Rehearsal — ${SPEED}× speed, whole session in about ${total} min. Not the real thing.`;
    $('#rehearsal').hidden = false;
    document.body.dataset.rehearsal = 'true';
  }

  buildSetupScreen();
  renderMissionPicker();
  syncSettingsInputs();
  renderParticipants();

  wireGlobalEvents();

  /* Before the resume check below: that path calls beginRun and returns,
     so a ticker created after it would never exist — the clock would
     paint once on rejoin and then sit frozen. */
  ticker = createTicker(tick);
  registerServiceWorker();

  const stored = peekStored(content, SPEED);

  /* A live session rejoins itself.
     iOS discards backgrounded tabs and reloads them on return, so a
     locked phone comes back to a cold start. Asking the facilitator to
     spot a notice and tap "resume" mid-walk is asking at the worst
     possible moment — if the session is running and recent, go straight
     back to where they were. Anything stale or finished still goes
     through setup, so yesterday's run is never mistaken for today's. */
  if (stored?.resumable && session.restore()) {
    syncSettingsInputs();
    renderParticipants();
    beginRun({ fresh: false, gesture: false });
    return;
  }

  /* Peek only. A stored session is not adopted until "Resume" is
     pressed, so anything typed on this screen belongs to a fresh run. */
  if (stored) {
    $('#resume-summary').textContent = describeStored(stored);
    $('#resume-note').hidden = false;
  }
}

/* ---------- Setup screen -------------------------------------------------- */

function buildSetupScreen() {
  const { copy } = session.content;

  $('#setup-checks').replaceChildren(
    ...copy.welcome.checks.map((t) => el('li', { text: t })),
  );

  const seen = new Set();
  const rows = [];
  for (const s of session.steps) {
    if (seen.has(s.segmentIndex)) continue;
    seen.add(s.segmentIndex);
    const label = segmentLabel(session, s);
    const mins = session.steps
      .filter((x) => x.segmentIndex === s.segmentIndex)
      .reduce((a, x) => a + x.realMin, 0);
    rows.push(el('li', {}, [
      el('span', { class: 'ov-label', text: label }),
      el('span', { class: 'ov-min', text: `${Math.round(mins)} min` }),
    ]));
  }
  $('#setup-plan').replaceChildren(...rows);
}

/**
 * The mission picker, with what the choice costs.
 *
 * The summary line is the point. Turning on four extra missions makes a
 * 2h20m session into 3h20m, and discovering that at minute ninety would
 * make this feature worse than not having it. Duration and collection
 * size update on every toggle.
 */
function renderMissionPicker() {
  const missions = session.allMissions();
  const active = missions.filter((m) => m.active).length;

  /* The arithmetic, not a fixed claim. There is no "two-hour workshop":
     there are the bookends plus fifteen minutes for every mission
     chosen, and showing the formula lets the facilitator plan the other
     way round — "I have two hours, so that is four missions". */
  const s = session.shape();
  $('#mission-summary').replaceChildren(
    el('p', { class: 'summary-total', text: formatDuration(s.totalMin * 60_000) }),
    el('p', { class: 'summary-line',
              text: `${s.missions} mission${s.missions === 1 ? '' : 's'} · `
                  + `collection of ${s.slots} image${s.slots === 1 ? '' : 's'}` }),
    /* Deliberately not enumerating the fixed parts — the fundamentals
       block can be switched off too, and a list that quietly went stale
       would undo the point of showing the sum at all. The breakdown
       lives in "Session plan" below. */
    el('p', { class: 'summary-sum',
              text: `${s.fixedMin}m around the missions `
                  + `+ ${s.missions} × ${s.perMissionMin}m` }),
  );

  $('#mission-picker').replaceChildren(...missions.map((m) => {
    const box = el('input', {
      type: 'checkbox', checked: m.active,
      'data-action': 'mission-toggle', 'data-ref': m.ref,
    });
    /* Two lines: what it teaches, and what the street has to provide.
       The evocative title ("City Geometry") is the line said to a child,
       not a selection criterion — it cannot help answer the only
       question being asked here, which is whether this fits today's
       route and light. It still leads the mission screen itself. */
    return el('li', { class: `pick ${m.active ? '' : 'pick-off'}` }, [
      el('label', { class: 'pick-label' }, [
        box,
        el('span', { class: 'pick-body' }, [
          el('span', { class: 'pick-name', text: m.short_name }),
          el('span', { class: 'pick-req', text: m.requires ?? '' }),
        ]),
        el('span', { class: 'pick-min', text: `${m.min}m` }),
      ]),
    ]);
  }));
}

/** "Mission 3 · Photograph and explore — Ada, Sam · 7 marked" */
function describeStored(stored) {
  const where = segmentLabel(session, stored.step);
  const who = stored.participants.length ? stored.participants.join(', ') : 'no participants';
  return `${where} — ${who} · ${stored.marks} marked`;
}

function renderParticipants() {
  const list = $('#participant-list');
  const { participants } = session.state;
  if (!participants.length) {
    list.replaceChildren(el('li', { class: 'hint', text: 'No participants yet.' }));
    return;
  }
  list.replaceChildren(...participants.map((p) =>
    el('li', { class: 'chip chip-person' }, [
      el('span', { text: p.name }),
      el('button', {
        type: 'button', class: 'chip-x', 'aria-label': `Remove ${p.name}`,
        'data-action': 'participant-remove', 'data-id': p.id,
      }, el('span', { 'aria-hidden': 'true', text: '✕' })),
    ])));
}

function syncSettingsInputs() {
  $('#opt-autoadvance').checked = session.state.settings.autoAdvance;
  $('#opt-sound').checked = session.state.settings.sound;
  $('#opt-wakelock').checked = Boolean(session.state.settings.wakeLock);
  $('#opt-fundamentals').checked = session.isSegmentActive('fundamentals');
}

/* ---------- Screens ------------------------------------------------------- */

function showScreen(name) {
  screenSetup.hidden = name !== 'setup';
  screenRun.hidden = name !== 'run';
}

async function beginRun({ fresh, gesture = true }) {
  /* The cue's AudioContext must be created inside a real user gesture or
     mobile browsers block every later sound. Starting by tapping "Start"
     qualifies; rejoining automatically after a reload does not, so in
     that case arm on whatever the facilitator touches next. */
  if (session.state.settings.sound) {
    if (gesture) cue.arm();
    else document.addEventListener('pointerdown', () => cue.arm(), { once: true });
  }
  if (fresh) session.start();
  if (session.state.settings.wakeLock) await wakeLock.enable();
  showScreen('run');
  onStepChange({ silent: true });
  ticker.start();
}

/* ---------- Tick ---------------------------------------------------------- */

function tick(t) {
  if (!session || session.state.status === 'idle') return;

  if (session.shouldAutoAdvance(t)) {
    session.advance();
    onStepChange();
    return;
  }

  const due = session.dueCues(t);
  if (due.length) {
    paint();
    signal('nudge', [40]);
    announce(due.map((c) => c.text ?? 'Optional variation available.').join(' '));
  }

  updateNumbers(t);
}

function updateNumbers(t) {
  const remaining = session.stepRemaining(t);
  const value = $('#timer-value');
  if (value) {
    value.textContent = formatClock(remaining);
    value.classList.toggle('is-over', remaining < 0);
  }

  const drift = session.drift(t);
  $('#bar-drift').textContent = session.state.status === 'paused'
    ? 'paused' : formatDrift(drift);
  $('#btn-pause').dataset.state = session.state.status === 'paused' ? 'paused'
                                : drift >= DRIFT_ALERT_MS ? 'late'
                                : drift <= -DRIFT_ALERT_MS ? 'ahead'
                                : 'ok';

  const pct = Math.max(0, Math.min(1, session.elapsed(t) / session.totalMs));
  $('#bar-progress-fill').style.width = `${(pct * 100).toFixed(2)}%`;
}

/* ---------- Painting ------------------------------------------------------ */

function paint() {
  stage.replaceChildren(renderStage(session, ui));
  updateChrome();
  updateNumbers(Date.now());
}

/** The clock is persistent chrome, so pausing never needs a repaint. */
function refreshTimer() {
  const paused = session.state.status === 'paused';
  $('#btn-pause').setAttribute('aria-label', paused ? 'Resume the timer' : 'Pause the timer');
  announce(paused ? 'Timer paused.' : 'Timer resumed.');
}

function updateChrome() {
  if (session.state.status === 'done') {
    $('#bar-segment').textContent = session.content.copy.done.title;
    $('#bar-phase').textContent = '';
    $('#btn-next').textContent = 'Done';
    $('#btn-next').disabled = true;
    $('#btn-back').disabled = false;
    return;
  }

  const step = session.step;

  $('#bar-segment').textContent = segmentLabel(session, step, { short: true });
  $('#bar-phase').textContent = step.phaseCount > 1
    ? `${step.phaseLabel ?? ''} · ${step.phaseIndex + 1}/${step.phaseCount}`
    : '';

  const next = $('#btn-next');
  next.disabled = false;
  if (session.isLastStep) {
    next.textContent = 'Finish';
  } else if (step.isLastPhase) {
    /* No "Start" prefix — it is the primary forward button, so the verb
       is understood, and the words saved keep the longest mission names
       on one line. */
    const upcoming = session.steps.find((s) => s.segmentIndex === step.segmentIndex + 1);
    next.textContent = `${segmentLabel(session, upcoming, { short: true })} →`;
  } else {
    next.textContent = 'Next →';
  }

  $('#btn-back').disabled = session.state.stepIndex === 0;
}

function onStepChange({ silent = false } = {}) {
  if (session.state.stepIndex !== lastPaintedStep) {
    ui.variationRevealed = null;   // null = follow the cue
    ui.promptRevealed = false;
    lastPaintedStep = session.state.stepIndex;
  }
  paint();
  stage.scrollTop = 0;

  if (silent) return;

  const step = session.step;
  const isSegmentStart = step.isFirstPhase;
  signal(isSegmentStart ? 'segment' : 'phase', isSegmentStart ? [70, 60, 70] : [60]);
  announce(`${$('#bar-segment').textContent}. ${step.phaseLabel ?? ''}`);
}

function signal(kind, pattern) {
  if (!session.state.settings.sound) return;
  cue.play(kind);
  cue.buzz(pattern);
}

function announce(text) {
  live.textContent = text;
}

/* ---------- Sheets -------------------------------------------------------- */

function openSheet(title, node) {
  sheetTitle.textContent = title;
  sheetBody.replaceChildren(node);
  sheet.hidden = false;
  $('#sheet-close').focus();
}

function closeSheet() {
  sheet.hidden = true;
  sheetBody.replaceChildren();
}

/* ---------- Events -------------------------------------------------------- */

function wireGlobalEvents() {
  /* --- setup screen --- */

  $('#participant-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#participant-name');
    if (session.addParticipant(input.value)) {
      input.value = '';
      renderParticipants();
    }
    input.focus();
  });

  $('#opt-autoadvance').addEventListener('change', (e) =>
    session.setSetting('autoAdvance', e.target.checked));
  $('#opt-sound').addEventListener('change', (e) =>
    session.setSetting('sound', e.target.checked));
  $('#opt-fundamentals').addEventListener('change', (e) => {
    session.setSegmentActive('fundamentals', e.target.checked);
    renderMissionPicker();
    buildSetupScreen();
  });
  $('#opt-wakelock').addEventListener('change', (e) => {
    session.setSetting('wakeLock', e.target.checked);
    if (e.target.checked) wakeLock.enable(); else wakeLock.disable();
  });

  $('#btn-start').addEventListener('click', () => {
    /* Starting fresh replaces whatever was stored. */
    clearStored(SPEED);
    $('#resume-note').hidden = true;
    beginRun({ fresh: true });
  });

  $('#btn-resume').addEventListener('click', () => {
    if (!session.restore()) return;
    if (session.state.status === 'paused') session.resume();
    syncSettingsInputs();
    renderParticipants();
    beginRun({ fresh: false });
  });

  $('#btn-discard').addEventListener('click', startFresh);

  /* --- run screen chrome --- */

  $('#btn-next').addEventListener('click', () => { session.advance(); onStepChange(); });
  $('#btn-back').addEventListener('click', () => { session.back(); onStepChange(); });

  $('#btn-help').addEventListener('click', () =>
    openSheet('Troubleshooting', renderTroubleshooting(session)));
  const openOverview = () => openSheet('Session', renderOverview(session, ui));
  $('#btn-overview').addEventListener('click', openOverview);
  $('#bar-jump').addEventListener('click', openOverview);
  $('#btn-pause').addEventListener('click', () => {
    if (session.state.status === 'paused') session.resume();
    else session.pause();
    refreshTimer();
    updateNumbers(Date.now());
  });

  $('#sheet-close').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) closeSheet();
  });

  /* --- delegated actions --- */

  document.addEventListener('click', onDelegatedClick);
  document.addEventListener('submit', onDelegatedSubmit);
  document.addEventListener('input', onDelegatedInput);

  /* Last-chance save. `pagehide` fires on iOS where `unload` does not. */
  window.addEventListener('pagehide', () => session.save());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') session.save();
  });
}

/**
 * Wipes the session and returns to setup, ready for a different group.
 * Also the path the setup screen's "start fresh" takes, so there is one
 * teardown rather than two that can drift apart.
 */
function startFresh() {
  session.reset();
  clearStored(SPEED);
  closeSheet();
  ticker.stop();
  wakeLock.disable();
  lastPaintedStep = -1;
  ui = { variationRevealed: null, promptRevealed: false,
         galleryParticipant: null, confirmingReset: false };
  buildSetupScreen();
  renderMissionPicker();
  renderParticipants();
  syncSettingsInputs();
  $('#resume-note').hidden = true;
  showScreen('setup');
  announce('Session cleared. Ready for a new group.');
}

function onDelegatedClick(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const { action } = target.dataset;

  switch (action) {
    case 'participant-remove':
      session.removeParticipant(target.dataset.id);
      renderParticipants();
      if (!sheet.hidden) openSheet('Session', renderOverview(session, ui));
      if (!screenRun.hidden) paint();
      break;

    /* Flip from what is actually rendered, since the variation panel may
       be open because its cue fired rather than because a flag was set. */
    case 'toggle-variation':
      ui.variationRevealed = target.getAttribute('aria-expanded') !== 'true';
      paint();
      break;

    case 'toggle-prompt':
      ui.promptRevealed = target.getAttribute('aria-expanded') !== 'true';
      paint();
      break;

    case 'shortlist-remove':
      session.removeShortlist(target.dataset.id);
      refreshCapture(target.dataset.participant, target.dataset.slot);
      break;

    case 'pick':
      session.setPick(target.dataset.participant, target.dataset.slot, target.dataset.entry);
      paint();
      break;

    case 'jump':
      session.jumpToSegment(Number(target.dataset.segment));
      closeSheet();
      onStepChange();
      break;

    case 'jump-step':
      session.jumpToStep(Number(target.dataset.step));
      closeSheet();
      onStepChange();
      break;

    case 'schedule':
      openSheet('Schedule', renderDriftSheet(session));
      break;

    /* Deliberately not reset between gallery phases: the facilitator
       works through one child across select, sequence and exhibition. */
    case 'gallery-participant':
      ui.galleryParticipant = target.dataset.id;
      paint();
      break;

    case 'reset-ask':
      ui.confirmingReset = true;
      openSheet('Session', renderOverview(session, ui));
      break;

    case 'reset-cancel':
      ui.confirmingReset = false;
      openSheet('Session', renderOverview(session, ui));
      break;

    case 'reset-confirm':
      startFresh();
      break;

    case 'trim-sharing':
      session.trimSharing(2);
      closeSheet();
      announce('Remaining sharing trimmed to two minutes.');
      paint();
      break;

    case 'absorb':
      session.absorbDrift();
      closeSheet();
      announce('Overrun absorbed across the remaining shooting time.');
      paint();
      break;

    case 'drop':
      session.dropMission(target.dataset.ref);
      closeSheet();
      announce('Mission removed from the session.');
      onStepChange({ silent: true });
      break;

    case 'export':
      exportCollections();
      break;

    default:
      break;
  }
}

function onDelegatedSubmit(e) {
  const roster = e.target.closest('[data-action="participant-add"]');
  if (roster) {
    e.preventDefault();
    /* Mid-session additions start from the slot in progress; at setup
       there is no current step, so they count from the beginning. */
    const fromSlotId = screenRun.hidden ? null : session.currentSlotId();
    if (session.addParticipant(roster.name.value, { fromSlotId })) {
      roster.name.value = '';
      renderParticipants();
      if (!sheet.hidden) openSheet('Session', renderOverview(session, ui));
      if (!screenRun.hidden) paint();
    }
    return;
  }

  const form = e.target.closest('[data-action="shortlist-add"]');
  if (!form) return;
  e.preventDefault();

  const { participant, slot } = form.dataset;
  if (!session.addShortlist(participant, slot, form.frame.value, form.note.value)) return;

  refreshCapture(participant, slot, { focus: true });
}

/**
 * Rebuilds a single participant's capture block in place, leaving every
 * other block — and anything typed into it — untouched.
 */
function refreshCapture(participantId, slotId, { focus = false } = {}) {
  const p = session.state.participants.find((x) => x.id === participantId);
  const node = document.querySelector(`[data-capture="${participantId}:${slotId}"]`);
  if (!p || !node) { paint(); return; }

  const fresh = captureRow(session, p, slotId);
  node.replaceWith(fresh);

  /* Facilitators usually enter two in a row, so put the caret back. */
  if (focus) fresh.querySelector('.in-frame')?.focus();
}

function onDelegatedInput(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const { action, participant, slot } = target.dataset;

  /* These write straight through without a repaint, so the caret stays put. */
  if (action === 'mission-toggle') {
    session.setMissionActive(target.dataset.ref, target.checked);
    renderMissionPicker();
    buildSetupScreen();
    return;
  }

  if (action === 'toggle-autoadvance') {
    session.setSetting('autoAdvance', target.checked);
    $('#opt-autoadvance').checked = target.checked;
    openSheet('Session', renderOverview(session, ui));
    return;
  }

  if (action === 'collection-title') session.setCollectionField(participant, 'title', target.value);
  else if (action === 'reflection')  session.setCollectionField(participant, 'reflection', target.value);
  else if (action === 'image-title') session.setImageTitle(participant, slot, target.value);
}

async function exportCollections() {
  const text = collectionsAsText(session);
  try {
    await navigator.clipboard.writeText(text);
    announce('Collections copied to the clipboard.');
    flashToast('Copied to clipboard');
  } catch {
    /* Clipboard blocked (insecure origin, or denied). Show it instead so
       the text is still recoverable by hand. */
    openSheet('Collections', el('pre', { class: 'export-text', text }));
  }
}

function flashToast(message) {
  const t = el('p', { class: 'toast', text: message });
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

/* ---------- Service worker ------------------------------------------------ */

/**
 * The offline cache is deliberately NOT registered on plain localhost.
 *
 * It serves cache-first, which is exactly right on a walk and exactly
 * wrong while editing — a stale bundle that survives reload is a very
 * expensive hour to debug. Append `?sw=1` to test the offline behaviour
 * locally on purpose.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const forced = new URLSearchParams(location.search).has('sw');
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!forced && (isLocal || location.protocol !== 'https:')) return;
  navigator.serviceWorker.register('sw.js').catch(() => {
    /* Offline support is an enhancement; the app runs without it. */
  });
}

boot();
