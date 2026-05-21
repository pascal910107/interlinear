export type InterlinearConfig = {
  title: string;
  sourcePdf?: string;
  locale?: string;
  pagesDir?: string;
  /**
   * Translation engine the `translate-pdf` skill should orchestrate.
   * - `translate-book` (default): delegate to `deusyu/translate-book`.
   * - `subagent`: dispatch parallel Claude Code sub-agents directly via the
   *   bundled PyMuPDF extractor.
   */
  engine?: 'translate-book' | 'subagent';
  /** Number of pages to translate concurrently when `engine: 'subagent'`. */
  concurrency?: number;
};

export type DocMeta = {
  title: string;
  sourcePdf?: string;
  locale?: string;
};

export function defineConfig<T extends InterlinearConfig>(c: T): T {
  return c;
}
