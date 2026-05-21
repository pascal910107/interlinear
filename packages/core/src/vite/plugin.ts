import { existsSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Plugin, ViteDevServer } from 'vite';
import type { DocMeta, InterlinearConfig } from '../config';

export type InterlinearPluginOptions = {
  /** Absolute path of the user workspace (the dir holding pages/, interlinear.config.ts). */
  userCwd: string;
  /** Resolved config. The demo's vite.config.ts imports its interlinear.config.ts and passes it through. */
  config: InterlinearConfig;
  /** Subset of config exposed as the "document" identity (title/sourcePdf/locale). */
  meta?: DocMeta;
};

const PAGES_VMOD = 'virtual:interlinear/pages';
const CONFIG_VMOD = 'virtual:interlinear/config';
const META_VMOD = 'virtual:interlinear/meta';

function resolved(id: string): string {
  return `\0${id}`;
}

async function findPages(pagesRoot: string): Promise<string[]> {
  if (!existsSync(pagesRoot)) return [];
  const hits = await fg('*/index.{tsx,jsx,ts,js}', {
    cwd: pagesRoot,
    absolute: true,
    onlyFiles: true,
  });
  return hits.sort();
}

function toPageId(absFile: string, pagesRoot: string): string {
  return path.relative(pagesRoot, absFile).split(path.sep)[0];
}

function isPageEntry(absPath: string, pagesRoot: string): string | null {
  const rel = path.relative(pagesRoot, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return null;
  if (!/^index\.(tsx|jsx|ts|js)$/.test(parts[1])) return null;
  return parts[0];
}

async function generatePagesModule(
  files: string[],
  pagesRoot: string,
  userCwd: string,
  isDev: boolean,
): Promise<string> {
  const entries = files.map((abs) => ({
    id: toPageId(abs, pagesRoot),
    abs,
    relToCwd: path.relative(userCwd, abs),
  }));

  const ids = JSON.stringify(entries.map((e) => e.id));
  const pageFiles = JSON.stringify(Object.fromEntries(entries.map((e) => [e.id, e.relToCwd])));

  // In dev, use /@fs/ absolute imports so Vite can serve files outside its root.
  // In build, use the absolute path directly — Rollup resolves it via the file system.
  const cases = entries
    .map((e) => {
      const importPath = isDev ? `/@fs/${e.abs.replace(/^\/+/, '')}` : e.abs;
      return `    case ${JSON.stringify(e.id)}: return import(${JSON.stringify(importPath)});`;
    })
    .join('\n');

  return `// virtual:interlinear/pages — generated
export const pageIds = ${ids};
export const pageFiles = ${pageFiles};

export async function loadPage(id) {
  switch (id) {
${cases}
    default: throw new Error('Page not found: ' + id);
  }
}
`;
}

export function interlinearPlugin(opts: InterlinearPluginOptions): Plugin {
  const userCwd = path.resolve(opts.userCwd);
  const pagesDir = opts.config.pagesDir ?? 'pages';
  const pagesRoot = path.resolve(userCwd, pagesDir);

  const meta: DocMeta = opts.meta ?? {
    title: opts.config.title,
    sourcePdf: opts.config.sourcePdf,
    locale: opts.config.locale,
  };

  let isDev = false;

  return {
    name: 'interlinear',
    config(_c, env) {
      isDev = env.command === 'serve';
      return {
        server: { fs: { allow: [userCwd] } },
      };
    },
    resolveId(id) {
      if (id === PAGES_VMOD) return resolved(PAGES_VMOD);
      if (id === CONFIG_VMOD) return resolved(CONFIG_VMOD);
      if (id === META_VMOD) return resolved(META_VMOD);
      return null;
    },
    async load(id) {
      if (id === resolved(PAGES_VMOD)) {
        const files = await findPages(pagesRoot);
        return await generatePagesModule(files, pagesRoot, userCwd, isDev);
      }
      if (id === resolved(CONFIG_VMOD)) {
        return `export default ${JSON.stringify(opts.config)};\n`;
      }
      if (id === resolved(META_VMOD)) {
        return `export default ${JSON.stringify(meta)};\n`;
      }
      return null;
    },
    handleHotUpdate(ctx) {
      const pageId = isPageEntry(ctx.file, pagesRoot);
      if (!pageId) return;
      // Notify the client so it can refresh per-page UI without a full reload.
      ctx.server.ws.send({
        type: 'custom',
        event: 'interlinear:page-changed',
        data: { pageId },
      });
      // Don't short-circuit React Fast Refresh — return undefined to let Vite's
      // default HMR continue handling the JS module update.
      return;
    },
    configureServer(server: ViteDevServer) {
      // Vite already watches userCwd if it's the root, but be explicit so
      // moving the plugin to a non-root config still works.
      if (existsSync(pagesRoot)) server.watcher.add(pagesRoot);

      let reloadTimer: ReturnType<typeof setTimeout> | null = null;
      const reload = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          const mod = server.moduleGraph.getModuleById(resolved(PAGES_VMOD));
          if (mod) server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: 'full-reload' });
        }, 100);
      };

      server.watcher.on('add', (p) => {
        if (isPageEntry(p, pagesRoot)) reload();
      });
      server.watcher.on('unlink', (p) => {
        if (isPageEntry(p, pagesRoot)) reload();
      });
    },
  };
}
