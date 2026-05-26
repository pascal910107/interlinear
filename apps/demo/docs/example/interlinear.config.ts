import type { InterlinearConfig } from '@interlinear/core/config';

const config: InterlinearConfig = {
  title: 'Example Doc',
  // sourcePdf is intentionally a placeholder. A real workspace pointing
  // at an actual PDF should live in a gitignored ./workspaces/<name>/
  // folder with its own interlinear.config.ts.
  sourcePdf: './source.pdf',
  locale: 'zh-Hant',
  // Builds .interlinear/glossary.json before per-page fanout so
  // terminology stays consistent across pages. Recommended for new
  // technical docs; set to false for small/prose docs or runs that
  // only add a handful of pages to an already-translated doc.
  glossary: true,
};

export default config;
