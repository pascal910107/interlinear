# interlinear

A post-editing IDE for AI translations of PDFs. Translate a document
page-by-page, then read and refine it side-by-side with the original.

The viewer renders each page as **left = original PDF image, right = the
translated page** (a React/TSX component), so you always see the source and
your translation in visual correspondence. There is no LLM runtime of its
own — translation and editing are driven by [Claude Code](https://claude.com/claude-code)
skills that run inside your own session.

## How it works

- Each source PDF becomes a *doc* under `apps/demo/docs/<docId>/`, with one
  `pages/page-NNNN/index.tsx` component and one `page-NNNN.png` per page.
- A Vite plugin scans those pages, serves the viewer, and exposes edit
  endpoints so changes save straight back to the TSX files.
- Doc content stays out of git by default (only `docs/example/` is committed).

## Quick start

```bash
pnpm install
pnpm dev        # builds core, then starts the demo viewer (default :5173)
```

Open the printed URL to browse the example doc.

## Publish a shareable reader

```bash
pnpm --filter @interlinear/demo build   # → apps/demo/dist/
```

Deploy `apps/demo/dist/` to any static host (Cloudflare Pages, Netlify,
GitHub Pages, S3+CDN) — there is **no backend or database**. The build:

- renders every page to static JS and copies each doc's `public/` images,
- emits a per-doc `search-index.json`, so the reader's full-text search
  (across both the translation and the original PDF text) runs entirely
  client-side.

The authoring tools (inline editing, DocChat) are dev-only and don't ship in
the static build. Cross-language search over the *original* text uses the
`.interlinear/original-text.json` cache — open search once under `pnpm dev`
(or run the text extractor) before building so that cache exists; without it
the published index still covers the translated text.

## Editing skills

Run these from a Claude Code session in this repo:

| Skill | What it does |
|-------|--------------|
| `translate-pdf`   | Translate the PDF in a doc's config into per-page TSX. |
| `apply-comments`  | Apply inline `@page-comment` markers left while reviewing. |
| `ask-doc`         | Answer document-level questions from the DocChat sidebar. |
| `refine-term`     | Rename a term consistently across every page's prose. |

## Layout

```
packages/core   framework: React runtime, Vite plugin, skills
apps/demo       the viewer app and doc workspace
```
