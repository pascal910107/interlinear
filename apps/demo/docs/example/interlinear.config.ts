import type { InterlinearConfig } from '@interlinear/core/config';

const config: InterlinearConfig = {
  title: 'Example Doc',
  // sourcePdf is intentionally a placeholder. A real workspace pointing
  // at an actual PDF should live in a gitignored ./workspaces/<name>/
  // folder with its own interlinear.config.ts.
  sourcePdf: './source.pdf',
  locale: 'zh-Hant',
};

export default config;
