/// <reference types="vite/client" />

declare module 'virtual:interlinear/pages' {
  import type { ComponentType } from 'react';
  export const pageIds: string[];
  export const pageFiles: Record<string, string>;
  export function loadPage(id: string): Promise<{ default: ComponentType }>;
}

declare module 'virtual:interlinear/config' {
  import type { InterlinearConfig } from '@interlinear/core/config';
  const config: InterlinearConfig;
  export default config;
}

declare module 'virtual:interlinear/meta' {
  import type { DocMeta } from '@interlinear/core/config';
  const meta: DocMeta;
  export default meta;
}
