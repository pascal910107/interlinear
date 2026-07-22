// Node-only: assemble a per-doc static search index at build time. Emitted to
// <outDir>/<docId>/search-index.json by the vite plugin's writeBundle hook and
// fetched client-side by SearchBar in the production reader.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractPageSegments } from './search-extract';
import {
  SEARCH_INDEX_VERSION,
  type SearchIndex,
  type TranslationSegment,
} from './search-core';

const ORIGINAL_TEXT_REL = path.join('.interlinear', 'original-text.json');

export type IndexPage = {
  /** pageId, e.g. "page-0007". */
  id: string;
  /** Absolute path to the page's index.tsx. */
  abs: string;
  /** Path relative to docsRoot — matches injectSourceAttrs' data-src-file. */
  rel: string;
};

export type BuildSearchIndexInput = {
  docId: string;
  /** Absolute path to the doc directory (where .interlinear/ lives). */
  docDir: string;
  pages: IndexPage[];
};

/**
 * Load the original PDF text cache (written by the dev pdf-text-index) and
 * keep only the entries for pages that actually exist as translated pages —
 * untranslated pages aren't navigable in the reader, so an original hit on
 * one would be a dead link. Returns [] if the cache is absent (e.g. a doc
 * with no sourcePdf, or one whose dev server never ran an extraction).
 */
async function loadOriginalPages(
  docDir: string,
  pageIds: Set<string>,
): Promise<{ pageId: string; text: string }[]> {
  const fp = path.resolve(docDir, ORIGINAL_TEXT_REL);
  if (!existsSync(fp)) return [];
  try {
    const raw = JSON.parse(await readFile(fp, 'utf8')) as unknown;
    const pages =
      raw && typeof raw === 'object'
        ? (raw as { pages?: Record<string, string> }).pages
        : undefined;
    if (!pages || typeof pages !== 'object') return [];
    const out: { pageId: string; text: string }[] = [];
    for (const [pageId, text] of Object.entries(pages)) {
      if (!pageIds.has(pageId)) continue;
      if (typeof text !== 'string' || text.trim() === '') continue;
      out.push({ pageId, text });
    }
    out.sort((a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0));
    return out;
  } catch {
    return [];
  }
}

export async function buildSearchIndex(
  input: BuildSearchIndexInput,
): Promise<SearchIndex> {
  const { docId, docDir, pages } = input;
  const translationSegments: TranslationSegment[] = [];
  // Sorted for determinism so the emitted JSON is stable across builds.
  const sortedPages = [...pages].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const page of sortedPages) {
    let source: string;
    try {
      source = await readFile(page.abs, 'utf8');
    } catch {
      continue; // unreadable page — skip, don't fail the whole build
    }
    translationSegments.push(
      ...extractPageSegments(source, page.id, page.rel),
    );
  }
  const pageIds = new Set(pages.map((p) => p.id));
  const originalPages = await loadOriginalPages(docDir, pageIds);
  return {
    version: SEARCH_INDEX_VERSION,
    docId,
    translationSegments,
    originalPages,
  };
}
