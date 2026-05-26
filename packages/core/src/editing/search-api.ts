import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';
import fg from 'fast-glob';
import type { Plugin } from 'vite';
import { loadDocConfig } from './load-doc-config';
import {
  createPdfTextIndex,
  type PdfIndexState,
  type PdfTextIndex,
} from './pdf-text-index';

const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'type',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);

function walk(ast: unknown, visit: (n: t.Node, parents: t.Node[]) => void): void {
  const stack: t.Node[] = [];
  const recurse = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const c of node) recurse(c);
      return;
    }
    const n = node as t.Node;
    if (typeof n.type !== 'string') return;
    visit(n, stack);
    stack.push(n);
    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      recurse((n as unknown as Record<string, unknown>)[key]);
    }
    stack.pop();
  };
  recurse(ast);
}

type Hit = {
  docId: string;
  pageId: string;
  file: string;
  elementLine: number;
  elementCol: number;
  elementTag: string | null;
  snippet: string;
  snippetMatchStart: number;
  snippetMatchLength: number;
  /**
   * Where the match was found:
   *   "translation" — JSXText inside the rendered page (has element coords).
   *   "original"    — plain text from the source PDF, no element coords;
   *                   jump scrolls to the page top instead of a specific
   *                   span. Used for cross-references where the English
   *                   heading was translated and only survives in the PDF.
   */
  source: 'translation' | 'original';
};

function makeSnippet(
  haystack: string,
  matchStart: number,
  matchLen: number,
): { snippet: string; snippetMatchStart: number; snippetMatchLength: number } {
  const PAD = 40;
  const left = haystack.slice(Math.max(0, matchStart - PAD), matchStart);
  const middle = haystack.slice(matchStart, matchStart + matchLen);
  const right = haystack.slice(matchStart + matchLen, matchStart + matchLen + PAD);
  const leftClean = left.replace(/\s+/g, ' ');
  const middleClean = middle.replace(/\s+/g, ' ');
  const rightClean = right.replace(/\s+/g, ' ');
  const leftEllipsis = matchStart > PAD ? '… ' : '';
  const rightEllipsis = matchStart + matchLen + PAD < haystack.length ? ' …' : '';
  const snippet = leftEllipsis + leftClean + middleClean + rightClean + rightEllipsis;
  return {
    snippet,
    snippetMatchStart: leftEllipsis.length + leftClean.length,
    snippetMatchLength: middleClean.length,
  };
}

// JSXText preserves source whitespace verbatim — line breaks and indentation
// between siblings end up inside one text node as "\n        ". A query like
// "to display the debug message" written with normal single spaces would
// fail to match across that whitespace run. Build a normalized form that
// collapses each whitespace run to a single ' ', plus an index map back to
// the original so we can still produce a faithful snippet.
function normalizeWhitespace(text: string): {
  normalized: string;
  // mapping[i] = original index for normalized index i.
  // mapping has length normalized.length + 1; the trailing entry is
  // text.length so a match at the end has a well-defined end-pointer.
  mapping: number[];
} {
  const chars: string[] = [];
  const mapping: number[] = [];
  let prevWasSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isSpace = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
    if (isSpace) {
      if (!prevWasSpace) {
        chars.push(' ');
        mapping.push(i);
      }
      prevWasSpace = true;
    } else {
      chars.push(ch);
      mapping.push(i);
      prevWasSpace = false;
    }
  }
  mapping.push(text.length);
  return { normalized: chars.join(''), mapping };
}

function smallestJsxElement(parents: t.Node[]): t.JSXElement | null {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i];
    if (t.isJSXElement(p)) return p;
  }
  return null;
}

function elementTag(el: t.JSXElement): string | null {
  const name = el.openingElement.name;
  return name.type === 'JSXIdentifier' ? name.name : null;
}

function searchPageSource(
  source: string,
  q: string,
  docId: string,
  pageId: string,
  file: string,
): Hit[] {
  let ast: t.Node;
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    }) as unknown as t.Node;
  } catch {
    return [];
  }

  // Collapse query whitespace too so e.g. a pasted multi-line phrase still
  // matches the normalized JSXText.
  const qNorm = q.replace(/\s+/g, ' ').trim();
  if (qNorm.length === 0) return [];
  const qLower = qNorm.toLowerCase();
  const hits: Hit[] = [];
  const seen = new Set<string>();

  walk(ast, (node, parents) => {
    let text: string | null = null;
    if (t.isJSXText(node)) {
      text = node.value;
    } else if (t.isStringLiteral(node)) {
      const parent = parents[parents.length - 1];
      if (parent && t.isJSXExpressionContainer(parent)) {
        const grand = parents[parents.length - 2];
        if (grand && t.isJSXElement(grand)) {
          text = node.value;
        }
      }
    } else {
      return;
    }
    if (!text) return;
    if (text.trim() === '') return;
    const { normalized, mapping } = normalizeWhitespace(text);
    const lower = normalized.toLowerCase();
    let nIdx = lower.indexOf(qLower);
    while (nIdx >= 0) {
      const el = smallestJsxElement(parents);
      if (el?.openingElement.loc) {
        const loc = el.openingElement.loc.start;
        const origStart = mapping[nIdx];
        // Last mapping entry is text.length, so this is safe for matches
        // that run all the way to the end of the normalized form.
        const origEnd = mapping[nIdx + qLower.length];
        const origLen = origEnd - origStart;
        const key = `${loc.line}:${loc.column}:${origStart}`;
        if (!seen.has(key)) {
          seen.add(key);
          const snip = makeSnippet(text, origStart, origLen);
          hits.push({
            docId,
            pageId,
            file,
            elementLine: loc.line,
            elementCol: loc.column,
            elementTag: elementTag(el),
            ...snip,
            source: 'translation',
          });
        }
      }
      nIdx = lower.indexOf(qLower, nIdx + Math.max(1, qLower.length));
    }
  });

  return hits;
}

// Table-of-contents lines look like "Section title . . . . . . . . 42".
// They almost always match every heading-shaped query, which buries the
// real target page and breaks auto-jump (the unique off-page hit). Detect
// the dot-leader pattern around the matched span and drop those hits.
const TOC_LEADER_RE = /(?:\.\s+){4,}|(?:\s+\.){4,}/;

// Search the plain text of one PDF page for the query (same whitespace-
// tolerant, case-insensitive match as the JSXText scanner). Original-text
// hits have no JSX element coords — clicking jumps to the page top so the
// user can use the rendered translation + the original PNG to find the
// section themselves.
function searchOriginalText(
  pageText: string,
  q: string,
  docId: string,
  pageId: string,
): Hit[] {
  const qNorm = q.replace(/\s+/g, ' ').trim();
  if (qNorm.length === 0) return [];
  const qLower = qNorm.toLowerCase();
  const { normalized, mapping } = normalizeWhitespace(pageText);
  const lower = normalized.toLowerCase();
  const hits: Hit[] = [];
  let nIdx = lower.indexOf(qLower);
  while (nIdx >= 0) {
    const origStart = mapping[nIdx];
    const origEnd = mapping[nIdx + qLower.length];
    const origLen = origEnd - origStart;
    // Look at the ~120 chars surrounding the match on the original text
    // (not the cleaned snippet — we need the raw spacing). If it carries
    // a ToC dot-leader, skip and keep looking later in the page for a
    // body hit.
    const ctxStart = Math.max(0, origStart - 60);
    const ctxEnd = Math.min(pageText.length, origStart + origLen + 60);
    const context = pageText.slice(ctxStart, ctxEnd);
    if (TOC_LEADER_RE.test(context)) {
      nIdx = lower.indexOf(qLower, nIdx + Math.max(1, qLower.length));
      continue;
    }
    const snip = makeSnippet(pageText, origStart, origLen);
    hits.push({
      docId,
      pageId,
      file: '',
      elementLine: 0,
      elementCol: 0,
      elementTag: null,
      ...snip,
      source: 'original',
    });
    // One hit per page from the original is plenty — additional hits on
    // the same page would all jump to the same top-of-page target.
    break;
  }
  return hits;
}

export type SearchApiOptions = {
  /** Root containing all docs. */
  docsRoot: string;
  /** pagesDir inside each doc. Defaults to "pages". */
  pagesDir?: string;
};

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
          const allHits: Hit[] = [];
          await Promise.all(
            pages.map(async ({ docId, pageId, abs, rel }) => {
              try {
                const source = await readFile(abs, 'utf8');
                const hits = searchPageSource(source, q, docId, pageId, rel);
                allHits.push(...hits);
              } catch {
                // ignore unreadable page
              }
            }),
          );

          // Also search PDF original text for every doc in scope. Hits
          // come back with source:'original' and no element coords.
          // Suppress originals on a page that already has a translation
          // hit for the same query — translation hits are strictly more
          // useful (they scroll to the exact span).
          const docsInScope = doc
            ? [doc]
            : Array.from(new Set(pages.map((p) => p.docId)));
          for (const docId of docsInScope) {
            const pdfPages = pdfIndex.getPages(docId);
            if (!pdfPages) continue;
            const translatedHitPages = new Set(
              allHits.filter((h) => h.docId === docId).map((h) => h.pageId),
            );
            for (const [pageId, text] of Object.entries(pdfPages)) {
              if (translatedHitPages.has(pageId)) continue;
              const origHits = searchOriginalText(text, q, docId, pageId);
              allHits.push(...origHits);
            }
          }

          allHits.sort((a, b) => {
            if (a.docId !== b.docId) return a.docId < b.docId ? -1 : 1;
            if (a.pageId !== b.pageId) return a.pageId < b.pageId ? -1 : 1;
            // Translation hits before originals on the same page (in
            // practice we suppress same-page duplicates above, so this
            // only matters across pages).
            if (a.source !== b.source) return a.source === 'translation' ? -1 : 1;
            return a.elementLine - b.elementLine;
          });
          const capped = allHits.slice(0, 200);
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
