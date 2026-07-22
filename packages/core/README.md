# interlinear

The framework behind [**interlinear**](https://github.com/pascal910107/interlinear) —
a post-editing IDE for AI translations of PDFs. It ships three things:

- a **Vite plugin** that discovers per-doc pages and serves the bilingual viewer,
- a **React runtime** (the side-by-side reader: `left = original PDF image,
  right = translated page`, plus search, navigation, theming), and
- the **Claude Code skills** that drive translation and editing.

There is no LLM runtime of its own — translation and refinement run inside your
own [Claude Code](https://claude.com/claude-code) session via the bundled skills.

## Install

```bash
pnpm add -D interlinear
# peers: react, react-dom, vite
```

## Use

Wire the plugin into a Vite + React app:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react';
import { interlinearPlugin } from 'interlinear/vite';
import config from './interlinear.config';

export default {
  plugins: [
    react(),
    interlinearPlugin({ userCwd: __dirname, docsDir: config.docsDir }),
  ],
};
```

Render a page component with the runtime:

```tsx
import { BilingualPage } from 'interlinear';
import 'interlinear/styles/tokens.css';
```

Each source PDF becomes a *doc* under `docs/<docId>/` with one
`pages/page-NNNN/index.tsx` component and one `page-NNNN.png` per page.
`pnpm --filter <app> build` produces a static reader — pages render to static
JS, each doc's images are copied in, and a per-doc `search-index.json` powers
full-text search (across both the translation and the original PDF text)
entirely client-side. Deploy the output to any static host; no backend.

## Exports

| Entry | Contents |
|-------|----------|
| `interlinear` | React runtime: `BilingualPage`, `PageScroller`, `SearchBar`, doc context, hooks. |
| `interlinear/vite` | `interlinearPlugin` + dev-only editing/search endpoints. |
| `interlinear/config` | `InterlinearConfig` type and helpers. |
| `interlinear/styles/tokens.css` | Design tokens (CSS custom properties). |

## Skills

Bundled under the package's `skills/` directory, run from a Claude Code session:

| Skill | What it does |
|-------|--------------|
| `translate-pdf`  | Translate the PDF in a doc's config into per-page TSX. |
| `apply-comments` | Apply inline `@page-comment` markers left while reviewing. |
| `ask-doc`        | Answer document-level questions from the DocChat sidebar. |
| `refine-term`    | Rename a term consistently across every page's prose. |

## License

[MIT](./LICENSE)
