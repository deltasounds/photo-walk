# CLAUDE.md — photo-walk

## What this is

**City Photo Walk** is a facilitator's session runner for the two-hour city
photography workshop for beginner children. It turns the facilitator's guide
from a document you read beforehand into a tool you run the session from:
one card of copy at a time, a clock that knows where it is in the plan, and
the handful of saves a printout cannot make.

It is used **outdoors, while walking, one-handed, in daylight**, by someone
who is also watching children near traffic. Every design decision follows
from that.

## Read these first

- `content/plan.json` — the session timeline. The load-bearing file. Adding,
  removing, or reordering a mission happens here and nowhere else.
- `scripts/session.js` — content loading, the timeline flattening, and all
  session state. If you are changing behaviour, it is almost certainly here.

## Hard rules

- **Static site only.** Plain HTML, CSS, and JavaScript. No framework, no
  build step, no dependencies, no backend, no third-party scripts.
- **All state is local.** `localStorage` only. Nothing leaves the device.
- **No photo files in v1.** Shortlisting is by camera frame number plus a
  short note. Photographs of children do not go into this app, and adding
  upload or sharing is not a small change — it is a different product with
  consent, retention, and access questions attached. Raise it, do not build it.
- **Content is data the app renders**, never baked into templates or logic.
  Missions, theory, troubleshooting, and spoken copy all live in `content/`.
- **Nothing counts missions or assumes eight collection slots.** The
  collection is derived from whichever missions survive in the plan.
- **Every CSS value comes from `styles/tokens.css`.** If a value has no
  token, add the token. Do not hardcode.
- **Timing is derived from absolute timestamps, never a counter.** See below.

## The one architectural idea

The whole workshop is flattened into **one ordered array of steps**. A
segment with a rhythm contributes one step per phase; a segment without one
contributes a single step. After that flattening there is no nesting
anywhere: advancing is `index + 1`, and every screen is a function of
`steps[index]`.

Consequences to preserve:

- The 15-minute mission rhythm is defined **once**, in `plan.json`, and
  shared by all six missions. A 10- or 20-minute variant is a new rhythm
  entry, not new code.
- Theory phases are **generated** from the segment's `ref` array and share
  its minutes evenly. Adding a sixth concept needs no rhythm and no code.
- Dropping a mission mid-session rebuilds the timeline, so the current
  position is re-found by identity (segment + phase), never by index.

## Field constraints that are not negotiable

These exist because the alternative fails on a street corner, not because
they are tidy:

- **Absolute-time clocks.** Remaining is always
  `stepStartedAt + durationMs − Date.now()`. A `setInterval` countdown drifts
  under load and stops dead when iOS backgrounds the tab or the screen locks
  — which happens many times across two hours in a pocket.
- **Wake lock is re-acquired on every return to visibility.** The OS drops it
  whenever the tab hides. A lock that works once and then quietly stops is
  worse than none, because the facilitator has learned to trust it.
- **Persist on every state change and on `pagehide`.** An accidental reload
  ninety minutes in must not lose the session.
- **Phases auto-advance; segments never do.** Auto-advancing inside a mission
  keeps the rhythm without 36 taps a session. Auto-advancing into the *next
  mission* from a pocket is how a facilitator loses their place. Capture
  phases also always wait.
- **Minimum 56px touch targets**, not the 44px WCAG floor. The user is
  walking and not looking carefully.
- **Light theme only, declared.** The dominant context is bright daylight,
  where a dark UI is markedly harder to read.

## Working notes

- Greg drives. Propose, wait, then act. Keep steps small and say what you are
  about to do and why.
- `?fast=N` is rehearsal mode: every duration divided by N, stored under its
  own localStorage key so a dry run never leaves state the real session would
  offer to resume, and announced by a standing banner. `step.realMin` keeps
  the true scheduled length for the plan and overview lists.
- The service worker is **not** registered on plain localhost — it serves
  cache-first, which is right on a walk and wrong while editing. Use
  `?sw=1` to test offline behaviour on purpose.
- Repaint discipline: a full stage rebuild happens only on a step change or a
  structural edit. The tick loop touches three text nodes and one width.
  Text inputs write through to state without a repaint so the caret survives.
- Capture blocks are keyed `data-capture="<participant>:<slot>"` and replaced
  individually — with two children reading out frame numbers at once, a full
  repaint would clear the other one's half-typed entry.

## Do not

- Do not rewrite the workshop content. It comes from the facilitator's guide
  and is transcribed deliberately, including its exact spoken prompts.
- Do not add a build step, a framework, or a dependency without proposing it
  first and recording the reason in `README.md`.
- Do not introduce a composite "score", ranking, or any judgement of a child's
  photographs. The workshop is explicit that it uses "favourite", "most
  interesting", or "strongest experiment" — never "best".
- Do not add analytics or any network call.
