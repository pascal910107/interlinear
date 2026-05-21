import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';
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

function walkJsx(ast: unknown, visit: (n: t.Node) => void): void {
  const recurse = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const c of node) recurse(c);
      return;
    }
    const n = node as t.Node;
    if (typeof n.type !== 'string') return;
    if (t.isJSXElement(n)) visit(n);
    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      recurse((n as unknown as Record<string, unknown>)[key]);
    }
  };
  recurse(ast);
}

function findElementAt(ast: t.Node, line: number, column: number): t.JSXElement | null {
  let best: t.JSXElement | null = null;
  walkJsx(ast, (n) => {
    if (!t.isJSXElement(n) || !n.loc || !n.openingElement.loc) return;
    const s = n.openingElement.loc.start;
    if (s.line === line && s.column === column) {
      if (!best || (n.end ?? 0) - (n.start ?? 0) < (best.end ?? 0) - (best.start ?? 0)) {
        best = n;
      }
    }
  });
  return best;
}

export type ApplyEditOptions = {
  /** Root containing all docs. `file` paths are relative to this. */
  docsRoot: string;
};

export function applyEditEndpoint({ docsRoot }: ApplyEditOptions): Plugin {
  return {
    name: 'interlinear-apply-edit',
    configureServer(server) {
      server.middlewares.use('/__apply_edit', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const { file, line, col, text } = JSON.parse(body) as {
              file: string;
              line: number;
              col: number;
              text: string;
            };

            const target = resolve(docsRoot, file);
            if (!target.startsWith(`${docsRoot}/`) && target !== docsRoot) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: 'path escapes docs root' }));
              return;
            }

            const source = await readFile(target, 'utf8');
            const ast = babelParse(source, {
              sourceType: 'module',
              plugins: ['typescript', 'jsx'],
              errorRecovery: true,
            }) as unknown as t.Node;

            const el = findElementAt(ast, line, col);
            if (!el) {
              res.statusCode = 422;
              res.end(JSON.stringify({ ok: false, error: 'no JSX element at location' }));
              return;
            }
            if (el.openingElement.selfClosing) {
              res.statusCode = 422;
              res.end(JSON.stringify({ ok: false, error: 'self-closing element has no text' }));
              return;
            }

            const meaningful = el.children.filter(
              (c) => !(t.isJSXText(c) && c.value.trim() === ''),
            );
            if (meaningful.length !== 1 || !t.isJSXText(meaningful[0])) {
              res.statusCode = 422;
              res.end(
                JSON.stringify({
                  ok: false,
                  error: 'element has nested structure; use comment marker instead',
                }),
              );
              return;
            }

            const startOffset = el.openingElement.end ?? -1;
            const closingStart = el.closingElement?.start ?? -1;
            if (startOffset < 0 || closingStart < 0) {
              res.statusCode = 422;
              res.end(JSON.stringify({ ok: false, error: 'missing element bounds' }));
              return;
            }

            const existing = source.slice(startOffset, closingStart);
            const leading = existing.match(/^[\t\n\r ]*/)?.[0] ?? '';
            const trailing = existing.match(/[\t\n\r ]*$/)?.[0] ?? '';

            const replacement = `${leading}${text.trim()}${trailing}`;
            const next = source.slice(0, startOffset) + replacement + source.slice(closingStart);
            await writeFile(target, next, 'utf8');

            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file, line, col }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}
