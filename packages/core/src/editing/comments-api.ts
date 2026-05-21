import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as fs from 'node:fs/promises';
import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';
import type { Plugin } from 'vite';

const MARKER_RE =
  /\{\/\*\s*@page-comment\s+id="(c-[a-f0-9]+)"\s+ts="([^"]+)"\s+text="([A-Za-z0-9_-]+={0,2})"\s*\*\/\}/g;

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

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

type Comment = {
  id: string;
  ts: string;
  note: string;
  hint?: string;
  // Location of the marker line itself in the source
  markerLine: number;
  // Identity of the enclosing JSX element (what the marker is "about")
  elementLine: number | null;
  elementCol: number | null;
  elementTag: string | null;
};

function parseComments(source: string): Comment[] {
  const out: Comment[] = [];
  const lines = source.split('\n');

  // First pass: find marker lines via regex
  const markerLines: Array<{ id: string; ts: string; note: string; hint?: string; line: number }> =
    [];
  for (let i = 0; i < lines.length; i++) {
    MARKER_RE.lastIndex = 0;
    const m = MARKER_RE.exec(lines[i]);
    if (!m) continue;
    const [, id, ts, textB64] = m;
    try {
      const payload = JSON.parse(b64urlDecode(textB64)) as { note: string; hint?: string };
      markerLines.push({ id, ts, note: payload.note, hint: payload.hint, line: i + 1 });
    } catch {
      // skip malformed
    }
  }

  if (markerLines.length === 0) return out;

  // Second pass: parse AST so we can locate enclosing JSXElement of each marker
  let ast: t.Node | null = null;
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    }) as unknown as t.Node;
  } catch {
    // If parse fails, still return markers with no element identity
    return markerLines.map((m) => ({
      ...m,
      markerLine: m.line,
      elementLine: null,
      elementCol: null,
      elementTag: null,
    }));
  }

  // Build a list of JSXElement-with-loc for matching
  const elements: t.JSXElement[] = [];
  walk(ast, (n) => {
    if (
      t.isJSXElement(n) &&
      n.openingElement.end != null &&
      n.closingElement?.start != null
    ) {
      elements.push(n);
    }
  });

  // Precompute byte offset of each marker line's start (offset to the `{` of the marker)
  const lineOffsets: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineOffsets.push(i + 1);
  }
  function markerOffset(mLine: number): number {
    const lineStart = lineOffsets[mLine - 1] ?? 0;
    const idx = source.indexOf('{/*', lineStart);
    return idx >= 0 ? idx : lineStart;
  }

  for (const m of markerLines) {
    const mOff = markerOffset(m.line);
    // Smallest JSXElement whose [opening.end, closing.start) range contains mOff.
    let best: t.JSXElement | null = null;
    for (const el of elements) {
      const oStart = el.openingElement.end!;
      const cStart = el.closingElement!.start!;
      if (mOff >= oStart && mOff < cStart) {
        if (!best || cStart - oStart < best.closingElement!.start! - best.openingElement.end!) {
          best = el;
        }
      }
    }
    const openLoc = best?.openingElement.loc?.start ?? null;
    out.push({
      id: m.id,
      ts: m.ts,
      note: m.note,
      hint: m.hint,
      markerLine: m.line,
      elementLine: openLoc?.line ?? null,
      elementCol: openLoc?.column ?? null,
      elementTag:
        best && best.openingElement.name.type === 'JSXIdentifier'
          ? best.openingElement.name.name
          : null,
    });
  }

  return out;
}

export type CommentsApiOptions = { root: string };

export function commentsApiEndpoint({ root }: CommentsApiOptions): Plugin {
  async function resolveTarget(file: string): Promise<string | null> {
    const target = resolve(root, file);
    if (!target.startsWith(`${root}/`) && target !== root) return null;
    try {
      await fs.access(target);
    } catch {
      return null;
    }
    return target;
  }

  function reqBody(req: import('node:http').IncomingMessage): Promise<string> {
    return new Promise((res, rej) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => res(body));
      req.on('error', rej);
    });
  }

  return {
    name: 'interlinear-comments-api',
    configureServer(server) {
      server.middlewares.use('/__list_comments', async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://x');
          const file = url.searchParams.get('file');
          if (!file) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'file required' }));
            return;
          }
          const target = await resolveTarget(file);
          if (!target) {
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: 'file not found' }));
            return;
          }
          const source = await readFile(target, 'utf8');
          const comments = parseComments(source);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, file, comments }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });

      server.middlewares.use('/__delete_comment', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        try {
          const body = await reqBody(req);
          const { file, id } = JSON.parse(body) as { file: string; id: string };
          const target = await resolveTarget(file);
          if (!target) {
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: 'file not found' }));
            return;
          }
          const source = await readFile(target, 'utf8');
          const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Match the whole marker line including its trailing newline.
          const lineRe = new RegExp(
            `^[ \\t]*\\{\\/\\*\\s*@page-comment\\s+id="${escapedId}"[^}]*\\}[ \\t]*\\r?\\n?`,
            'm',
          );
          if (!lineRe.test(source)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: 'marker not found' }));
            return;
          }
          const next = source.replace(lineRe, '');
          await writeFile(target, next, 'utf8');
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, file, id }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
    },
  };
}
