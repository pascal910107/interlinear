import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';
import type { Plugin } from 'vite';

// --- Marker codec ---

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function newCommentId(): string {
  return `c-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

// --- AST traversal ---

type JsxContainer = t.JSXElement | t.JSXFragment;

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
    if (t.isJSXElement(n) || t.isJSXFragment(n)) visit(n);
    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      recurse((n as unknown as Record<string, unknown>)[key]);
    }
  };
  recurse(ast);
}

function findJsxAncestors(ast: t.Node, line: number, column: number): JsxContainer[] {
  const hits: { node: JsxContainer; size: number }[] = [];
  walkJsx(ast, (n) => {
    if (!n.loc) return;
    if (!t.isJSXElement(n) && !t.isJSXFragment(n)) return;
    const s = n.loc.start;
    const e = n.loc.end;
    const afterStart = line > s.line || (line === s.line && column >= s.column);
    const beforeEnd = line < e.line || (line === e.line && column < e.column);
    if (afterStart && beforeEnd) {
      hits.push({ node: n, size: (n.end ?? 0) - (n.start ?? 0) });
    }
  });
  hits.sort((a, b) => a.size - b.size);
  return hits.map((h) => h.node);
}

function lineToOffset(source: string, line: number): number {
  let off = 0;
  for (let l = 1; l < line; l++) {
    const nl = source.indexOf('\n', off);
    if (nl === -1) return source.length;
    off = nl + 1;
  }
  return off;
}

function lineIndent(source: string, lineNumber: number): string {
  const start = lineToOffset(source, lineNumber);
  const m = source.slice(start, start + 200).match(/^[ \t]*/);
  return m?.[0] ?? '';
}

type InsertionPlan = { offset: number; indent: string };

function planInsertion(source: string, target: JsxContainer): InsertionPlan | null {
  if (t.isJSXFragment(target)) {
    const opening = target.openingFragment;
    const startLine = target.loc?.start.line ?? 1;
    return { offset: opening.end ?? 0, indent: `${lineIndent(source, startLine)}  ` };
  }
  if (t.isJSXElement(target)) {
    const opening = target.openingElement;
    if (opening.selfClosing) return null;
    const startLine = target.loc?.start.line ?? 1;
    return { offset: opening.end ?? 0, indent: `${lineIndent(source, startLine)}  ` };
  }
  return null;
}

function findInsertion(source: string, line: number, column: number): InsertionPlan | null {
  try {
    const ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
    const ancestors = findJsxAncestors(ast as unknown as t.Node, line, column);
    for (const node of ancestors) {
      const plan = planInsertion(source, node);
      if (plan) return plan;
    }
    return null;
  } catch {
    return null;
  }
}

// --- The Vite plugin ---

export type ApplyCommentOptions = {
  /** Root containing all docs. `file` paths are relative to this. */
  docsRoot: string;
};

export function applyCommentEndpoint({ docsRoot }: ApplyCommentOptions): Plugin {
  return {
    name: 'interlinear-apply-comment',
    configureServer(server) {
      server.middlewares.use('/__apply_comment', async (req, res) => {
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
            const { file, line, col, note, hint } = JSON.parse(body) as {
              file: string;
              line: number;
              col: number;
              note: string;
              hint?: string;
            };

            const target = resolve(docsRoot, file);
            if (!target.startsWith(`${docsRoot}/`) && target !== docsRoot) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: 'path escapes docs root' }));
              return;
            }

            const source = await readFile(target, 'utf8');
            const plan = findInsertion(source, line, col);
            if (!plan) {
              res.statusCode = 422;
              res.end(JSON.stringify({ ok: false, error: 'no insertable JSX container found' }));
              return;
            }

            const id = newCommentId();
            const ts = new Date().toISOString();
            const text = b64urlEncode(JSON.stringify({ note, ...(hint ? { hint } : {}) }));
            const marker = `\n${plan.indent}{/* @page-comment id="${id}" ts="${ts}" text="${text}" */}`;

            const next = source.slice(0, plan.offset) + marker + source.slice(plan.offset);
            await writeFile(target, next, 'utf8');

            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, id, file, line, col }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}
