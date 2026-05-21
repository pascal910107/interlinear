import * as t from '@babel/types';
import { relative } from 'node:path';

type Opts = { root: string };

// Match a leading-slash URL with at least two segments: /<first>/<rest>.
const DOC_PREFIXED_URL = /^\/([^/]+)\/(.+)$/;
// Attributes whose value names a doc-local asset URL. Keep tight: only
// known asset-bearing props so we don't trash unrelated string props.
const ASSET_ATTRS = new Set(['src', 'originalSrc', 'href', 'poster']);

// Lightweight babel plugin: adds data-src-{file,line,col} attributes to every
// JSX opening element in dev so the in-browser inspector can resolve the
// clicked DOM node back to its TSX source location.
//
// Also emits `data-src-editable="true"` when the parent JSXElement has
// exactly one meaningful child and it is a JSXText. The inspector reads
// this attribute at click time to decide whether to offer inline-edit; it
// mirrors apply-edit.ts's server-side acceptance predicate, so the textarea
// no longer appears for `<td>{cell}</td>` and friends that would 422 on save.
export function injectSourceAttrs(_babel: unknown) {
  return {
    name: 'interlinear-inject-source-attrs',
    visitor: {
      JSXOpeningElement(
        path: { node: t.JSXOpeningElement; parent: t.Node },
        state: { filename?: string; opts: Opts },
      ) {
        if (path.node.name.type !== 'JSXIdentifier') return;
        const loc = path.node.loc;
        const filename = state.filename;
        if (!loc || !filename) return;

        const already = path.node.attributes.some(
          (a) =>
            a.type === 'JSXAttribute' &&
            a.name.type === 'JSXIdentifier' &&
            a.name.name === 'data-src-line',
        );
        if (already) return;

        const rel = relative(state.opts.root, filename);

        let editable = false;
        const parent = path.parent;
        if (
          parent &&
          parent.type === 'JSXElement' &&
          !path.node.selfClosing
        ) {
          const meaningful = parent.children.filter(
            (c) => !(c.type === 'JSXText' && c.value.trim() === ''),
          );
          if (meaningful.length === 1 && meaningful[0].type === 'JSXText') {
            editable = true;
          }
        }

        path.node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier('data-src-file'), t.stringLiteral(rel)),
          t.jsxAttribute(t.jsxIdentifier('data-src-line'), t.stringLiteral(String(loc.start.line))),
          t.jsxAttribute(t.jsxIdentifier('data-src-col'), t.stringLiteral(String(loc.start.column))),
        );
        if (editable) {
          path.node.attributes.push(
            t.jsxAttribute(t.jsxIdentifier('data-src-editable'), t.stringLiteral('true')),
          );
        }

        // Doc-id-aware asset URL rewriting. `data-src-file` is e.g.
        // `<docId>/pages/<pageId>/index.tsx`, so the first path segment is
        // the doc id this file currently lives under. Any string-literal
        // src/href/originalSrc/poster value of the form `/<x>/<rest>` is
        // rewritten so `<x>` is replaced with the current doc id — that
        // way, renaming the doc directory doesn't break the asset URLs
        // baked into pages.
        const docId = rel.split('/')[0] ?? '';
        if (docId) {
          for (const attr of path.node.attributes) {
            if (attr.type !== 'JSXAttribute') continue;
            if (attr.name.type !== 'JSXIdentifier') continue;
            if (!ASSET_ATTRS.has(attr.name.name)) continue;
            if (!attr.value || attr.value.type !== 'StringLiteral') continue;
            const m = DOC_PREFIXED_URL.exec(attr.value.value);
            if (!m) continue;
            if (m[1] === docId) continue;
            attr.value = t.stringLiteral(`/${docId}/${m[2]}`);
          }
        }
      },
    },
  };
}
