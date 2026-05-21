---
name: translate-pdf
description: Translate the PDF declared in interlinear.config.ts into per-page TSX components under pages/page-NNNN/index.tsx. Use when the user asks to "translate the PDF", "ingest the source document", "regenerate pages", or refers to a page that doesn't exist yet (e.g. "start work on page 240").
---

# Translate the source PDF into per-page TSX

interlinear has no LLM runtime of its own — translation work happens **inside
the user's Claude Code session**, orchestrated by this skill. Your job:
extract the source PDF, dispatch translation, and emit one
`pages/page-NNNN/index.tsx` per source page. Each page wraps its content in
`<BilingualPage>` so the inspector loop (`apply-comments`, `refine-term`)
can iterate on the output.

## 1. Read config

`interlinear.config.ts` lives at the workspace root (or `apps/<app>/` in a
monorepo). Read these fields:

- `sourcePdf` — absolute path to the source PDF (required).
- `locale` — target locale, e.g. `zh-Hant` (defaults to `zh-Hant`).
- `engine` — `'translate-book'` (default, per D11) or `'subagent'`.
- `concurrency` — page-range parallelism for `engine: 'subagent'`. Defaults to **6**.
- `pagesDir` — usually `pages` (defaults to `pages`).

If `sourcePdf` is missing, stop and ask the user to set it.

## 2. Resolve the page range

- If the user asked for a specific range (e.g. "translate pages 240–260"),
  honor it.
- Otherwise, default to **every page that does not yet have
  `pages/page-NNNN/index.tsx`** — that's resumable behaviour.
- Skip pages whose `index.tsx` already exists. **Never overwrite an
  existing translated page** unless the user explicitly asks for a
  re-translate.

Use 4-digit zero-padded page ids: `page-0001`, `page-0002`, ….

## 3. Extract per-page content (PyMuPDF helper)

Use the bundled extractor at `packages/core/src/extract/extract.py`
(invoke via `Bash`):

```
python3 packages/core/src/extract/extract.py \
  --pdf "<sourcePdf>" \
  --pages 1-10 \
  --out-png apps/<app>/public \
  --out-json /tmp/interlinear-extract.json
```

The helper produces:

- `<out-png>/page-NNNN.png` — the rendered original page at 2× scale.
  These become the left pane of `<BilingualPage>`.
- `<out-json>` — JSON: `{ pages: [{ id, text, figures, tables, watermarkRemoved }, ...] }`.
  Each `tables[i].cells[]` already has `rowSpan` / `colSpan` resolved.

**Do not strip watermarks from the source PDF** (D5). The extractor
filters watermark *text* from the JSON, but the PNGs of original pages
still include the watermark — that's correct.

## 4. Translate

### Engine: `translate-book` (default, D11)

`deusyu/translate-book` is a Claude Code skill that does parallel
sub-agent translation with chunk hashing and resumable runs. If the user
has it installed locally, invoke it via the `Skill` tool with the
extracted JSON as input. Read its README for the exact arguments — do
not invent them.

If `translate-book` is not available on the user's machine, fall back to
the `subagent` engine.

### Engine: `subagent`

Translate in batches of ~10 pages, dispatched as parallel sub-agents (via
the `Agent` tool, `subagent_type: general-purpose`) up to `concurrency`
at a time.

Each sub-agent receives:

1. The extracted JSON for its page range.
2. The TSX page template (see §5 below) plus an example file
   (`apps/<app>/pages/page-0001/index.tsx` is a good reference once it
   exists).
3. Style notes: editorial tone, terminology consistency, code blocks
   preserved verbatim.

Each sub-agent's deliverable: one `pages/page-NNNN/index.tsx` per page in
its range, written directly via `Write`. Sub-agents must **not** call
back to the parent — they hand off via the filesystem.

## 5. Page TSX template

Every page exports a default React component that wraps content in
`<BilingualPage>`:

```tsx
import { BilingualPage } from '@interlinear/core';

export default function Page0240() {
  return (
    <BilingualPage
      originalSrc="/page-0240.png"
      pageLabel="page 240"
      footerLeft="240"
      footerCenter="第 X 章 …"
      footerRight="接續下一頁"
    >
      {/* translated content here */}
    </BilingualPage>
  );
}
```

Guidelines for the body:

- Headings: `<h1 className="font-display ...">` (large), `<h2>` (small).
- Body paragraphs: `<p className="mb-4 text-ink leading-relaxed">…</p>`.
- Inline code: `<code className="font-mono text-[12.5px] text-accent">…</code>`.
- Code blocks: `<pre className="font-mono text-[11.5px] px-3 py-2 mb-2 ..."><code>{...}</code></pre>` — store the code in a const so newlines survive JSX.
- Tables: use the `tables[i].cells[]` output from the extractor verbatim;
  emit `rowSpan` / `colSpan` exactly as the JSON says.
- Figures: insert `<figure>` with `<img src="/page-NNNN-figure-K.png" />`
  if the extractor saved per-figure images, or reference the parent page
  PNG via `originalSrc` when figures aren't separable.

## 6. Verify

After all pages have been written:

```bash
pnpm typecheck     # ensures every page parses + types check
pnpm dev           # user can browse and click into the inspector
```

If typecheck fails, fix the offending page (or, if multiple, return an
ordered fix list).

## 7. Report

Summarise:

- `N pages translated, M skipped (already existed), 0 failed`.
- One line per problematic page: `page-0247: table parse failed — see /tmp/interlinear-extract.json`.

## Do not

- Do not re-translate pages that already have `index.tsx`. Resumable
  behaviour is the contract.
- Do not strip the watermark from the source PDF (D5). Filter it from
  extracted text only.
- Do not depend on internet access. The translation engines run inside
  the user's Claude Code session, not an API.
- Do not call back to the parent agent from sub-agents. Hand off via the
  filesystem.
