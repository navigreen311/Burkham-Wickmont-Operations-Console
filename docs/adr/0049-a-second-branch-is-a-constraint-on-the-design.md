# ADR-0049 — A second branch is a constraint on the design

**Status:** accepted
**Date:** 2026-08-11
**Modules:** the Console transport and page

## Context

This slice was built alongside another one editing `apps/api/src/app.ts` and
`apps/api/public/index.html` in parallel, to be merged together. It owns four route files, four view
files and two test files, and may touch those two shared files only minimally.

That is a delivery constraint rather than an architectural one, and the honest thing is to say so:
nothing below is claimed to be the shape this code would take with one author. What follows is what
the constraint actually produced, because some of it turned out to be worth keeping and some of it
is a debt somebody should collect.

## Decision

**Four independent route modules and four independent view modules, each self-contained, composed by
the smallest possible edit to each shared file.**

### The transport: a context object, not a shared import

`app.ts` gains four imports and five lines. Each route module exports a registrar taking one
`ConsoleRouteContext` — the tenant, the clock, the session guard, and three helpers — and
`createApp` passes one object to all four.

The context is deliberately **not** the whole `createApp` scope. A route module that could reach the
rate limiter or the cookie helpers would be a route module able to change how authentication works,
and the point of splitting files is to make that impossible rather than merely unusual.

`ConsoleRouteContext` is declared **four times**, once per file. There is no fifth file to share it
from, and the four are structurally identical so TypeScript accepts one object for all of them. This
is the clearest debt in the slice and it should collapse into `routes/context.ts` the moment one
branch owns both.

### The page: sections inside the existing view, and nothing else

The four blocks go inside `<main id="view-overview">`. That is the whole of the integration: the
existing view switcher hides the overview when nobody is signed in, so the new blocks inherit that
and **no module here has to know anything about `console.js`** — a file this slice does not own,
which the other branch is editing.

The four `<script type="module">` tags sit inside the same block rather than in `<head>`, so the
edit to `index.html` is one contiguous hunk.

Each view module carries its own `call`, its own `list`, and its own `openable`. Duplicated four
times, for the same reason as the context type.

### What this ruled out, and why that is the interesting part

**A shared `views/common.js`** would have been the obvious move and would have been a fifth file.
More to the point it would have been a file both branches wanted to edit, which is the thing the
ownership split exists to avoid.

**Adding the surfaces to `console.js`'s `VIEWS` array and navigation** would have been the
consistent move — it is how the existing five views work. It would also have put this slice's edits
in the middle of the file the other branch is rewriting, which is where a merge conflict does the
most damage: not in the diff, but in the reviewer's ability to tell which branch meant what.

## Consequences

**The four surfaces are always visible on the overview rather than being separate views.** A real
cost: the overview is longer, and a person looking for "what needs me today" now scrolls past the
regulatory coverage map. The compensating argument is that the coverage map *is* what needs them
today — no state is active — so for now it belongs there on its merits.

**Nothing in this slice can break the existing page.** No shared JavaScript, no shared ids, no edit
to `console.js` or `api.js`. That is worth more during a parallel merge than the tidiness it costs.

**Three shared files, not two.** `apps/api/package.json` also needed five workspace dependencies, or
nothing would compile. It was not in the brief's list in either direction; the edit is five
alphabetical lines and it is flagged, because it is the third file where two branches can collide.

**The duplication is load-bearing until it is not.** Four copies of `call` will drift the first time
somebody changes one — that is not a hypothetical, it is what duplication does. The follow-up is one
commit and it should happen before a third batch lands.

## Alternatives considered

**Wait for the other branch and build on top.** Serialises two slices that share almost nothing, and
the shared surface is small enough that merging is cheaper than waiting.

**Put everything in `app.ts` as the existing surfaces do.** Maximum conflict on exactly the file that
is hardest to merge, and it would leave `app.ts` past two thousand lines — which CLAUDE.md already
names as a design defect: _"a file that cannot be rewritten in one pass"_.

**One route module and one view module for all five blueprint modules.** Fewer files and fewer
copies of the context type. It would also put 7.2's activation gate — the thing with the argument
attached — in the same file as the marketing asset list, and the file header is where that argument
lives.
