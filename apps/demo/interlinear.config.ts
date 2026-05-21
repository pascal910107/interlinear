/** Workspace-level interlinear config. Per-doc config (title, sourcePdf,
 * locale) lives at `docs/<docId>/interlinear.config.ts`. */
export type WorkspaceConfig = {
  /** Folder containing per-doc subdirectories. Defaults to "docs". */
  docsDir?: string;
  /** Default pagesDir inside each doc. Defaults to "pages". */
  pagesDir?: string;
  /** Dev server port. */
  port?: number;
};

const config: WorkspaceConfig = {
  docsDir: 'docs',
  pagesDir: 'pages',
  port: 5173,
};

export default config;
