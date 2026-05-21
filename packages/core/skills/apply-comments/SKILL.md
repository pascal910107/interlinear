---
name: apply-comments
description: Apply pending @page-comment markers left by the interlinear inspector. Use when the user asks to "apply comments", "process page comments", or references markers inside pages/<id>/index.tsx files.
---

# Apply page comments

The interlinear inspector lets the user click on a rendered element in the
translation pane and attach a textual note (e.g. *"register 翻成『暫存器』更
準確"*, *"this paragraph should mention `ioctl`"*). Each comment is
persisted as an in-source JSX marker inside the targeted
`pages/<pageId>/index.tsx`.

Your job: read those markers, apply the described edits to the translated
JSX, and delete the markers.

## Marker format

```
{/* @page-comment id="c-<8hex>" ts="<ISO>" text="<base64url(JSON)>" */}
```

- Always sits on its own line as the **first child inside** the JSX element
  it refers to (between that element's opening `>` and its other children).
- `text` is base64url-encoded JSON: `{"note": "...", "hint"?: "..."}`.
- Detection regex (authoritative — use exactly this):

  ```
  /\{\/\*\s*@page-comment\s+id="(c-[a-f0-9]+)"\s+ts="([^"]+)"\s+text="([A-Za-z0-9_\-]+={0,2})"\s*\*\/\}/g
  ```

## Procedure

1. **Scan for markers.**
   - Glob `pages/**/index.tsx` from the user workspace (typically
     `apps/<appName>/pages/**/index.tsx` in a monorepo, or just
     `pages/**/index.tsx` in a single-package layout).
   - Apply the regex per file. For every match, base64url-decode `text` and
     `JSON.parse` it to get `{ note, hint? }`.
   - Record each as `{ file, id, lineIndex (0-based), note, hint }`.
   - If no markers exist, tell the user and stop.

2. **Understand each comment in context.**
   - The targeted JSX element is the **enclosing** element of the marker —
     read upward from the marker line until you reach the unclosed JSX
     opening tag whose body the marker lives in.
   - Read enough surrounding code (parent element, siblings, inline styles,
     adjacent paragraphs) to apply the change faithfully.
   - The `note` is in the user's mental language about *translation
     quality* — wording, terminology, tone, omissions. Apply it
     accordingly. A note like "翻成 X" means: rewrite the Chinese text in
     this element to use `X`.
   - If the note is ambiguous, do the smallest reasonable interpretation
     and flag it in your summary.

3. **Apply edits in reverse line order.**
   - Sort markers by descending `lineIndex` within each file and process
     one at a time using the `Edit` tool.
   - Top-down processing would invalidate line numbers for later markers.

4. **Remove each marker after applying its edit.**
   - Delete the entire marker line including its trailing `\n`.
   - Never leave a marker behind. An un-removed marker signals a failure.

5. **Verify.**
   - After all edits, re-read each touched file and confirm zero remaining
     markers.
   - Run `pnpm typecheck` from the workspace root to confirm the touched
     pages still type-check.

6. **Report.**
   - Summarise: `N applied, 0 remaining` plus one line per change
     (`page-0042 / line 47: register → 暫存器`).

## base64url decoding helper

```js
function decode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}
```

You can run this inline via `node -e '...'` to inspect a payload if needed.

## Cross-page consistency

If the same terminology change applies to more than one page (e.g. "always
translate `register` as `暫存器`"), prefer suggesting `/refine-term` to
the user rather than fanning the comment out manually. For now,
`refine-term` is a planned skill — note the suggestion in your report.

## Edge cases

- **Marker as the only content of a small wrapper element** (`<p>{marker}</p>`): the
  user almost certainly meant the parent of that wrapper. Apply the
  smallest reasonable interpretation; flag in summary.
- **Multiple markers stacked on consecutive lines inside the same element**:
  they all refer to that enclosing element. Apply in source order; delete
  each line individually.
- **Can't resolve the comment** (truly ambiguous, target element no longer
  there): leave the marker in place and report it as skipped. Don't guess.

## Do not

- Do not touch `package.json`, `vite.config.ts`, anything under
  `packages/core/src/vite/`, or anything outside `pages/`.
- Do not add dependencies.
- Do not re-introduce markers or leave `TODO` breadcrumbs in the code.
