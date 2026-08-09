/* =====================================================================
   render.js — content → DOM.

   Pure rendering. Nothing here reads the clock or mutates the session;
   it takes the current step plus session state and returns elements.
   Event wiring lives in app.js and works by delegation on data-action
   attributes, so re-rendering a stage never leaves listeners behind.

   The stage is rebuilt only when the step or the state changes. The
   ticking numbers (timer, drift, progress) are updated in place by
   app.js, because rebuilding the DOM four times a second would fight
   with any input the facilitator is typing.
   ===================================================================== */

/* ---------- Tiny DOM helper -------------------------------------------- */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('data-') || k === 'role' || k.startsWith('aria-')) {
      node.setAttribute(k, v);
    } else node[k] = v;
  }
  append(node, children);
  return node;
}

/**
 * Appends children, flattening nested arrays.
 *
 * Without the recursion, passing an array where a single child is
 * expected reaches `node.append(array)`, which stringifies it to
 * "[object HTMLQuoteElement],[object HTMLParagraphElement]" on screen
 * instead of failing loudly. Flattening makes that whole class of
 * mistake impossible rather than relying on every call site being careful.
 */
function append(node, child) {
  if (child == null || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) append(node, c);
    return;
  }
  node.append(typeof child === 'string' ? document.createTextNode(child) : child);
}

const frag = (kids) => {
  const f = document.createDocumentFragment();
  append(f, kids);
  return f;
};

/* ---------- Shared pieces ---------------------------------------------- */

const eyebrow = (text) => (text ? el('p', { class: 'eyebrow', text }) : null);

/**
 * Human label for a segment.
 *
 * Kept in one place because segment refs are not uniform: a mission ref
 * is a content id, a theory ref is an *array* of theory ids, and the
 * bookends are keys into copy.json. Every caller that needs a name — the
 * header, the overview, the setup plan, the look-ahead — goes through here.
 */
export function segmentLabel(session, step, { short = false } = {}) {
  const { copy, missions } = session.content;
  if (!step) return '';
  if (step.segmentType === 'mission') {
    const m = missions[step.segmentRef];
    if (!m) return step.segmentRef;
    /* Navigation names the *subject*, not the playful title. Scanning a
       list for "Macro & Texture" works; scanning it for "Secret
       Textures" means decoding six riddles. The evocative title still
       leads the mission screen — that is the line you say to a child. */
    const name = m.short_name ?? m.title;
    return short ? `${m.number}. ${name}` : `Mission ${m.number} · ${name}`;
  }
  const c = step.segmentType === 'theory' ? copy.theory : copy[step.segmentRef];
  if (!c) return step.segmentRef;
  /* Short titles keep the header bar and the forward button on one line
     without truncating; the full title still heads the screen itself. */
  return (short && c.short_title) ? c.short_title : c.title;
}

const bullets = (items, cls = 'bullets') =>
  items?.length ? el('ul', { class: cls }, items.map((t) => el('li', { text: t }))) : null;

/** The line the facilitator reads out. Visually the loudest thing on screen. */
const sayBlock = (text, label = 'Say') =>
  el('blockquote', { class: 'say' }, [
    el('p', { class: 'say-label', text: label }),
    el('p', { class: 'say-text', text }),
  ]);

const noteBlock = (text, kind = 'note') =>
  text ? el('p', { class: `note note-${kind}`, text }) : null;

const section = (title, ...kids) =>
  el('section', { class: 'block' }, [
    title ? el('h3', { class: 't-block', text: title }) : null,
    ...kids,
  ]);

/* The clock now lives in the header bar (see index.html) rather than in
   the stage. It was 71px against a 30px line of speech — two and a half
   times the size of the sentence the facilitator was there to read —
   and its block cost 116px at the top of every screen. Time is context
   for the content, not the content. */

/* ---------- Shortlist capture ------------------------------------------ */

/**
 * Frame-number capture for one collection slot.
 *
 * v1 stores no image files. The camera already holds the photographs and
 * the guide already has participants mark favourites in-camera; what is
 * missing at gallery time is knowing *which* frame and *why*. Four digits
 * and a few words solve that, and depend on nothing working on the day.
 */
/**
 * One participant's capture block.
 *
 * Rendered as an independently replaceable unit, keyed by
 * data-capture="<participant>:<slot>". When one child's mark is
 * submitted only their block is rebuilt, so the other child's
 * half-typed frame number survives — with two kids reading numbers out
 * at once, a repaint that clears the other field loses real work.
 */
export function captureRow(session, p, slotId) {
  const entries = session.shortlistFor(p.id, slotId);

  return el('div', { class: 'capture', 'data-capture': `${p.id}:${slotId}` }, [
    el('div', { class: 'capture-head' }, [
      el('p', { class: 'capture-name', text: p.name }),
      el('span', {
        class: `pip ${entries.length ? 'pip-good' : 'pip-empty'}`,
        text: entries.length ? `${entries.length} marked` : 'none yet',
      }),
    ]),
    entries.length
      ? el('ul', { class: 'entry-list' }, entries.map((e) =>
          el('li', { class: 'entry' }, [
            el('span', { class: 'entry-frame', text: e.frame || '—' }),
            el('span', { class: 'entry-note', text: e.note }),
            el('button', {
              type: 'button', class: 'icon-btn icon-btn-sm',
              'aria-label': `Remove ${e.frame || 'entry'}`,
              'data-action': 'shortlist-remove',
              'data-id': e.id, 'data-participant': p.id, 'data-slot': slotId,
            }, el('span', { 'aria-hidden': 'true', text: '✕' })),
          ])))
      : null,
    el('form', {
      class: 'capture-form', 'data-action': 'shortlist-add',
      'data-participant': p.id, 'data-slot': slotId,
    }, [
      el('input', {
        type: 'text', name: 'frame', class: 'in-frame', placeholder: 'Frame',
        inputMode: 'numeric', autocomplete: 'off', maxLength: 12,
        'aria-label': `Frame number for ${p.name}`,
      }),
      el('input', {
        type: 'text', name: 'note', class: 'in-note', placeholder: 'The idea',
        autocomplete: 'off', maxLength: 80,
        'aria-label': `Note for ${p.name}`,
      }),
      el('button', { type: 'submit', class: 'btn btn-secondary btn-sm', text: 'Mark' }),
    ]),
  ]);
}

export function captureBlock(session, slotId, slotLabel) {
  const { participants } = session.state;

  if (!participants.length) {
    return section('Shortlist',
      el('p', { class: 'hint', text: 'No participants were added at setup.' }));
  }

  return el('section', { class: 'block' }, [
    el('h3', { class: 't-block', text: `Shortlist — ${slotLabel}` }),
    el('p', { class: 'hint', text: 'Frame number from the camera, plus a few words on the idea.' }),
    ...participants.map((p) => captureRow(session, p, slotId)),
  ]);
}

/* ---------- Stage: welcome --------------------------------------------- */

function stageWelcome(session) {
  const c = session.content.copy.welcome;
  return frag([
    eyebrow('Welcome and camera setup'),
    el('h2', { class: 't-title', text: c.title }),
    sayBlock(c.opening_message, 'Opening message'),
    section('Check', bullets(c.checks, 'check-list')),
    section('Safety expectations', bullets(c.safety)),
    section('Opening assignment',
      sayBlock(c.assignment, 'Assignment'),
      noteBlock(c.assignment_note, 'quiet')),
    captureBlock(session, 'opening', c.slot_label),
  ]);
}

/* ---------- Stage: theory ---------------------------------------------- */

function stageTheory(session, step) {
  const t = session.content.theory[step.contentRef];
  if (!t) return el('p', { class: 'hint', text: `Missing theory card: ${step.contentRef}` });

  return frag([
    eyebrow(`Fundamentals · ${step.phaseIndex + 1} of ${step.phaseCount}`),
    el('h2', { class: 't-title', text: t.title }),
    t.basic_theory ? el('p', { class: 'lede', text: t.basic_theory }) : null,
    bullets(t.points),
    t.steps
      ? el('ol', { class: 'steps' }, t.steps.map((s) => el('li', { text: s })))
      : null,
    t.teaching_prompt ? sayBlock(t.teaching_prompt, 'Teaching prompt') : null,
    t.closing ? sayBlock(t.closing, 'Conclude with') : null,
    noteBlock(t.caution, 'warn'),
  ]);
}

/* ---------- Stage: mission --------------------------------------------- */

/**
 * `meta` carries the creative and technical focus — useful reference
 * while they photograph, but on the one-minute brief it costs three
 * lines and pushes the line you are about to read below the fold.
 */
function missionHead(m, { meta = true } = {}) {
  /* Number and subject here; the header bar and timer label carry the
     phase, so repeating that would cost two lines on the view that most
     needs to stay glanceable. */
  return frag([
    eyebrow(`Mission ${m.number} · ${m.short_name ?? ''}`.replace(/ · $/, '')),
    el('h2', { class: 't-title', text: m.title }),
    meta
      ? el('p', { class: 'meta' }, [
          el('span', { text: m.creative_focus }),
          el('span', { class: 'meta-sep', 'aria-hidden': 'true', text: '·' }),
          el('span', { text: m.technical_connection }),
        ])
      : null,
  ]);
}

const promptOptions = (m) =>
  m.prompt_options
    ? el('ul', { class: 'options' }, m.prompt_options.map((o) =>
        el('li', {}, [
          el('strong', { text: `${o.name}: ` }),
          el('span', { text: o.text }),
        ])))
    : null;

/** Collapsible block, shared by the restate-the-prompt and variation panels. */
function disclosure(label, body, { open, action }) {
  return el('section', { class: 'block disclosure' }, [
    el('button', {
      type: 'button', class: 'disclose', 'data-action': action,
      'aria-expanded': String(open),
    }, [
      el('span', { class: 'disclose-label', text: label }),
      el('span', { class: 'disclose-mark', 'aria-hidden': 'true', text: open ? '−' : '+' }),
    ]),
    el('div', { class: 'disclose-body', hidden: !open }, body),
  ]);
}

/** Held back until minute six, then revealed by the cue — or on demand. */
function variationBlock(m, revealed) {
  return disclosure('Optional variation',
    m.variation.map((v) => el('div', { class: 'variation-item' }, [
      v.condition ? el('p', { class: 'variation-cond', text: v.condition }) : null,
      el('p', { class: 'say-text say-text-sm', text: v.text }),
    ])),
    { open: revealed, action: 'toggle-variation' });
}

/**
 * Cues already delivered, kept on screen rather than flashed.
 *
 * The facilitator is usually looking at a child when one fires, so a
 * transient message is a message missed. They stack in the order they
 * came due, which also reads as a rough sense of how far through you are.
 */
function cueRail(cues) {
  const said = cues.filter((c) => c.type === 'say');
  if (!said.length) return null;
  return el('section', { class: 'block cues' }, said.map((c) =>
    el('p', { class: 'cue' }, [
      el('span', { class: 'cue-mark', 'aria-hidden': 'true', text: '▸' }),
      el('span', { text: c.text }),
    ])));
}

function stageMission(session, step, ui) {
  const m = session.content.missions[step.contentRef];
  if (!m) return el('p', { class: 'hint', text: `Missing mission: ${step.contentRef}` });

  const copy = session.content.copy;
  const head = missionHead(m);

  switch (step.phaseId) {
    /* The brief: one thing to read, and nothing else. Previously this
       carried the prompt AND the notice list, which made it a near-copy
       of the shoot screen that followed — two screens that look the same
       read as a bug, not as a rhythm. */
    case 'brief':
      return frag([missionHead(m, { meta: false }),
        el('div', { class: 'brief' }, [
          /* Prompt first. The lead-in is context for the facilitator and
             can follow; the sentence they say out loud leads. */
          sayBlock(m.prompt, 'Read this out'),
          promptOptions(m),
          m.lead_in ? noteBlock(m.lead_in, 'quiet') : null,
          m.safety_note ? noteBlock(m.safety_note, 'warn') : null,
        ]),
        el('p', { class: 'hint hint-center',
                  text: 'Then send them out. The next screen has the things to notice and the questions to ask.' }),
      ]);

    /* The working screen: the tools you use while they photograph. The
       prompt is here to restate, but collapsed, so it does not crowd out
       what is actually new. */
    case 'shoot': {
      const cues = session.firedCues();
      /* null means "follow the cue"; an explicit toggle wins after that,
         and the fired state survives a reload where a UI flag would not. */
      const variationOpen = ui.variationRevealed
        ?? cues.some((c) => c.type === 'show' && c.panel === 'variation');

      return frag([head,
        cueRail(cues),
        disclosure('Mission prompt',
          [sayBlock(m.prompt, 'Read this out'), promptOptions(m)],
          { open: ui.promptRevealed, action: 'toggle-prompt' }),
        m.notice ? section('Things to notice', bullets(m.notice, 'chips')) : null,
        variationBlock(m, variationOpen),
        section('Facilitator questions', bullets(m.questions)),
        m.technical_reminder ? section('Technical reminder', bullets(m.technical_reminder)) : null,
      ]);
    }

    /* Review, mark and regroup were three screens for one continuous
       activity: look at what you made, choose, show a partner, move on.
       The facilitator is circulating between children throughout, so
       flipping screens mid-flow cost more than it organised. */
    case 'review':
    default:
      /* No focus/technical line here — that is reference for making the
         photographs, not for choosing between them, and dropping it
         lifts the capture form into view without scrolling. */
      return frag([missionHead(m, { meta: false }),
        sayBlock(m.review_prompt, 'Review prompt'),
        m.review_extra ? noteBlock(m.review_extra, 'quiet') : null,
        captureBlock(session, step.segmentRef, m.slot_label),
        section('Then share',
          noteBlock(m.partner_activity ?? copy.facilitation.reminders[2], 'quiet')),
        el('div', { class: 'nextup' }, [
          el('p', { class: 'eyebrow', text: 'Before moving on' }),
          el('p', { class: 'nextup-title', text: 'Rotate partners.' }),
          nextUpLine(session, step),
        ]),
      ]);
  }
}

/** A short look ahead, so transitions do not need the overview screen. */
function nextUpLine(session, step) {
  const next = session.steps.find((s) => s.segmentIndex === step.segmentIndex + 1);
  if (!next) return null;
  return el('p', { class: 'nextup-next', text: `Next: ${segmentLabel(session, next)}` });
}

/* ---------- Stage: closing --------------------------------------------- */

function stageClosing(session) {
  const c = session.content.copy.closing;
  return frag([
    eyebrow('Return and closing photograph'),
    el('h2', { class: 't-title', text: c.title }),
    el('p', { class: 'lede', text: c.body }),
    sayBlock(c.assignment, 'Assignment'),
    noteBlock(c.question, 'quiet'),
    captureBlock(session, 'closing', c.slot_label),
  ]);
}

/* ---------- Stage: gallery --------------------------------------------- */

function stageGallery(session, step) {
  const g = session.content.copy.gallery;
  const phase = g.phases[step.phaseId];
  const head = frag([
    eyebrow(`Gallery · ${step.phaseIndex + 1} of ${step.phaseCount}`),
    el('h2', { class: 't-title', text: phase?.title ?? g.title }),
    phase?.body ? el('p', { class: 'lede', text: phase.body }) : null,
    bullets(phase?.items),
    noteBlock(phase?.note, 'quiet'),
  ]);

  if (step.phaseId === 'gather') {
    return frag([head, coverageBlock(session)]);
  }
  if (step.phaseId === 'select' || step.phaseId === 'sequence') {
    return frag([head, ...session.state.participants.map((p) =>
      collectionEditor(session, p, step.phaseId))]);
  }
  if (step.phaseId === 'exhibition') {
    return frag([head, ...session.state.participants.map((p) => collectionCard(session, p)),
      el('div', { class: 'block' }, [
        el('button', {
          type: 'button', class: 'btn btn-secondary btn-block',
          'data-action': 'export',
        }, 'Copy all collections as text'),
      ])]);
  }
  return head;
}

/** Who is missing a candidate, and for what. Shown before selection starts. */
function coverageBlock(session) {
  const gaps = session.coverageGaps();
  if (!session.state.participants.length) {
    return section('Coverage', el('p', { class: 'hint', text: 'No participants were added.' }));
  }
  if (!gaps.length) {
    return section('Coverage',
      el('p', { class: 'note note-good', text: 'Every participant has a candidate for every slot.' }));
  }
  return section('Gaps to fill',
    el('ul', { class: 'bullets' }, gaps.map((g) =>
      el('li', { text: `${g.participant.name} — ${g.slot.label}` }))));
}

function collectionEditor(session, p, phaseId) {
  const slots = session.slots();
  const c = session.state.collection[p.id] ?? { picks: {}, titles: {}, title: '', reflection: '' };

  const slotRows = slots.map((slot, i) => {
    const entries = session.shortlistFor(p.id, slot.id);
    const picked = c.picks[slot.id];
    return el('div', { class: 'slot' }, [
      el('p', { class: 'slot-label' }, [
        el('span', { class: 'slot-n', text: String(i + 1) }),
        el('span', { text: slot.label }),
      ]),
      entries.length
        ? el('div', { class: 'slot-choices' }, entries.map((e) =>
            el('button', {
              type: 'button',
              class: `choice ${picked === e.id ? 'choice-on' : ''}`,
              'data-action': 'pick', 'data-participant': p.id,
              'data-slot': slot.id, 'data-entry': e.id,
              'aria-pressed': String(picked === e.id),
            }, [
              el('span', { class: 'choice-frame', text: e.frame || '—' }),
              e.note ? el('span', { class: 'choice-note', text: e.note }) : null,
            ])))
        : el('p', { class: 'hint', text: 'No candidate marked during the walk.' }),
      phaseId === 'sequence' && picked
        ? el('input', {
            type: 'text', class: 'in-title', placeholder: 'Title for this image (optional)',
            value: c.titles[slot.id] ?? '', maxLength: 60,
            'aria-label': `Title for ${slot.label}`,
            'data-action': 'image-title', 'data-participant': p.id, 'data-slot': slot.id,
          })
        : null,
    ]);
  });

  return el('section', { class: 'block collection' }, [
    el('h3', { class: 't-block', text: p.name }),
    ...slotRows,
    phaseId === 'sequence'
      ? el('div', { class: 'collection-meta' }, [
          el('input', {
            type: 'text', class: 'in-title in-title-lg', placeholder: 'Title of the collection',
            value: c.title ?? '', maxLength: 60, 'aria-label': `Collection title for ${p.name}`,
            'data-action': 'collection-title', 'data-participant': p.id,
          }),
          el('label', { class: 'stem' }, [
            el('span', { class: 'stem-text', text: session.content.copy.gallery.reflection_stem }),
            el('textarea', {
              class: 'in-reflection', rows: 2, maxLength: 200,
              placeholder: '…', value: c.reflection ?? '',
              'aria-label': `Reflection for ${p.name}`,
              'data-action': 'reflection', 'data-participant': p.id,
            }),
          ]),
        ])
      : null,
  ]);
}

function collectionCard(session, p) {
  const slots = session.slots();
  const c = session.state.collection[p.id] ?? { picks: {}, titles: {} };
  const byId = Object.fromEntries(session.state.shortlist.map((e) => [e.id, e]));

  return el('section', { class: 'block card-final' }, [
    el('p', { class: 'eyebrow', text: p.name }),
    el('h3', { class: 't-block', text: c.title || 'Untitled collection' }),
    el('ol', { class: 'final-list' }, slots.map((s) => {
      const e = byId[c.picks[s.id]];
      return el('li', {}, [
        el('span', { class: 'final-slot', text: s.label }),
        el('span', { class: 'final-frame', text: e ? e.frame || '—' : 'not chosen' }),
        c.titles[s.id] ? el('span', { class: 'final-title', text: `“${c.titles[s.id]}”` }) : null,
      ]);
    })),
    c.reflection
      ? el('p', { class: 'final-reflection',
                  text: `${session.content.copy.gallery.reflection_stem} ${c.reflection}` })
      : null,
  ]);
}

/* ---------- Stage: done -------------------------------------------------- */

function stageDone(session) {
  const d = session.content.copy.done;
  return frag([
    eyebrow('Finished'),
    el('h2', { class: 't-title', text: d.title }),
    el('p', { class: 'lede', text: d.body }),
    ...session.state.participants.map((p) => collectionCard(session, p)),
    el('div', { class: 'block' }, [
      el('button', { type: 'button', class: 'btn btn-secondary btn-block', 'data-action': 'export' },
        'Copy all collections as text'),
    ]),
  ]);
}

/* ---------- Stage router -------------------------------------------------- */

function stageBody(session, step, ui) {
  switch (step.segmentType) {
    case 'welcome': return stageWelcome(session);
    case 'theory':  return stageTheory(session, step);
    case 'mission': return stageMission(session, step, ui);
    case 'closing': return stageClosing(session);
    case 'gallery': return stageGallery(session, step);
    default:        return el('p', { class: 'hint', text: `Unknown segment: ${step.segmentType}` });
  }
}

/** The stage is content only; the clock is chrome. */
export function renderStage(session, ui) {
  if (session.state.status === 'done') return stageDone(session);
  return el('div', { class: 'stage-body' }, [stageBody(session, session.step, ui)]);
}

/* ---------- Sheets --------------------------------------------------------- */

export function renderTroubleshooting(session) {
  const t = session.content.troubleshooting;
  const f = session.content.copy.facilitation;
  return frag([
    ...t.situations.map((s) =>
      el('details', { class: 'accordion' }, [
        el('summary', { text: s.situation }),
        el('div', { class: 'accordion-body' }, [
          s.intro ? el('p', { class: 'hint', text: s.intro }) : null,
          bullets(s.items),
          noteBlock(s.note, 'quiet'),
        ]),
      ])),
    el('details', { class: 'accordion' }, [
      el('summary', { text: f.title }),
      el('div', { class: 'accordion-body' }, [
        el('p', { class: 'hint', text: f.intro }),
        bullets(f.questions),
        bullets(f.reminders, 'bullets bullets-quiet'),
      ]),
    ]),
  ]);
}

export function renderOverview(session) {
  const cur = session.step;
  const seen = new Set();
  const rows = [];

  for (const s of session.steps) {
    if (seen.has(s.segmentIndex)) continue;
    seen.add(s.segmentIndex);
    const isCurrent = s.segmentIndex === cur.segmentIndex;
    const label = segmentLabel(session, s);
    const segSteps = session.steps.filter((x) => x.segmentIndex === s.segmentIndex);
    const mins = segSteps.reduce((a, x) => a + x.realMin, 0);

    rows.push(el('li', {}, [
      el('button', {
        type: 'button',
        class: `ov-row ${isCurrent ? 'ov-row-on' : ''}`,
        'data-action': 'jump', 'data-segment': String(s.segmentIndex),
      }, [
        el('span', { class: 'ov-label', text: label }),
        el('span', { class: 'ov-min', text: `${Math.round(mins)} min` }),
      ]),

      /* The phases of wherever you are, expanded in place. Jumping only
         to segment starts means the way to reach "mark favourites" after
         a detour is to sit through the whole rhythm again. */
      isCurrent && segSteps.length > 1
        ? el('ol', { class: 'ov-phases' }, segSteps.map((p) =>
            el('li', {}, [
              el('button', {
                type: 'button',
                class: `ov-phase ${p.index === cur.index ? 'ov-phase-on' : ''}`,
                'data-action': 'jump-step', 'data-step': String(p.index),
                'aria-current': p.index === cur.index ? 'step' : null,
              }, [
                el('span', { class: 'ov-label', text: p.phaseLabel ?? 'Main' }),
                el('span', { class: 'ov-min', text: `${p.realMin} min` }),
              ]),
            ])))
        : null,
    ]));
  }

  return frag([
    el('ol', { class: 'ov-list' }, rows),
    session.state.dropped.length
      ? el('p', { class: 'note note-quiet',
                  text: `Dropped: ${session.state.dropped.join(', ')}` })
      : null,
    el('div', { class: 'block' }, [
      el('label', { class: 'switch' }, [
        el('input', {
          type: 'checkbox', checked: session.state.settings.autoAdvance,
          'data-action': 'toggle-autoadvance',
        }),
        el('span', { text: 'Advance phases automatically' }),
      ]),
      el('p', { class: 'hint', text: session.state.settings.autoAdvance
        ? 'Phases move on by themselves when time runs out. Missions always wait for you.'
        : 'Nothing moves on by itself. A phase that runs over counts up in red until you advance it.' }),
    ]),
    el('div', { class: 'sheet-actions sheet-actions-stack' }, [
      el('button', { type: 'button', class: 'btn btn-secondary', 'data-action': 'schedule' },
        'Running late? Adjust the schedule'),
      el('button', { type: 'button', class: 'btn btn-quiet', 'data-action': 'reset' },
        'End and reset'),
    ]),
  ]);
}

export function renderDriftSheet(session) {
  const driftMin = Math.round(session.drift() / 60000);
  const missions = session.remainingMissions();

  return frag([
    el('p', { class: 'lede',
              text: driftMin > 0
                ? `You are about ${driftMin} minute${driftMin === 1 ? '' : 's'} behind the plan.`
                : driftMin < 0
                  ? `You are about ${Math.abs(driftMin)} minute${driftMin === -1 ? '' : 's'} ahead of the plan.`
                  : 'You are on time.' }),
    driftMin > 0
      ? el('p', { class: 'hint',
                  text: 'Protect photography time. Shorten sharing first, and drop a whole mission before rushing every remaining one.' })
      : null,
    el('div', { class: 'sheet-actions sheet-actions-stack' }, [
      el('button', { type: 'button', class: 'btn btn-secondary', 'data-action': 'trim-sharing' },
        'Trim remaining sharing to 2 min'),
      el('button', { type: 'button', class: 'btn btn-secondary', 'data-action': 'absorb' },
        'Absorb across remaining shoot time'),
    ]),
    missions.length
      ? section('Drop a mission',
          el('ul', { class: 'drop-list' }, missions.map((m) =>
            el('li', {}, [
              el('button', {
                type: 'button', class: 'ov-row', 'data-action': 'drop', 'data-ref': m.ref,
              }, [
                el('span', { class: 'ov-label', text: `Mission ${m.number} · ${m.title}` }),
                el('span', { class: 'ov-min', text: 'remove' }),
              ]),
            ]))))
      : null,
  ]);
}

/* ---------- Export --------------------------------------------------------- */

/** Plain-text manifest — hand to whoever runs the transfer. */
export function collectionsAsText(session) {
  const slots = session.slots();
  const byId = Object.fromEntries(session.state.shortlist.map((e) => [e.id, e]));
  const lines = [session.content.copy.session_title, ''];

  for (const p of session.state.participants) {
    const c = session.state.collection[p.id] ?? { picks: {}, titles: {} };
    lines.push(`${p.name} — “${c.title || 'Untitled collection'}”`);
    slots.forEach((s, i) => {
      const e = byId[c.picks[s.id]];
      const title = c.titles[s.id] ? ` — “${c.titles[s.id]}”` : '';
      const note = e?.note ? `  (${e.note})` : '';
      lines.push(`  ${i + 1}. ${s.label}: ${e ? e.frame || '—' : 'not chosen'}${title}${note}`);
    });
    if (c.reflection) {
      lines.push(`  ${session.content.copy.gallery.reflection_stem} ${c.reflection}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
