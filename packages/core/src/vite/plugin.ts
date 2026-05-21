import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Plugin, ViteDevServer } from 'vite';
import type { InterlinearConfig } from '../config';

export type InterlinearPluginOptions = {
  /** Workspace root (the app folder that holds the docs/ directory). */
  userCwd: string;
  /** Folder containing per-doc subfolders. Defaults to "docs". */
  docsDir?: string;
  /** Default pagesDir inside each doc. Defaults to "pages". */
  pagesDir?: string;
};

const DOCS_VMOD = 'virtual:interlinear/docs';

function resolved(id: string): string {
  return `\0${id}`;
}

type DocPage = { id: string; abs: string; rel: string };

type Doc = {
  id: string;
  dir: string;
  config: InterlinearConfig;
  pagesRoot: string;
  pages: DocPage[];
};

async function loadDocConfig(dir: string): Promise<InterlinearConfig | null> {
  const candidates = ['interlinear.config.ts', 'interlinear.config.js'];
  for (const c of candidates) {
    const fp = path.resolve(dir, c);
    if (!existsSync(fp)) continue;
    try {
      const mod = await import('bundle-require');
      const { mod: loaded } = await mod.bundleRequire({ filepath: fp });
      return (loaded as { default?: InterlinearConfig }).default ?? (loaded as InterlinearConfig);
    } catch (e) {
      console.warn(`[interlinear] failed to load ${fp}:`, e);
    }
  }
  return null;
}

async function findDocs(docsRoot: string, pagesDir: string): Promise<Doc[]> {
  if (!existsSync(docsRoot)) return [];
  const entries = await fg('*', {
    cwd: docsRoot,
    onlyDirectories: true,
    dot: false,
  });
  const out: Doc[] = [];
  for (const id of entries.sort()) {
    const dir = path.resolve(docsRoot, id);
    const config = (await loadDocConfig(dir)) ?? { title: id };
    const docPagesDir = config.pagesDir ?? pagesDir;
    const pagesRoot = path.resolve(dir, docPagesDir);
    const hits = existsSync(pagesRoot)
      ? await fg('*/index.{tsx,jsx,ts,js}', {
          cwd: pagesRoot,
          absolute: true,
          onlyFiles: true,
        })
      : [];
    hits.sort();
    const pages: DocPage[] = hits.map((abs) => ({
      id: path.relative(pagesRoot, abs).split(path.sep)[0],
      abs,
      rel: path.relative(docsRoot, abs),
    }));
    out.push({ id, dir, config, pagesRoot, pages });
  }
  return out;
}

function isPageEntry(
  absPath: string,
  docsRoot: string,
  pagesDir: string,
): { docId: string; pageId: string } | null {
  const rel = path.relative(docsRoot, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  // <docId>/<pagesDir>/<pageId>/index.<ext>
  if (parts.length !== 4) return null;
  if (parts[1] !== pagesDir) return null;
  if (!/^index\.(tsx|jsx|ts|js)$/.test(parts[3])) return null;
  return { docId: parts[0], pageId: parts[2] };
}

function sanitizeIdent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

function generateDocsModule(docs: Doc[], isDev: boolean): string {
  const out: string[] = [];
  out.push(`// virtual:interlinear/docs — generated`);
  for (const doc of docs) {
    const loaderName = `loadDoc_${sanitizeIdent(doc.id)}`;
    const cases = doc.pages
      .map((p) => {
        const importPath = isDev ? `/@fs/${p.abs.replace(/^\/+/, '')}` : p.abs;
        return `      case ${JSON.stringify(p.id)}: return import(${JSON.stringify(importPath)});`;
      })
      .join('\n');
    out.push(`async function ${loaderName}(id) {`);
    out.push(`  switch (id) {`);
    if (cases) out.push(cases);
    out.push(`    default: throw new Error('Page not found in ${doc.id}: ' + id);`);
    out.push(`  }`);
    out.push(`}`);
  }
  out.push(`export const docs = [`);
  for (const doc of docs) {
    const loaderName = `loadDoc_${sanitizeIdent(doc.id)}`;
    const pageFiles = Object.fromEntries(doc.pages.map((p) => [p.id, p.rel]));
    out.push(`  {`);
    out.push(`    id: ${JSON.stringify(doc.id)},`);
    out.push(`    title: ${JSON.stringify(doc.config.title ?? doc.id)},`);
    out.push(`    locale: ${JSON.stringify(doc.config.locale ?? null)},`);
    out.push(`    sourcePdf: ${JSON.stringify(doc.config.sourcePdf ?? null)},`);
    out.push(`    pageIds: ${JSON.stringify(doc.pages.map((p) => p.id))},`);
    out.push(`    pageFiles: ${JSON.stringify(pageFiles)},`);
    out.push(`    loadPage: ${loaderName},`);
    out.push(`  },`);
  }
  out.push(`];`);
  out.push('');
  return out.join('\n');
}

const STATIC_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.pdf',
]);

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export function interlinearPlugin(opts: InterlinearPluginOptions): Plugin {
  const userCwd = path.resolve(opts.userCwd);
  const docsDir = opts.docsDir ?? 'docs';
  const docsRoot = path.resolve(userCwd, docsDir);
  const pagesDir = opts.pagesDir ?? 'pages';

  let isDev = false;
  let docIdsCache = new Set<string>();

  async function refreshDocIds(): Promise<void> {
    if (!existsSync(docsRoot)) {
      docIdsCache = new Set();
      return;
    }
    const entries = await fg('*', {
      cwd: docsRoot,
      onlyDirectories: true,
      dot: false,
    });
    docIdsCache = new Set(entries);
  }

  return {
    name: 'interlinear',
    config(_c, env) {
      isDev = env.command === 'serve';
      return {
        server: { fs: { allow: [userCwd, docsRoot] } },
      };
    },
    resolveId(id) {
      if (id === DOCS_VMOD) return resolved(DOCS_VMOD);
      return null;
    },
    async load(id) {
      if (id === resolved(DOCS_VMOD)) {
        const docs = await findDocs(docsRoot, pagesDir);
        docIdsCache = new Set(docs.map((d) => d.id));
        return generateDocsModule(docs, isDev);
      }
      return null;
    },
    handleHotUpdate(ctx) {
      const hit = isPageEntry(ctx.file, docsRoot, pagesDir);
      if (!hit) return;
      ctx.server.ws.send({
        type: 'custom',
        event: 'interlinear:page-changed',
        data: hit,
      });
      return;
    },
    configureServer(server: ViteDevServer) {
      refreshDocIds().catch(() => {});

      // Serve per-doc static assets at /<docId>/<...>, looking in
      // <docsRoot>/<docId>/public/<rest> first, then <docsRoot>/<docId>/<rest>.
      server.middlewares.use((req, res, next) => {
        const u = (req.url ?? '').split('?')[0] ?? '';
        const m = /^\/([^/]+)\/(.+)$/.exec(u);
        if (!m) return next();
        const [, docId, rest] = m;
        if (!docIdsCache.has(docId)) return next();
        const ext = path.extname(rest).toLowerCase();
        if (!STATIC_EXTS.has(ext)) return next();
        const docDir = path.resolve(docsRoot, docId);
        const candidates = [
          path.resolve(docDir, 'public', rest),
          path.resolve(docDir, rest),
        ];
        for (const candidate of candidates) {
          if (!candidate.startsWith(docDir)) continue;
          if (!existsSync(candidate)) continue;
          res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
          createReadStream(candidate).pipe(res);
          return;
        }
        return next();
      });

      if (existsSync(docsRoot)) server.watcher.add(docsRoot);

      let reloadTimer: ReturnType<typeof setTimeout> | null = null;
      const reload = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(async () => {
          reloadTimer = null;
          await refreshDocIds();
          const mod = server.moduleGraph.getModuleById(resolved(DOCS_VMOD));
          if (mod) server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: 'full-reload' });
        }, 100);
      };

      server.watcher.on('add', (p) => {
        if (isPageEntry(p, docsRoot, pagesDir)) reload();
      });
      server.watcher.on('unlink', (p) => {
        if (isPageEntry(p, docsRoot, pagesDir)) reload();
      });
      server.watcher.on('change', (p) => {
        if (
          path.basename(p) === 'interlinear.config.ts' &&
          p.startsWith(docsRoot)
        ) {
          reload();
        }
      });
    },
  };
}
