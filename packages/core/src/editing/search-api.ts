import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fg from 'fast-glob';
import type { Plugin } from 'vite';
import { loadDocConfig } from './load-doc-config';
import {
  createPdfTextIndex,
  type PdfIndexState,
  type PdfTextIndex,
} from './pdf-text-index';
import { extractPageSegments } from './search-extract';
import {
  matchSegments,
  searchOriginalText,
  sortHits,
  SEARCH_HIT_CAP,
  type Hit,
} from './search-core';

export type SearchApiOptions = {
  /** Root containing all docs. */
  docsRoot: string;
  /** pagesDir inside each doc. Defaults to "pages". */
  pagesDir?: string;
};

// Dev-only live search endpoint. Reads page TSX + the source PDF's plain text
// on every request so results always reflect unsaved edits. The production
// reader instead ships a prebuilt static index (build-search-index.ts) and
// searches it client-side via search-core.ts — both share the exact same
// matcher (matchSegments / searchOriginalText), so dev and the published site
// never disagree.
export function searchApiEndpoint({
  docsRoot,
  pagesDir = 'pages',
}: SearchApiOptions): Plugin {
  type PageRef = { docId: string; pageId: string; abs: string; rel: string };

  // Resolve extract_text.py relative to this module so the path stays
  // correct whether the package is consumed from source (dev) or built
  // (published via tsdown). __dirname isn't available in ESM; fileURLToPath
  // on import.meta.url is.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  // src/editing/search-api.ts → src/extract/extract_text.py
  // dist/editing/search-api.{js,mjs} → src/extract/extract_text.py (one
  // level up from dist/, into src/). Resolve both candidates.
  const extractorCandidates = [
    path.resolve(moduleDir, '..', 'extract', 'extract_text.py'),
    path.resolve(moduleDir, '..', '..', 'src', 'extract', 'extract_text.py'),
  ];
  const extractorPath =
    extractorCandidates.find((p) => existsSync(p)) ?? extractorCandidates[0];

  const pdfIndex: PdfTextIndex = createPdfTextIndex({ extractorPath });
  let startedExtraction = false;

  async function listPages(scopeDocId?: string | null): Promise<PageRef[]> {
    if (!existsSync(docsRoot)) return [];
    const docDirs = await fg('*', {
      cwd: docsRoot,
      onlyDirectories: true,
      dot: false,
    });
    const out: PageRef[] = [];
    for (const docId of docDirs) {
      if (scopeDocId && docId !== scopeDocId) continue;
      const pagesRoot = path.resolve(docsRoot, docId, pagesDir);
      if (!existsSync(pagesRoot)) continue;
      const files = await fg('*/index.{tsx,jsx,ts,js}', {
        cwd: pagesRoot,
        absolute: true,
        onlyFiles: true,
      });
      for (const abs of files) {
        out.push({
          docId,
          pageId: path.relative(pagesRoot, abs).split(path.sep)[0],
          abs,
          rel: path.relative(docsRoot, abs),
        });
      }
    }
    out.sort((a, b) => {
      if (a.docId !== b.docId) return a.docId < b.docId ? -1 : 1;
      return a.pageId < b.pageId ? -1 : 1;
    });
    return out;
  }

  // Walk every doc dir and discover { docId, docDir, sourcePdf } so the
  // PDF index knows which docs to extract. Called once on first request
  // (cheap re-runs are fine — the index dedupes via its own status map).
  async function discoverDocs(): Promise<
    { docId: string; docDir: string; sourcePdf: string | null }[]
  > {
    if (!existsSync(docsRoot)) return [];
    const docDirs = await fg('*', {
      cwd: docsRoot,
      onlyDirectories: true,
      dot: false,
    });
    const out: { docId: string; docDir: string; sourcePdf: string | null }[] =
      [];
    for (const docId of docDirs) {
      const docDir = path.resolve(docsRoot, docId);
      const config = await loadDocConfig(docDir);
      const rawPdf = config?.sourcePdf ?? null;
      let sourcePdf: string | null = null;
      if (rawPdf) {
        // sourcePdf can be absolute or relative to the doc dir.
        sourcePdf = path.isAbsolute(rawPdf)
          ? rawPdf
          : path.resolve(docDir, rawPdf);
      }
      out.push({ docId, docDir, sourcePdf });
    }
    return out;
  }

  async function ensureExtraction(): Promise<void> {
    if (startedExtraction) return;
    startedExtraction = true;
    const docs = await discoverDocs();
    pdfIndex.start(docs);
  }

  function summarizeStatus(state: PdfIndexState): {
    state: PdfIndexState['state'];
    error?: string;
  } {
    if (state.state === 'error') return { state: 'error', error: state.error };
    return { state: state.state };
  }

  return {
    name: 'interlinear-search-api',
    configureServer(server) {
      // Kick off extraction up-front so a fast `f` press doesn't have to
      // wait on hashing + spawn latency. Failures are per-doc and surfaced
      // via /__search responses, never thrown.
      void ensureExtraction();

      server.middlewares.use('/__search', async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://x');
          const q = url.searchParams.get('q')?.trim() ?? '';
          const doc = url.searchParams.get('doc')?.trim() || null;
          // Make sure the background extraction is running for this scope
          // (idempotent — only the first call does work).
          void ensureExtraction();

          const pdfStatus: Record<
            string,
            { state: PdfIndexState['state']; error?: string }
          > = {};
          if (doc) {
            pdfStatus[doc] = summarizeStatus(pdfIndex.getStatus(doc));
          }

          if (q.length < 2) {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, q, hits: [], pdfStatus }));
            return;
          }
          const pages = await listPages(doc);
          const translationHits: Hit[] = [];
          await Promise.all(
            pages.map(async ({ docId, pageId, abs, rel }) => {
              try {
                const source = await readFile(abs, 'utf8');
                const segs = extractPageSegments(source, pageId, rel);
                translationHits.push(...matchSegments(segs, q, docId));
              } catch {
                // ignore unreadable page
              }
            }),
          );

          // Also search PDF original text for the translated pages in scope.
          // Hits come back with source:'original' and no element coords.
          // Restrict to pages that actually exist as translated pages (an
          // untranslated page isn't navigable, so an original hit there would
          // be a dead link) and suppress originals on a page that already has
          // a translation hit — translation hits scroll to the exact span.
          const docsInScope = doc
            ? [doc]
            : Array.from(new Set(pages.map((p) => p.docId)));
          const originalHits: Hit[] = [];
          for (const docId of docsInScope) {
            const pdfPages = pdfIndex.getPages(docId);
            if (!pdfPages) continue;
            const docPageIds = new Set(
              pages.filter((p) => p.docId === docId).map((p) => p.pageId),
            );
            const translatedHitPages = new Set(
              translationHits
                .filter((h) => h.docId === docId)
                .map((h) => h.pageId),
            );
            for (const [pageId, text] of Object.entries(pdfPages)) {
              if (!docPageIds.has(pageId)) continue;
              if (translatedHitPages.has(pageId)) continue;
              originalHits.push(...searchOriginalText(text, q, docId, pageId));
            }
          }

          const allHits = sortHits([...translationHits, ...originalHits]);
          const capped = allHits.slice(0, SEARCH_HIT_CAP);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              ok: true,
              q,
              hits: capped,
              truncated: allHits.length > capped.length,
              pdfStatus,
            }),
          );
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
    },
  };
}
