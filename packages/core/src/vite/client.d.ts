// Ambient types for interlinear virtual modules. Apps include this via
// `/// <reference types="@interlinear/core/vite/client" />` or by adding it
// to tsconfig's `types`.

declare module 'virtual:interlinear/pages' {
  export const pageIds: string[];
  export const pageFiles: Record<string, string>;
  export function loadPage(id: string): Promise<{ default: React.ComponentType }>;
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
