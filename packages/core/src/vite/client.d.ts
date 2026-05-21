// Ambient types for interlinear virtual modules. Apps include this via
// `/// <reference types="@interlinear/core/vite/client" />` or by adding it
// to tsconfig's `types`.

declare module 'virtual:interlinear/docs' {
  export type InterlinearDoc = {
    id: string;
    title: string;
    locale: string | null;
    sourcePdf: string | null;
    pageIds: string[];
    /** pageId -> path relative to the workspace's docs/ directory. */
    pageFiles: Record<string, string>;
    loadPage(id: string): Promise<{ default: React.ComponentType }>;
  };
  export const docs: InterlinearDoc[];
}
