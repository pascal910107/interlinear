import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { Plugin, ViteDevServer } from 'vite';
import type { InterlinearConfig } from '../config';
import { loadDocConfig } from '../editing/load-doc-config';

export type InterlinearPluginOptions = {
  /** Workspace root (the app folder that holds the docs/ directory). */
  userCwd: string;
  /** Folder containing per-doc subfolders. Defaults to "docs". */
  docsDir?: string;
  /** Default pagesDir inside each doc. Defaults to "pages". */
  pagesDir?: string;
};

const DOCS_VMOD = 'virtual:interlinear/docs';

// Auto-generated Tailwind safelist on disk. We tried exposing this as a
// virtual CSS module (resolveId/load returning `@source inline("…")`) but
// Tailwind v4's customCssResolver requires `path.isAbsolute(resolvedId)`,
// which excludes `\0virtual:…` ids — so CSS @imports never reach our
// plugin's resolveId for virtual modules. A real file under the already-
// gitignored `.interlinear/` dir is the simplest workaround.
const SAFELIST_REL = path.join('.interlinear', 'page-classes.css');

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

// ---------------------------------------------------------------------------
// Tailwind safelist from gitignored docs pages
// ---------------------------------------------------------------------------
// Per-doc pages live under <docsRoot>/<docId>/<pagesDir>/page-NNNN/index.tsx
// and are gitignored by convention. Tailwind v4's Oxide scanner respects
// .gitignore even for explicit `@source "<path>"` paths, so any utility used
// ONLY inside a page (list-decimal, columns-2, …) would silently fall out of
// the built CSS. We work around this by scanning the docs tree ourselves and
// writing `@source inline("…")` to `<userCwd>/.interlinear/page-classes.css`
// — inline safelisting bypasses the file scanner and gitignore entirely.
// The user imports the file from their app CSS so the safelist lands in
// the same Tailwind compilation unit as their `@import "tailwindcss"`.
//
// (A virtual CSS module would be tidier, but Tailwind v4's customCssResolver
// rejects non-absolute paths — including the `\0virtual:…` ids Vite uses
// for virtual modules — so an on-disk file is the simplest path that works
// without forking Tailwind.)

const CLASSNAME_ATTR_RE =
  /className\s*=\s*(?:["'`]([^"'`]+)["'`]|\{\s*["'`]([^"'`]+)["'`]\s*\})/g;
// String literals that *might* be `const TD = 'border …'`-style class
// constants (table-cell helpers the translator emits). We require ≥ 20
// chars and at least one whitespace to filter random short strings, and
// validate every token against looksLikeUtility() — if any token in the
// string fails, the whole string is rejected (likely not a class list).
const CLASS_LIKE_STRING_RE =
  /["'`]([a-z][a-z0-9_\-\[\]/:.\s]{20,}?)["'`]/g;

function looksLikeUtility(tok: string): boolean {
  if (!tok || tok.length > 60) return false;
  // Tailwind classes start with an optional negative dash + a lowercase
  // letter: `-mt-2`, `list-decimal`, `hover:bg-red-500`, ….
  if (!/^-?[a-z]/.test(tok)) return false;
  // Carve out `[arbitrary value]` segments — those can legitimately contain
  // anything (parens, commas, uppercase, percent signs, etc.) — and
  // validate the rest more strictly.
  const skeleton = tok.replace(/\[[^\]]*\]/g, '');
  // The skeleton must be lowercase alphanumerics + the structural chars
  // Tailwind allows between utility, variant, and modifier segments. Bare
  // `-` (e.g. ffmpeg flags like `-an`, `-vcodec`) is rejected by the
  // suffix check: a real Tailwind utility either contains another `-` or
  // ends in alphanumerics.
  if (!/^-?[a-z][a-z0-9\-_/:.]*$/.test(skeleton)) return false;
  // Reject pure ffmpeg/CLI flag shape: `-something` with nothing else.
  if (/^-[a-z][a-z]*$/.test(tok)) return false;
  // Reject file-extension shape (`output.avi`, `init.scr`, `ffmpeg.exe`):
  // a dot followed by 2-5 letters with no digit, at the end of the token,
  // and no other `-`/`:`/`[` structure that would suggest a Tailwind class.
  if (/^[a-z][a-z0-9_]*\.[a-z]{2,5}$/.test(tok)) return false;
  return true;
}

async function extractDocsClasses(docsRoot: string): Promise<string[]> {
  if (!existsSync(docsRoot)) return [];
  const files = await fg('**/*.{tsx,jsx,ts,js}', {
    cwd: docsRoot,
    absolute: true,
    onlyFiles: true,
    ignore: [
      '**/interlinear.config.{ts,js}',
      '**/node_modules/**',
      '**/.interlinear/**',
      '**/public/**',
    ],
  });
  const classes = new Set<string>();
  await Promise.all(
    files.map(async (file) => {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        return;
      }
      // 1. className="…" / className={`…`} attributes — the common case.
      for (const m of content.matchAll(CLASSNAME_ATTR_RE)) {
        const raw = m[1] ?? m[2] ?? '';
        for (const tok of raw.split(/\s+/)) {
          if (looksLikeUtility(tok)) classes.add(tok);
        }
      }
      // 2. `const TD = 'border …'` style class constants. The CLASS_LIKE_
      // STRING_RE deliberately has a restrictive character class (lowercase
      // + Tailwind structural chars only) so code identifiers like
      // `iteIrGetFreqAvg(ITHIrPort` and prose strings don't match in the
      // first place. We then ALSO require every token to pass
      // looksLikeUtility — if any token fails, the whole string is
      // rejected as non-class-list garbage.
      for (const m of content.matchAll(CLASS_LIKE_STRING_RE)) {
        const raw = m[1];
        if (!/\s/.test(raw)) continue;
        const tokens = raw.trim().split(/\s+/);
        if (tokens.length < 2 || tokens.length > 50) continue;
        if (!tokens.every(looksLikeUtility)) continue;
        for (const tok of tokens) classes.add(tok);
      }
    }),
  );
  return Array.from(classes).sort();
}

function generatePageClassesCss(
  classes: string[],
  docsRoot: string,
): string {
  const header =
    `/* auto-generated by @interlinear/core/vite — safelist of Tailwind\n` +
    `   utilities used in ${docsRoot}\n` +
    `   Do not edit by hand; the plugin rewrites this file on every dev\n` +
    `   restart and on page HMR. */\n`;
  if (classes.length === 0) {
    return header + `/* no class candidates found */\n`;
  }
  // Double quotes inside class names are vanishingly rare but technically
  // legal in arbitrary values; escape to keep the @source string parsable.
  const escaped = classes.map((c) => c.replace(/"/g, '\\"')).join(' ');
  return header + `@source inline("${escaped}");\n`;
}

// Cache last-written contents so unchanged regenerations don't re-trigger
// Vite's CSS HMR (which would otherwise blink the page on every page edit).
let lastWrittenSafelist = '';

async function writeSafelist(userCwd: string, docsRoot: string): Promise<void> {
  const classes = await extractDocsClasses(docsRoot);
  const content = generatePageClassesCss(classes, docsRoot);
  if (content === lastWrittenSafelist) return;
  const target = path.resolve(userCwd, SAFELIST_REL);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  lastWrittenSafelist = content;
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
    async buildStart() {
      // Regenerate the safelist before any CSS is transformed so the file
      // is up-to-date for the first request (both dev and build). Cheap
      // even with 1000+ pages — bounded by disk read throughput, not LLM
      // calls.
      await writeSafelist(userCwd, docsRoot).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[interlinear] failed to write safelist:', err);
      });
    },
    handleHotUpdate(ctx) {
      const hit = isPageEntry(ctx.file, docsRoot, pagesDir);
      if (!hit) return;
      ctx.server.ws.send({
        type: 'custom',
        event: 'interlinear:page-changed',
        data: hit,
      });

      // The page's className set may have changed. Rewrite the safelist
      // file; the file watcher will then trigger HMR on the .css importer.
      void writeSafelist(userCwd, docsRoot).catch(() => {});
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
          const docsMod = server.moduleGraph.getModuleById(resolved(DOCS_VMOD));
          if (docsMod) server.moduleGraph.invalidateModule(docsMod);
          // Added/removed pages change the class candidate set — rewrite
          // the safelist file too.
          await writeSafelist(userCwd, docsRoot).catch(() => {});
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
