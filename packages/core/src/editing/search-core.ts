// Browser-safe search core. Shared by the dev /__search endpoint
// (search-api.ts, Node) and the production static reader (SearchBar.tsx,
// browser). MUST NOT import node:*, fast-glob, or @babel/* — anything that
// can't be bundled for the browser. Parsing/extraction lives in the
// Node-only search-extract.ts; this file only matches already-extracted
// text, so both the live dev path and the prebuilt static index share one
// matcher and can never drift.

export const SEARCH_INDEX_VERSION = 1;
// Cap total hits per query, matching the historical /__search behaviour.
export const SEARCH_HIT_CAP = 200;

export type Hit = {
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
  /**
   * Whether the match looks like a section heading (the canonical target a
   * cross-reference points at) or ordinary body text. Drives the client's
   * confident auto-jump: a unique "heading" hit wins.
   */
  kind: 'heading' | 'body';
};

/**
 * One searchable text node extracted from a page's TSX, resolved to its
 * smallest enclosing JSX element. Produced at build time (or, in dev, per
 * request) by search-extract.ts and matched here.
 */
export type TranslationSegment = {
  pageId: string;
  file: string;
  elementLine: number;
  elementCol: number;
  elementTag: string | null;
  text: string;
};

/** Prebuilt, per-doc static search index shipped alongside a production build. */
export type SearchIndex = {
  version: number;
  docId: string;
  translationSegments: TranslationSegment[];
  /** Plain PDF text for the translated pages only (untranslated pages aren't
   *  navigable, so indexing them would produce dead-link hits). */
  originalPages: { pageId: string; text: string }[];
};

export type SearchResult = { hits: Hit[]; truncated: boolean };

// JSXText preserves source whitespace verbatim — line breaks and indentation
// between siblings end up inside one text node as "\n        ". A query like
// "to display the debug message" written with normal single spaces would
// fail to match across that whitespace run. Build a normalized form that
// collapses each whitespace run to a single ' ', plus an index map back to
// the original so we can still produce a faithful snippet.
export function normalizeWhitespace(text: string): {
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

export function makeSnippet(
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

/**
 * Find every occurrence of `q` across pre-extracted translation segments and
 * emit one Hit per occurrence. This is exactly the inner loop the dev
 * /__search endpoint used to run inline while walking each page's AST — now
 * split out so a build-time index can be searched client-side with identical
 * results.
 */
export function matchSegments(
  segments: readonly TranslationSegment[],
  q: string,
  docId: string,
): Hit[] {
  const qNorm = q.replace(/\s+/g, ' ').trim();
  if (qNorm.length === 0) return [];
  const qLower = qNorm.toLowerCase();
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    if (!seg.text) continue;
    const { normalized, mapping } = normalizeWhitespace(seg.text);
    const lower = normalized.toLowerCase();
    let nIdx = lower.indexOf(qLower);
    while (nIdx >= 0) {
      const origStart = mapping[nIdx];
      // Last mapping entry is text.length, so this is safe for matches that
      // run all the way to the end of the normalized form.
      const origEnd = mapping[nIdx + qLower.length];
      const origLen = origEnd - origStart;
      // Include `file` so the dedup is scoped per page: matchSegments runs
      // over one page at a time in dev but over the whole doc at once in the
      // prod static path, and two pages can share an element at the same
      // line:col:offset — without `file` the second page's hit would be lost.
      const key = `${seg.file}:${seg.elementLine}:${seg.elementCol}:${origStart}`;
      if (!seen.has(key)) {
        seen.add(key);
        const snip = makeSnippet(seg.text, origStart, origLen);
        const tag = seg.elementTag;
        hits.push({
          docId,
          pageId: seg.pageId,
          file: seg.file,
          elementLine: seg.elementLine,
          elementCol: seg.elementCol,
          elementTag: tag,
          ...snip,
          source: 'translation',
          kind: tag != null && /^h[1-6]$/i.test(tag) ? 'heading' : 'body',
        });
      }
      nIdx = lower.indexOf(qLower, nIdx + Math.max(1, qLower.length));
    }
  }
  return hits;
}

// Table-of-contents lines look like "Section title . . . . . . . . 42" or
// "Section title          42". They match every heading-shaped query, which
// buries the real target page and breaks auto-jump. Detected via a dot-leader
// run or a "title<gap>page-number" trailing on the line — never a jump target.
const TOC_LEADER_RE = /(?:\.\s+){4,}|(?:\s+\.){4,}/;
const TOC_TRAILING_PAGENO_RE = /(?:[ \t]{2,}|\t)\d{1,4}$/;

// A section heading sits on its own line, optionally behind a section number
// ("5.2", "Chapter 5", "Appendix A."). Strip that prefix (and any trailing
// punctuation) so we can ask "is this line *just* the title?".
const SECTION_PREFIX_RE =
  /^(?:chapter|section|appendix|part)?\s*\d+(?:[.\-]\d+)*[.)]?\s+/i;

// Pull the full source line containing index `idx` out of the raw page text.
// PyMuPDF's "text" extraction preserves newlines between blocks, so a line is
// a meaningful unit here.
function lineAround(text: string, idx: number): string {
  const start = text.lastIndexOf('\n', idx - 1) + 1;
  let end = text.indexOf('\n', idx);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

// Classify the line a match landed on, relative to the (normalized, lowercase)
// query:
//   "toc"     — dot-leader or trailing page number; never a jump target.
//   "heading" — the line is essentially just the title; the canonical section
//               a cross-reference wants to land on.
//   "body"    — the phrase is embedded in running prose.
function classifyOriginalLine(
  line: string,
  qLower: string,
): 'toc' | 'heading' | 'body' {
  const trimmed = line.trim();
  if (TOC_LEADER_RE.test(line) || TOC_TRAILING_PAGENO_RE.test(trimmed)) {
    return 'toc';
  }
  const core = trimmed
    .replace(SECTION_PREFIX_RE, '')
    .replace(/[.,:;)\]]+$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return core === qLower ? 'heading' : 'body';
}

/**
 * Search the plain text of one PDF page for the query (same whitespace-
 * tolerant, case-insensitive match as the JSXText scanner). Original-text
 * hits have no JSX element coords — clicking jumps to the page top so the
 * user can use the rendered translation + the original PNG to find the
 * section themselves. At most one hit per page: prefer a heading-like line
 * over a body mention, and skip table-of-contents lines entirely.
 */
export function searchOriginalText(
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
  let best: {
    origStart: number;
    origLen: number;
    kind: 'heading' | 'body';
  } | null = null;
  let nIdx = lower.indexOf(qLower);
  while (nIdx >= 0) {
    const origStart = mapping[nIdx];
    const origEnd = mapping[nIdx + qLower.length];
    const origLen = origEnd - origStart;
    const cls = classifyOriginalLine(lineAround(pageText, origStart), qLower);
    if (cls === 'heading') {
      best = { origStart, origLen, kind: 'heading' };
      break; // best possible on this page — stop scanning.
    }
    if (cls === 'body' && !best) {
      best = { origStart, origLen, kind: 'body' };
    }
    nIdx = lower.indexOf(qLower, nIdx + Math.max(1, qLower.length));
  }
  if (!best) return [];
  const snip = makeSnippet(pageText, best.origStart, best.origLen);
  return [
    {
      docId,
      pageId,
      file: '',
      elementLine: 0,
      elementCol: 0,
      elementTag: null,
      ...snip,
      source: 'original',
      kind: best.kind,
    },
  ];
}

/** Stable ordering: by page, translation hits before originals, then by line. */
export function sortHits(hits: Hit[]): Hit[] {
  return hits.sort((a, b) => {
    if (a.docId !== b.docId) return a.docId < b.docId ? -1 : 1;
    if (a.pageId !== b.pageId) return a.pageId < b.pageId ? -1 : 1;
    if (a.source !== b.source) return a.source === 'translation' ? -1 : 1;
    return a.elementLine - b.elementLine;
  });
}

/**
 * Run a query over a prebuilt per-doc index. Mirrors the dev endpoint:
 * translation hits win, original-text hits are suppressed on any page that
 * already produced a translation hit, and the combined list is sorted and
 * capped.
 */
export function searchIndex(index: SearchIndex, q: string): SearchResult {
  if (q.trim().length < 2) return { hits: [], truncated: false };
  const translationHits = matchSegments(index.translationSegments, q, index.docId);
  const translatedHitPages = new Set(translationHits.map((h) => h.pageId));
  const originalHits: Hit[] = [];
  for (const { pageId, text } of index.originalPages) {
    if (translatedHitPages.has(pageId)) continue;
    originalHits.push(...searchOriginalText(text, q, index.docId, pageId));
  }
  const all = sortHits([...translationHits, ...originalHits]);
  const capped = all.slice(0, SEARCH_HIT_CAP);
  return { hits: capped, truncated: all.length > capped.length };
}
