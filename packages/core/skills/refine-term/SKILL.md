---
name: refine-term
description: Global terminology refactor across an interlinear doc. Use when the user wants to replace one term with another consistently across pages — e.g. "把『register』全部換成『暫存器』", "rename register → 暫存器 everywhere", "全文把 ioctl 翻成 控制呼叫". Operates on visible prose (JSXText) only; skips code/pre and JSX expressions.
---

# Refine terminology across pages

The user has decided that one term should consistently translate to
something else, and wants every occurrence rewritten in one shot. This is
the global counterpart to the per-element `@page-comment` →
`apply-comments` loop, and is the right tool when the same change
would otherwise be repeated dozens of times.

Your job: walk every `pages/**/index.tsx`, substitute the term inside
**visible prose only**, report a per-file count, and leave the project
type-checking.

## What "visible prose" means

The substitution must hit `JSXText` nodes — the prose that ends up in the
rendered DOM. It must **not** touch:

- Identifiers, variable names, prop names, attribute keys.
- `StringLiteral` and `TemplateLiteral` nodes inside `JSXExpressionContainer`
  (those are usually data arrays, class names, or `code` snippets).
- Import paths.
- Anything inside a `<code>` or `<pre>` element — the body of an inline
  code reference is a JSXText too, but it represents a literal API name
  the reader needs to see verbatim. Skip unless the user explicitly says
  "code too" / "包含 code 區塊".

You can rely on `@babel/parser` (already a dependency of
`interlinear` via the `apply-comment` / `apply-edit` plugins) to
produce a proper AST — do not regex-replace the file contents directly.

## Procedure

1. **Parse the user's request.**
   Extract `from` and `to`. Common shapes the user will type:
   - `把『register』全部換成『暫存器』`
   - `rename "register" → "暫存器" everywhere`
   - `/refine-term register -> 暫存器`
   - `把 ioctl 統一翻成 控制呼叫`

   Also pull flags out of the message (defaults in **bold**):
   - case sensitivity: **case-sensitive** unless the user says
     "ignore case" / "大小寫不分".
   - word boundary: **whole-word for ASCII**; CJK terms have no word
     boundary so substring is the only sensible match — do whole-word
     when `from` is purely ASCII, substring otherwise.
   - scope: **prose only**; code/pre opted in by phrases like
     "包含 code", "code 也要", "including code".

   If anything is genuinely ambiguous (e.g. the user wrote two arrows in
   one sentence and you cannot tell which direction is which), ask one
   question, then proceed.

2. **Find the pages.**
   - Glob `apps/demo/docs/*/pages/**/index.tsx`. If the user scoped the
     request to one doc ("rename register → 暫存器 in example-mcu-sdg"),
     narrow to `apps/demo/docs/<docId>/pages/**/index.tsx`. Mirror the
     `apply-comments` skill's globbing.
   - If zero pages match, stop and tell the user.

3. **Walk each page's AST.**
   For each file:

   ```js
   const ast = babelParse(source, {
     sourceType: 'module',
     plugins: ['typescript', 'jsx'],
     errorRecovery: true,
   });
   ```

   Traverse with `@babel/traverse` (or a hand-written recursive walk if
   you prefer to avoid the dep), collecting every `JSXText` node whose
   parent chain does **not** include a `<code>` or `<pre>` JSXElement
   (unless `code: true` opted in).

   For each candidate JSXText:
   - apply the matcher (whole-word vs substring, case sensitivity)
     against `node.value`;
   - compute the replacement string;
   - if it changed, record `{ file, line: node.loc.start.line, before, after }`.

4. **Apply the edits.**
   - Sort edits by descending line within each file and use the `Edit`
     tool one node at a time. Use enough surrounding context in
     `old_string` to make the match unique (a couple of words on either
     side usually suffices).
   - Don't try to do a single big AST rewrite — the `Edit` tool is
     simpler to audit and reverse if something goes wrong.

5. **Type-check.**
   Run `pnpm typecheck` from the repo root. If a page now fails to
   type-check, **revert that page only** (re-apply the inverse edits or
   `git checkout -- <file>` if clean) and report it as skipped. Do not
   roll back the whole batch — partial success is fine; lying about it
   is not.

6. **Report.**
   One-line summary plus a per-file count, e.g.:

   ```
   N replacements across M pages.

   page-0042  3
   page-0043  1
   page-0045  skipped (typecheck failed; reverted)
   ```

   If `code: true` was used, mention it in the summary so the user
   remembers.

## Edge cases

- **The `from` term appears in an attribute value** (`className="bg-register"`):
  skip — that's a `StringLiteral` inside a `JSXAttribute`, not a JSXText.
- **The term sits in a JSXExpressionContainer that renders a JS value**
  (`<td>{cell}</td>` where `cell` came from a const array of strings):
  skip the JSXText path; if the user actually wanted to rewrite those
  data arrays, they need to say "包含 data 陣列" / "rewrite the data
  arrays too" — then re-run handling `StringLiteral` nodes whose ancestry
  passes through a top-level `const` declaration in the page.
- **Partial-word matches in ASCII**: e.g. `from = "register"` should not
  rewrite `registered`. The whole-word rule covers this — `\bregister\b`.
- **CJK punctuation around the term**: `「register」` and `『register』` should
  both match. Substring matching handles this naturally; just don't add
  punctuation to the `from` term yourself.
- **The substitution would create an empty prose run**: that's almost
  certainly wrong (e.g. `from = "function"`, `to = ""`). Refuse and ask.

## Do not

- Do not touch anything outside `apps/demo/docs/*/pages/**/index.tsx`.
- Do not add dependencies — `@babel/parser` and `@babel/traverse` are
  already in the tree via `interlinear`.
- Do not modify any `interlinear.config.ts`, `vite.config.ts`, or any
  file under `packages/core/`.
- Do not commit. Leave the diff staged-or-not as the user prefers; the
  inspector + dev server pick the changes up via HMR for instant review.
- Do not loop this skill with itself ("now refine N more terms") — if
  the user has a batch, ask them to list pairs and run the loop in one
  pass.
