# Page template — interlinear translation reference

You're a translation sub-agent dispatched by the `translate-pdf` skill.
The orchestrator's prompt points you at this file as your single source
of truth for layout invariants, what to keep verbatim, design tokens,
and figure handling. **Read this end-to-end before writing any page.**

The rules here are the same for every page in every batch — the
orchestrator does not re-paste them, so do not assume your prompt
contains them.

---

## Layout invariant (read this first)

The output renders inside `<BilingualPage>`:

- Left pane:  the original PNG at `/<docId>/page-<NNNN>.png` (2× scale).
- Right pane: the TSX content you author here.

The reader expects visual correspondence between the two panes:

- Section headings appear in the same order and at the same level.
- Tables, code blocks, blockquotes, and figures land near where they
  do in the original.
- Paragraph breaks roughly match — do not merge two source paragraphs
  into one, or split one into many.

This is the single most important constraint. When in doubt, prioritise
visual alignment over prose elegance.

## What to translate

- Body prose → target locale.
- Section headings → target locale.
- Table header cells and label-style data cells → target locale.

## What to KEEP VERBATIM (do NOT translate, do NOT transliterate)

- Anything inside `<pre>` or `<code>` — every line, including LEADING
  indentation. A line that starts with 4 spaces or a tab in the source
  must start with the same 4 spaces or tab in your output. Continuation
  lines, nested blocks, and blank lines inside a code listing all stay
  exactly as they were.
- Identifiers: function names, type names, struct/macro names,
  field names, enum values.
- Register names, hex values, numeric literals, units (ms, MHz, V, KB).
- Product/chip names, model numbers (e.g. MCU, ARM, USB, Cortex-M).
- Acronyms: UART, SPI, I2C, DMA, ioctl, sysctl, MMIO, IRQ, …
- File paths, command lines, env-var names.
- `[[FIGURE_N]]` markers — see "Figure handling" below.

## Glossary

The orchestrator passes a glossary subset in your prompt under
`## Glossary (hard constraint)`. If a term in the source matches a
glossary `source`, the translation MUST use the exact `target` string
(or KEEP the source verbatim for `policy:"keep"`). No paraphrasing.
No variation across pages.

If a term not in the glossary deserves to be one, just translate it
consistently within the batch and mention it in your final summary —
don't edit `glossary.json` yourself.

## Design tokens (use these EXACT class strings)

The structural template lives at
`apps/demo/docs/example/pages/page-0001/index.tsx` — imports,
constants, `<BilingualPage>` wrapping, typography classes. Mirror that
file's shape; the classes below are the only ones you should use.

### Wrapper

```tsx
import { BilingualPage } from '@interlinear/core';

<BilingualPage
  originalSrc="/<docId>/page-<NNNN>.png"
  pageLabel="page <N>"
  footerLeft="<N>"
  footerCenter="<section or chapter title from the running footer>"
  footerRight="<page label in target locale, e.g. 頁 N>"
>
  {/* translated content here */}
</BilingualPage>
```

### H1 (chapter / section number)

```tsx
<h1 className="font-display text-[24px] font-semibold tracking-[-0.005em] mt-2 mb-3 text-ink">
  …
</h1>
```

### H2 (sub-section)

```tsx
<h2 className="font-display text-[15px] font-semibold mt-6 mb-3 text-ink uppercase tracking-[0.06em]">
  …
</h2>
```

### Body paragraph

```tsx
<p className="mb-4 text-ink leading-relaxed">…</p>
```

### Inline code (any glossary "keep" term, register name, identifier)

```tsx
<code className="font-mono text-[12.5px] text-accent">name</code>
```

### Code block

Store the listing in a `const` template literal — that's the only way
newlines AND leading whitespace survive JSX intact. Example:

```tsx
const EXAMPLE_CODE = `void main() {
  int foo = 0;
  if (foo) {
    printf("hi\n");
  }
}`;
```

The two-space / four-space / six-space nesting in the source must
appear identically inside the template literal. Tabs stay tabs;
spaces stay spaces (don't auto-convert). Blank lines in the source
stay blank — do not collapse them.

Then render:

```tsx
<pre
  className="font-mono text-[11.5px] leading-snug px-3 py-2 mb-6 overflow-x-auto text-ink"
  style={{
    background: 'var(--color-paper-deep)',
    borderLeft: '3px solid var(--color-ink)',
  }}
>
  <code>{EXAMPLE_CODE}</code>
</pre>
```

If the extractor merged two visually-separate code blocks into one
text run, split them back into two `<pre>` blocks based on the PNG.

### Warning / caveat blockquote

```tsx
<blockquote
  className="mb-5 px-4 py-3 text-ink leading-relaxed"
  style={{
    background: 'var(--color-warn-soft)',
    borderLeft: '3px solid var(--color-warn)',
  }}
>
  …
</blockquote>
```

### Tables

Use these constants verbatim (copy from page-0001):

```tsx
const TD = 'border border-ink/40 px-3 py-2 align-top text-[13px] text-ink';
const TD_MONO = 'border border-ink/40 px-3 py-2 align-top font-mono text-[12.5px] text-ink';
const TH = 'border border-ink px-3 py-2 font-mono text-[11px] font-semibold text-left uppercase tracking-[0.06em] bg-paper-deep text-ink';
```

Honour every `rowSpan` / `colSpan` from the `tables[i].cells[]` JSON
EXACTLY. The extractor has already resolved spans against gridlines.

### Definition list (struct fields, glossary-style entries)

```tsx
<dl className="mb-4">
  <dt className="font-mono text-[13px] text-accent mt-2">fieldName</dt>
  <dd className="ml-6 mb-2 text-ink leading-relaxed">說明…</dd>
</dl>
```

### Bullet list

```tsx
<ul className="mb-4 ml-6 list-disc text-ink leading-relaxed">
  <li className="mb-1">…</li>
</ul>
```

### Numbered list

```tsx
<ol className="mb-4 ml-6 list-decimal text-ink leading-relaxed">
  <li className="mb-1">…</li>
</ol>
```

Nested lists: nest `<ul>`/`<ol>` inside an `<li>`. The `ml-6` on the
inner list gives the second-level indent; do not stack `ml-*` manually.

## Figure handling

The extracted text contains `[[FIGURE_K]]` markers at the figure's
vertical position. For each marker, look up the corresponding entry in
`figures[]` from the page JSON and emit a `<figure>` element. This
matters not just for the in-app reading experience — the export-to-PDF
flow takes the translated TSX verbatim, so any figure you drop is gone
from the printable artifact too.

### Case A — figure entry has a `pngPath`

Embed the rendered figure PNG. The dev server serves
`/<docId>/<file>` from the doc's `public/` dir, so prefix the src:

```tsx
<figure className="my-4">
  <img
    src="/<docId>/<pngPath>"
    alt="圖 <K>"
    className="w-full h-auto block border border-rule"
  />
  <figcaption className="mt-1 text-center text-ink-muted text-[12px]">
    圖 <K>：<translated caption>
  </figcaption>
</figure>
```

The caption text is the block that sits immediately before or after the
figure in the source (the PNG on the left makes it obvious which block
that is). Translate it like any other prose; drop the `<figcaption>`
entirely if the source has no caption.

### Case B — figure entry has NO `pngPath`

Rare; only when the extractor's crop failed on a degenerate bbox.
Fall back to a placeholder. The reader still has the left pane, and the
export-to-PDF flow will surface this as "figure missing":

```tsx
<figure className="my-4 text-center text-ink-muted text-[12px] italic">
  （見左側原文圖 <K>）
</figure>
```

In either case, `<figure>` is block-level — if the `[[FIGURE_K]]` marker
sat inside a paragraph mid-sentence, lift it OUT to be a sibling of
`<p>`, not a child. Preserve the surrounding sentence flow.

### Case C — inline icon (small figure embedded mid-sentence)

When a `[[FIGURE_K]]` marker sits BETWEEN words of a single sentence
(e.g. "click [[FIGURE_3]] to build a project", a UI button glyph drawn
into prose) and the figure's bbox is small (roughly icon-sized — under
~50px tall on the rendered 2× PNG, or visibly smaller than the
surrounding line height in the left pane), it is an inline icon, not a
block figure. Render it INLINE — do NOT lift it out to a sibling
`<figure>` and do NOT replace it with a `<br />`:

```tsx
<p className="mb-4 text-ink leading-relaxed">
  點擊
  <img
    src="/<docId>/<pngPath>"
    alt="<short description, e.g. Build 按鈕>"
    className="inline-block h-[1.1em] align-text-bottom mx-1"
  />
  以編譯專案。
</p>
```

The most common cases: toolbar button glyphs in step-by-step
instructions, keycap symbols, inline math/unit glyphs, and tiny status
icons. When in doubt, glance at the left-pane PNG — if the figure is
sitting at x-height inside a sentence and the sentence still reads
across it, render it inline. Dropping the icon (just deleting the
marker, or replacing with a `<br />`) is wrong; the reader needs to
see WHICH button to click.

If the figure has no `pngPath` (Case B fallback) but is inline, use a
short bracketed gloss instead of the placeholder figure:

```tsx
點擊 <span className="font-mono text-[12.5px] text-accent">[Build]</span> 以編譯專案。
```

## Running header / footer handling (DO NOT capture into body)

Most pages have a printed running footer **below a horizontal rule** at the
very bottom of the page. The framework re-renders that footer itself via
`footerLeft` / `footerCenter` / `footerRight` on `<BilingualPage>`, so the
raw footer text must NOT appear anywhere inside `{children}`. The extractor
sometimes leaves it in the text stream — strip it.

### What the running footer looks like

Two layout conventions across the typical book:

- **Recto (odd page)**: `<section title>` on the left, `<page number>` on the right.
  e.g. `1.5. To start a new project` | `37`
- **Verso (even page)**: `<page number>` on the left, `<chapter title>` on the right.
  e.g. `38` | `Chapter 1. Getting Start`

Some books also print a running header (chapter title centered or right-aligned
above the body). Same rule: strip it from `{children}` and let the chrome
render it.

### How to populate the chrome footer

Map the running footer's parts into the slots:

- `footerLeft="<N>"` — page number, always. The slot is `w-12` mono numeric.
- `footerCenter="<section or chapter title>"` — whichever the original page
  shows. Translate it (the chrome footer is on the translation side).
- `footerRight="<page label in target locale>"` — e.g. `"頁 37"` or `"Page 37"`.
  Use this for symmetry; don't duplicate `footerCenter` here.

### What is NOT a running footer (KEEP in body)

The PDF's body sometimes contains italic continuation cues like
`(continued from previous page)` / `（承上頁）` / `表 5.1 — 接續上頁` /
`continued on next page` / `（接下頁）`. These sit ABOVE the rule line in the
source — they are real body content (often inside or adjacent to a long
table). Keep them in `{children}` as a normal `<p>` with the muted italic
styling already in use:

```tsx
<p className="mb-4 text-ink-muted text-[12px] italic text-right">
  續接下一頁
</p>
```

When in doubt, glance at the left-pane PNG: if the text sits ABOVE the
horizontal rule, it's body content; if it sits BELOW the rule, it's the
running footer and must be stripped.

## Empty / watermark-only / trivially-short pages

If a page is blank, watermark-only, or has under ~20 letters of real
content, still emit the file with a single empty paragraph and a
JSX comment noting why — never skip the file entirely (downstream code
expects every pageId in the dispatched range to exist).

## What you must NOT do

- Do not invent new Tailwind class strings. Stick to the design tokens
  above — the inspector and `apply-comments` flow assume them.
- Do not strip the watermark from the source PDF or page text. The
  extractor has already filtered watermark text from the JSON; the
  page PNGs (left pane) intentionally keep it.
- Do not call back to the parent agent. Hand off via the filesystem
  with `Write`.
- Do not edit anything outside `apps/demo/docs/<docId>/pages/<pageId>/`.
- Do not depend on internet access — you run inside the user's Claude
  Code session, not an API call.
