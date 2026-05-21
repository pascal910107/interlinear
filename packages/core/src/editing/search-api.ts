import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';
import fg from 'fast-glob';
import type { Plugin } from 'vite';

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
  const rightClean = right.replace(/\s+/g, ' ');
  const leftEllipsis = matchStart > PAD ? '… ' : '';
  const rightEllipsis = matchStart + matchLen + PAD < haystack.length ? ' …' : '';
  const snippet = leftEllipsis + leftClean + middle + rightClean + rightEllipsis;
  return {
    snippet,
    snippetMatchStart: leftEllipsis.length + leftClean.length,
    snippetMatchLength: middle.length,
  };
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

  const qLower = q.toLowerCase();
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
    const lower = text.toLowerCase();
    let idx = lower.indexOf(qLower);
    while (idx >= 0) {
      const el = smallestJsxElement(parents);
      if (el?.openingElement.loc) {
        const loc = el.openingElement.loc.start;
        const key = `${loc.line}:${loc.column}:${idx}`;
        if (!seen.has(key)) {
          seen.add(key);
          const snip = makeSnippet(text, idx, qLower.length);
          hits.push({
            docId,
            pageId,
            file,
            elementLine: loc.line,
            elementCol: loc.column,
            elementTag: elementTag(el),
            ...snip,
          });
        }
      }
      idx = lower.indexOf(qLower, idx + Math.max(1, qLower.length));
    }
  });

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

  return {
    name: 'interlinear-search-api',
    configureServer(server) {
      server.middlewares.use('/__search', async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://x');
          const q = url.searchParams.get('q')?.trim() ?? '';
          const doc = url.searchParams.get('doc')?.trim() || null;
          if (q.length < 2) {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, q, hits: [] }));
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
          allHits.sort((a, b) => {
            if (a.docId !== b.docId) return a.docId < b.docId ? -1 : 1;
            if (a.pageId !== b.pageId) return a.pageId < b.pageId ? -1 : 1;
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
