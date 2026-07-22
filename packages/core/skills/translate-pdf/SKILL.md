---
name: translate-pdf
description: Translate the PDF declared in interlinear.config.ts into per-page TSX components under pages/page-NNNN/index.tsx. Use when the user asks to "translate the PDF", "ingest the source document", "regenerate pages", or refers to a page that doesn't exist yet (e.g. "start work on page 240").
---

# Translate the source PDF into per-page TSX

interlinear has no LLM runtime of its own — translation work happens **inside
the user's Claude Code session**, orchestrated by this skill. Your job:
extract the source PDF, *optionally* build a glossary, dispatch parallel
sub-agents that each emit one `pages/page-NNNN/index.tsx`, then verify.

The interlinear viewer renders each page as **left pane = original PNG,
right pane = your TSX**. The reader's expectation is visual correspondence
between the two — same heading hierarchy, same table positions, code blocks
landing near where they do in the original. Everything in this skill exists
to make that alignment easy for the sub-agent to hit.

## 0. Where to put the output (read this first)

The framework hosts every PDF as a doc under `apps/demo/docs/<docId>/`.
The gitignore lets through exactly one committed doc — `apps/demo/docs/example/`
— and ignores everything else, so user content stays out of git by default.

Unless the user explicitly tells you otherwise:

- Generated pages go to `apps/demo/docs/<docId>/pages/page-NNNN/index.tsx`.
- Generated PNGs go to `apps/demo/docs/<docId>/public/page-NNNN.png`.
- The doc's `interlinear.config.ts` lives at
  `apps/demo/docs/<docId>/interlinear.config.ts`.
- Asset URLs inside the page TSX MUST be prefixed with `/<docId>/` — the
  dev server serves `/<docId>/<file>` from `apps/demo/docs/<docId>/public/<file>`.
  So a page-0001 component references the original as
  `originalSrc="/<docId>/page-0001.png"`, NOT `originalSrc="/page-0001.png"`.

The `<docId>` is the directory name under `apps/demo/docs/`. Pick it from
the user's request or the source PDF's slug. If `apps/demo/docs/<docId>/`
already exists, treat it as resumable — never overwrite existing pages
unless the user explicitly asks for a re-translate.

The workspace-level `apps/demo/interlinear.config.ts` is a different file
— it sets the dev port and the `docsDir`. Don't write per-PDF data there.

## 1. Read config

The doc's `interlinear.config.ts` lives at `apps/demo/docs/<docId>/interlinear.config.ts`.
Read these fields:

- `sourcePdf` — absolute or workspace-relative path to the source PDF (required).
- `locale` — target locale, e.g. `zh-Hant` (defaults to `zh-Hant`).
- `concurrency` — max sub-agent **batches** in flight at once. Defaults to **6**.
- `batchSize` — **pages per sub-agent batch**. Defaults to **10**. The
  sub-agent reads the static design-token template once and amortises it
  across every page in the batch — bigger batches mean less duplicated
  instruction overhead. Drop to 1 if you need fine-grained failure recovery.
- `glossary` — if `true`, run §4 before §6. Defaults to **false**.
- `pagesDir` — usually `pages`.

If `sourcePdf` is missing, stop and ask the user to set it.

If the doc directory exists but has no `interlinear.config.ts` yet
(brand-new doc), scaffold one. Default `glossary: true` for new
technical docs — the §4 front-load is cheap insurance against
cross-page terminology drift, and once `.interlinear/glossary.json`
exists the §4 guard prevents it from re-firing on later runs. Leave it
`false` for small docs (< ~20 pages), pure-prose docs, or follow-up
runs that only add a handful of pages to an already-translated doc.

## 2. Resolve the page range

- If the user named a range ("translate pages 240–260"), honor it.
- Otherwise, default to **every page that does not yet have
  `pages/page-NNNN/index.tsx`** — that's resumable behaviour.
- **Never overwrite an existing translated page** unless the user
  explicitly asks for a re-translate.

Use 4-digit zero-padded page ids: `page-0001`, `page-0002`, ….

For long ranges, use `TaskCreate` to make per-page progress visible to the
user — one task per page or per 10-page batch, whichever keeps the list
under ~40 items.

## 3. Extract per-page content (PyMuPDF helper)

Use the bundled extractor at `packages/core/src/extract/extract.py`
(invoke via `Bash`):

```
python3 packages/core/src/extract/extract.py \
  --pdf "<sourcePdf>" \
  --pages 1-10 \
  --out-png apps/demo/docs/<docId>/public \
  --out-json /tmp/interlinear-extract.json
```

The helper produces:

- `<out-png>/page-NNNN.png` — the rendered original page at 2× scale.
  These become the left pane of `<BilingualPage>`.
- `<out-json>` — JSON manifest. Each entry has:
  - `text` — flat positional text with `[[FIGURE_N]]` markers interleaved
    at the figure's vertical position.
  - `figures[]` — `{ marker, kind, bbox, xref?, pngPath? }`. The
    extractor detects both raster figures (embedded image xrefs) and
    vector figures (clustered drawing operators — block diagrams,
    schematics, timing diagrams). Each figure gets its own PNG, cropped
    from the page render at the figure's bbox so annotations, overlaid
    labels, and the text labels composing vector diagrams are all
    preserved. The PNG lands at `<out-png>/<pngPath>`. `kind` is
    `"raster"` or `"vector"`. `pngPath` is missing only when the crop
    fails (degenerate bbox) — rare; treat as a fallback (see §6.1).
  - `tables[]` — each `cells[]` already has `rowSpan` / `colSpan`
    resolved against detected gridlines.
  - `watermarkRemoved` — count of watermark lines filtered out.

**Do not strip watermarks from the source PDF**. The extractor filters
watermark *text* from the JSON, but the PNGs of original pages still
include the watermark — that's correct.

## 3.5 Hash and cache (resumability)

Before dispatching any sub-agent, hash each page's extracted JSON and
check whether it's already been translated under the **same** template
and glossary. This makes re-runs near-free.

Cache file: `apps/demo/docs/<docId>/.interlinear/translation-cache.json`.
Schema:

```json
{
  "version": 1,
  "templateHash": "<sha256 of page-template.md current contents>",
  "glossaryHash": "<sha256 of .interlinear/glossary.json, or empty string if absent>",
  "pages": {
    "page-0001": {
      "sourceHash": "<sha256 of JSON.stringify(pageJson)>",
      "writtenAt": "<ISO timestamp>"
    }
  }
}
```

### Pre-dispatch check

1. Read (or initialise empty) the cache file.
2. Compute `currentTemplateHash` over
   `packages/core/skills/translate-pdf/page-template.md`, and
   `currentGlossaryHash` over `.interlinear/glossary.json` (empty string
   if no glossary file).
3. If either differs from the cache's stored value, the design tokens or
   the canonical terminology have changed — **wipe `cache.pages`** so
   every page in the range is re-translated. Update both stored hashes.
4. For each `pageId` in the requested range:
   - Compute `sourceHash = sha256(JSON.stringify(pageJson))`.
   - If `apps/demo/docs/<docId>/pages/<pageId>/index.tsx` exists AND
     `cache.pages[pageId]?.sourceHash === sourceHash`, **skip** (it's
     up-to-date). Bookkeep it as "already done" in the report.
   - Otherwise, include the pageId in the dispatch queue.
5. If the dispatch queue is empty, tell the user "nothing to do — N pages
   already cached" and exit.

### Post-dispatch update

After each sub-agent batch finishes (see §6), for every page in that
batch whose `index.tsx` exists AND passes typecheck:

```js
cache.pages[pageId] = { sourceHash, writtenAt: new Date().toISOString() };
```

Persist the cache after each batch (not just at the end) so a crash mid-run
doesn't lose the resumability benefit.

The cache is purely orchestrator-managed; sub-agents never read or write
it. Hand-editing a page's TSX in the inspector does NOT invalidate the
cache — only re-extraction (changed pageJson), template changes, or
glossary changes do.

## 4. (Optional) Build the glossary

Run this step only when `config.glossary === true` **and**
`.interlinear/glossary.json` does not already exist (if it does, the
user has already curated one — use it as-is).

Spawn **one** sub-agent (`Agent`, `subagent_type: general-purpose`) with
the prompt in §4.1. The sub-agent reads ~8 representative pages from the
extracted JSON (first, last, and six spread across the middle) and writes
`.interlinear/glossary.json`. Schema:

```json
{
  "version": 1,
  "locale": "zh-Hant",
  "terms": [
    { "source": "register",       "target": "暫存器", "kind": "concept",  "policy": "translate" },
    { "source": "ioctl",          "target": "ioctl",  "kind": "function", "policy": "keep" },
    { "source": "frame buffer",   "target": "畫格緩衝區", "kind": "concept", "policy": "translate" }
  ]
}
```

**Then pause** and ask the user to review/edit the file. The glossary is
the single biggest lever on cross-page consistency, and the user is best
positioned to overrule the model on terminology that matters to them.
After the user confirms ("looks good" / "proceed"), continue to §5.

### 4.1 Glossary-builder prompt template

```
You are building the canonical terminology glossary for an in-progress PDF
translation in the `interlinear` IDE. Downstream per-page translators will
receive this file as a hard constraint, so cross-document consistency
depends on what you write here.

INPUT — extracted JSON for these pages (representative sample):
{ paste the page objects from /tmp/interlinear-extract.json }

TASK — produce 30–60 terms grouped into two policies:
  - policy: "keep"      — never translate. Use for: function/struct/macro
    names, register names, hex/numeric literals with units, acronyms
    (UART, SPI, ioctl, sysctl), product/chip names, file paths.
  - policy: "translate" — must always translate to the listed target.
    Use for: domain concepts with a stable target rendering
    ("register" → "暫存器", "interrupt handler" → "中斷處理常式",
    "frame buffer" → "畫格緩衝區").

LOCALE: {{locale}} (use Taiwan-flavoured terminology for zh-Hant,
mainland-flavoured for zh-CN — when in doubt, prefer 教育部 / 全國
科技名詞委員會 standard renderings).

OUTPUT — write `.interlinear/glossary.json` (create the dir if needed)
with the schema above. Rules:
  - For policy:"keep", set target = source (or omit target).
  - Alphabetise within each policy group; "keep" entries first, then
    "translate".
  - If you are not confident about a term, OMIT it. The user will add
    missing entries by hand. Wrong entries are worse than missing ones.
  - Do not include single-letter, single-digit, or trivially obvious
    terms ("the", "and", "page").

Do not write any other file. Do not call back. When done, report the
count and the path.
```

## 5. Dry-run one page

Before fanning out, translate **one** sample page end-to-end and confirm:

1. The file parses (`pnpm typecheck` — or at minimum, the TS plugin loads it).
2. The user is happy with the tone, terminology, and layout
   correspondence with the PNG.

Pick the earliest page in the range that has rich structure (mix of prose,
a code block, and/or a table). Dispatch a single sub-agent using §6.1's
prompt. Show the result to the user. Iterate the prompt or glossary if
they push back.

For a re-translation of an existing range, skip §5 — the user has already
seen the style.

## 6. Dispatch sub-agent batches

Group the dispatch queue (from §3.5) into contiguous batches of
`config.batchSize` (default **10**). For each batch, spawn ONE `Agent`
(`subagent_type: general-purpose`) with the §6.1 prompt — that sub-agent
translates every page in the batch and writes each as its own
`pages/page-NNNN/index.tsx`. Cap concurrent batches to
`config.concurrency` (default **6**).

The static design tokens / layout invariants / figure handling rules
live in `packages/core/skills/translate-pdf/page-template.md`. The
sub-agent reads that file ONCE at the start of its run and applies it
to every page in the batch — that's how we amortise the ~8KB of
formatting rules across 10 pages instead of repaying them every time.

Sub-agents **must not call back** to the parent — they hand off via
the filesystem by `Write`-ing each `index.tsx`.

### After each batch completes

1. For every `pageId` in the batch, verify
   `apps/demo/docs/<docId>/pages/<pageId>/index.tsx` exists.
2. Run `pnpm typecheck` (or just type-check the changed files). For each
   page that exists AND type-checks, write its `cache.pages[pageId]`
   entry (see §3.5) and persist the cache file.
3. For any page that is missing or fails typecheck, collect it into a
   "retry queue" and re-dispatch as a follow-up batch of just those
   pages (smaller batch is fine). Note the failure in the report.
4. Do NOT cache pages that failed — leaving them uncached means the
   next run will retry them automatically.

### 6.1 Per-batch sub-agent prompt template

Substitute every `{{…}}` placeholder. Send the block below verbatim;
no truncation, no paraphrase. The orchestrator computes
`{{templatePath}}` as the absolute path to
`packages/core/skills/translate-pdf/page-template.md` so the sub-agent
can `Read` it without ambiguity.

```
You are translating a batch of PDF pages into TSX components for the
`interlinear` post-editing IDE. Each page becomes ONE file.

## Step 1 — Read the template (do this FIRST)
Read this file in full before writing anything:
  {{templatePath}}

It contains the layout invariants, what-to-keep-verbatim rules, design
tokens (Tailwind classes), table formatting, figure handling — the same
rules apply to every page in this batch. Do not paraphrase or shortcut
its instructions.

## Batch context
docId: {{docId}}
locale: {{localeName}}
pages in this batch: {{pageIdList}}        ← e.g. page-0042, page-0043, …, page-0051
deliverable per page:
  apps/demo/docs/{{docId}}/pages/<pageId>/index.tsx

## Glossary (hard constraint, applies to every page in the batch)
The following canonical renderings MUST be obeyed across ALL pages.
If a source term matches a glossary "source", use the exact "target"
rendering (or KEEP verbatim for policy:"keep"). No paraphrasing,
no variation between pages.

{{glossarySubsetAsJson}}

(This subset was filtered to terms appearing in this batch's pages.
If you encounter a term not listed that you think warrants a glossary
entry, translate it consistently within the batch and mention it in
your final summary — don't edit `glossary.json`.)

## Per-page extracted JSON
The orchestrator passes one entry per pageId. For each, write the
corresponding `index.tsx` using the `Write` tool. Use the template
file's design tokens — no invented classes.

{{batchPagesJsonArray}}

## Output
Write one file per pageId. Do not write anything else. Do not edit
other pages. Do not call back.

When all files are written, reply with one line per page:
  page-NNNN: <N words>, <table count> tables, <figure count> figures

If a page is blank, watermark-only, or has under ~20 letters of real
content, still emit the file with a single empty paragraph and a JSX
comment noting why — never skip a pageId entirely (downstream code
expects every pageId in this batch to exist).
```

## 7. Validate

After all sub-agents finish (or after each batch, for a long run):

```bash
pnpm typecheck      # every page must parse and type-check
```

Then do a quick textual sanity scan across the emitted files:

- Every page imports `BilingualPage` from `interlinear`.
- Every page wraps content in `<BilingualPage originalSrc="/page-NNNN.png" …>`.
- No leftover `[[FIGURE_N]]` markers in the TSX (they should be replaced
  by `<figure>` blocks per §6.1).
- No "TODO" / "FIXME" / placeholder strings left in the JSX.

For any page that fails typecheck or fails the sanity scan, re-dispatch
**that single page** through §6 with the failure noted in the prompt.
Don't re-run the whole batch.

## 8. Report

One-line summary plus a short table:

```
N pages translated, M skipped (already existed), F failed → re-dispatched.

page-0240: 412 words, 1 table, 2 figures
page-0241: 280 words
page-0247: re-dispatched (typecheck: unterminated JSX)
…
```

If glossary was on (§4), note how many terms were used and remind the
user that they can edit `.interlinear/glossary.json` and re-run
`translate-pdf` on any page range to apply the updated terminology.

## Do not

- Do not re-translate pages that already have `index.tsx` unless asked.
- Do not strip the watermark from the source PDF. Filter it from
  extracted text only (the extractor already does this).
- Do not depend on internet access. Translation runs inside the user's
  Claude Code session, not an API.
- Do not call back to the parent from sub-agents. Hand off via the
  filesystem.
- Do not invent new Tailwind class strings. Stick to the design tokens
  in §6.1 — the inspector and `apply-comments` flow assume them.
- Do not skip the dry-run (§5) on a first-time translation. A single
  malformed prompt can poison 300 pages; spending one round-trip up
  front is the cheapest insurance you can buy.
