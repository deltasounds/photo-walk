# City Photo Walk

**Live: https://deltasounds.github.io/photo-walk/**

A facilitator's session runner for a two-hour city photography workshop for
beginner children, plus a 20-minute gallery session.

Deployed from `main` via GitHub Pages — pushing to `main` redeploys. Because
the service worker is cache-first, a change lands on the *second* load, not
the first.

It holds the whole schedule, shows one card of copy at a time, tracks which
photographs each child has shortlisted, and helps recover when the session
runs late.

## Running it

Any static file server. There is no build step.

```bash
python3 -m http.server 8412
```

Then open `http://localhost:8412`. On a phone, add it to the home screen so
it runs without browser chrome.

## Rehearsing it

The real session is 140 minutes, which is impractical to sit through when you
just want to check the flow. Add `?fast=N` to divide every duration by N:

| URL | Full session takes |
|---|---|
| `?fast=10` | ~14 minutes |
| `?fast=20` | ~7 minutes |
| `?fast=60` | ~2 minutes |

Rehearsal runs store their state under a **separate key**, so a dry run can
never leave a session behind that the real workshop offers to resume. A loud
banner stays on screen throughout — a compressed run that doesn't announce
itself is a trap on the morning of the workshop.

Durations are the only thing that changes. The rhythm, the drift arithmetic,
and the auto-advance rules behave exactly as they will on the day.

## What it does

- **Runs the clock.** A master session clock plus a phase clock, driven from
  the plan. Phases inside a mission advance themselves; moving to the next
  mission always waits for you.
- **Says the right thing at the right time.** The prompt to read aloud, the
  things to notice, the facilitator questions, the review prompt. The
  optional variation surfaces on its own at minute six of each shoot phase.
- **Absorbs schedule slip.** A drift chip shows how far behind or ahead you
  are. Past three minutes it offers the guide's own remedies: trim the
  sharing phases, absorb the overrun across remaining shooting time, or drop
  a whole mission rather than rush every remaining one.
- **Tracks shortlists.** During each mission's mark phase you record a frame
  number and a few words per child. Coverage gaps ("Sam has no candidate for
  Horizon") surface before the gallery session, while they can still be fixed.
- **Builds the collection.** Slot-by-slot selection, collection title,
  per-image titles, the closing reflection, and a plain-text manifest to hand
  to whoever runs the transfer.
- **Troubleshooting, one tap away.** The six situations from the guide, plus
  the facilitation questions, in a sheet that does not disturb the clock.

## Changing the workshop

`content/plan.json` is the only file that defines the session shape.

**To add a mission:** drop a file in `content/missions/`, add one line to
`segments`. It appears in the timeline, gets its own shortlist capture, and
adds a collection slot. No code changes.

**To drop a mission permanently:** remove its line. The collection becomes
seven images rather than breaking. (To drop one *during* a session, use the
schedule sheet.)

**To change the mission rhythm:** edit `rhythms.mission-15`. All six missions
share it. A different-length mission is a new rhythm entry.

Each mission is three screens — the brief, the shoot, and
review-choose-and-share. Beats that are only a line to say while everything
else continues (the four-minute warning, the optional variation, the
final-experiment nudge) are `cues` on the shoot phase instead of screens of
their own. Cue times are minutes **remaining**, so they stay true even when
a phase is shortened to recover the schedule.

**To add a theory card:** drop a file in `content/theory/`, add its id to the
theory segment's `ref` array. The ten minutes redistribute automatically.

Everything a facilitator says lives in `content/copy.json`.

## Decisions, and why

**Plain HTML/CSS/JS, no framework, no build step.** The app is a small state
machine plus content rendering. A framework would add a build step and a
dependency tree to something that has to load from a cold cache on a street
corner. It also has to be maintainable by someone returning to it a year
later before a workshop.

**No backend, no accounts, all state in `localStorage`.** This is a tool for
one person's phone during one session. A backend would add hosting, auth, and
a privacy surface for no gain.

**Shortlisting by frame number, not photo upload.** The cameras already hold
the photographs, and the guide already has children mark favourites in-camera.
What is missing at gallery time is knowing *which* frame and *why* — four
digits and a few words solve that, and depend on nothing working on the day.
It also means the app never holds photographs of children.

**Light theme only, declared via `color-scheme`.** The dominant context is
bright daylight, where a dark UI is markedly harder to read, and an OS
auto-darkening it would actively hurt.

**No webfont.** The system grotesque is instant, legible at large sizes, and
needs no file in the offline cache.

**Service worker not registered on localhost.** It serves cache-first, which
is correct on a walk and actively wrong while editing. Append `?sw=1` to test
offline behaviour deliberately.

## Structure

```
index.html            app shell and persistent chrome
styles/tokens.css     design tokens — every value comes from here
styles/app.css        app styles
scripts/clock.js      time, formatting, ticking, wake lock, cues
scripts/session.js    content loading, the timeline, session state
scripts/render.js     content → DOM
scripts/app.js        tick loop, event delegation, sheets
content/plan.json     the session timeline
content/missions/     one file per mission
content/theory/       one file per concept
content/copy.json     everything the facilitator says
content/troubleshooting.json
sw.js                 offline precache
```

## Not in this version

Photo import and visual galleries, participant-facing devices, larger-cohort
handling, route mapping. Each stays cheap to add because content is data and
the collection derives from the plan.
