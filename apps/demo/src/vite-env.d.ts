/// <reference types="vite/client" />

declare module 'virtual:interlinear/docs' {
  import type { ComponentType } from 'react';
  export type InterlinearDoc = {
    id: string;
    title: string;
    locale: string | null;
    sourcePdf: string | null;
    pageIds: string[];
    /** pageId -> path relative to the workspace's docs/ directory. */
    pageFiles: Record<string, string>;
    loadPage(id: string): Promise<{ default: ComponentType }>;
  };
  export const docs: InterlinearDoc[];
}
