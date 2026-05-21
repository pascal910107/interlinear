export type InterlinearConfig = {
  title: string;
  sourcePdf?: string;
  locale?: string;
  pagesDir?: string;
  /** Maximum number of sub-agent batches in flight at once. Defaults to 6. */
  concurrency?: number;
  /**
   * Pages per sub-agent batch. The sub-agent reads the static design-token
   * template once and amortises it across all pages in the batch — bigger
   * batches mean less duplicated instruction overhead. Defaults to 10.
   * Set to 1 for finer-grained failure recovery at the cost of more tokens.
   */
  batchSize?: number;
  /**
   * If true, the `translate-pdf` skill builds `.interlinear/glossary.json`
   * before the per-page fanout and injects the relevant subset into each
   * sub-agent's prompt as a hard constraint. Best for a first pass on a
   * new technical document where cross-page terminology drift would be
   * costly. Off by default.
   */
  glossary?: boolean;
};

export type DocMeta = {
  title: string;
  sourcePdf?: string;
  locale?: string;
};

export function defineConfig<T extends InterlinearConfig>(c: T): T {
  return c;
}
