// Node-only: parse a page's TSX and extract its searchable text nodes as
// TranslationSegments. Uses @babel/* and so must never reach the browser
// bundle — only search-api.ts (dev server) and build-search-index.ts (build)
// import it. Matching lives in the browser-safe search-core.ts.

import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';
import type { TranslationSegment } from './search-core';

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

/**
 * Parse one page's source and return one segment per searchable text node
 * (JSXText, plus string literals used directly as a JSX child expression),
 * resolved to the smallest enclosing JSX element's opening-tag coordinates.
 * Those coordinates match the `data-src-line/col` attributes injectSourceAttrs
 * stamps onto the same elements, so a hit can be resolved back to a DOM node.
 * Returns [] on a parse error (a half-typed page shouldn't break search).
 */
export function extractPageSegments(
  source: string,
  pageId: string,
  file: string,
): TranslationSegment[] {
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

  const segments: TranslationSegment[] = [];
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
    if (!text || text.trim() === '') return;
    const el = smallestJsxElement(parents);
    const loc = el?.openingElement.loc;
    if (!el || !loc) return;
    segments.push({
      pageId,
      file,
      elementLine: loc.start.line,
      elementCol: loc.start.column,
      elementTag: elementTag(el),
      text,
    });
  });
  return segments;
}
