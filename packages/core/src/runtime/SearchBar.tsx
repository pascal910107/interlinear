import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentPageId, useDoc } from './DocContext';
import { searchIndex, type Hit, type SearchIndex } from '../editing/search-core';

type PdfStatus = {
  state: 'idle' | 'extracting' | 'ready' | 'error';
  error?: string;
};

type Props = {
  /** Override hash routing if you're not using `#/d/<docId>/p/<pageId>`. */
  onGoToPage?: (pageId: string) => void;
};

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

function currentHashPageId(): string | null {
  const m = /^#\/d\/[^/]+\/p\/([^/?]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

function findByIdentity(file: string, line: number, col: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-src-file="${file}"][data-src-line="${line}"][data-src-col="${col}"]`,
  );
}

function flashElement(el: HTMLElement): void {
  const prev = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = '2px solid var(--color-accent)';
  el.style.outlineOffset = '2px';
  setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = prevOffset;
  }, 1200);
}

/**
 * Cross-page keyword search over both the translated JSX text and the
 * original PDF text. Press `f` (or click a cross-reference) to open; click a
 * hit to jump to its page, scroll the target element into view, and flash an
 * outline around it.
 *
 * Two data sources, one matcher (search-core.ts): in dev it queries the live
 * /__search endpoint (always reflects unsaved edits); the static production
 * reader lazy-fetches a prebuilt per-doc index and searches it client-side.
 */
export function SearchBar({ onGoToPage }: Props = {}) {
  const { id: docId } = useDoc();
  const currentPageId = useCurrentPageId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<PdfStatus>({ state: 'idle' });
  // Production reader only: the prebuilt per-doc index, lazy-fetched on first
  // open. Dev ignores this and uses the live /__search endpoint. SearchBar
  // remounts per doc (DocView is keyed by doc.id), so this never needs to
  // reset across docs within one instance.
  const indexRef = useRef<SearchIndex | null>(null);
  const [indexState, setIndexState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  // Latches true the first time search opens, then triggers the one-shot
  // index fetch below. Kept separate from `open` so closing the bar mid-load
  // doesn't cancel (and permanently strand) the in-flight fetch.
  const [shouldLoadIndex, setShouldLoadIndex] = useState(false);
  // When opened by a cross-reference click, auto-jump to the unique
  // off-page hit (if any) instead of forcing the user to click a result.
  // Cleared after each open so a manual reopen behaves normally.
  const autoJumpRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHits([]);
    setTruncated(false);
    setCursor(0);
    autoJumpRef.current = false;
  }, []);

  // Global `f` opens.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (open) return;
      if (e.key !== 'f') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Cross-reference clicks (from <XRef> inside translated prose) dispatch
  // an `interlinear:search` event with the quoted text. Open prefilled
  // and arm auto-jump for a unique off-page hit.
  useEffect(() => {
    function onXrefSearch(e: Event) {
      const detail = (e as CustomEvent<unknown>).detail;
      if (typeof detail !== 'string' || detail.trim() === '') return;
      autoJumpRef.current = true;
      setQuery(detail);
      setOpen(true);
    }
    window.addEventListener('interlinear:search', onXrefSearch);
    return () => window.removeEventListener('interlinear:search', onXrefSearch);
  }, []);

  // Focus input when opened.
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Arm the index load the first time search opens (prod reader only). Split
  // from the fetch effect so the fetch's lifecycle isn't tied to `open`.
  useEffect(() => {
    if (open) setShouldLoadIndex(true);
  }, [open]);

  // One-shot fetch of the prebuilt static index. Depends on shouldLoadIndex
  // (which only ever flips false→true) and docId, NOT on indexState — so
  // setting indexState here can't re-run the effect and cancel its own fetch.
  // `alive` guards only against a real unmount / doc switch.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    if (!shouldLoadIndex) return;
    let alive = true;
    setIndexState('loading');
    fetch(`/${encodeURIComponent(docId)}/search-index.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: SearchIndex) => {
        if (!alive) return;
        indexRef.current = data;
        setIndexState('ready');
      })
      .catch(() => {
        if (alive) setIndexState('error');
      });
    return () => {
      alive = false;
    };
  }, [shouldLoadIndex, docId]);

  // Debounced search. Dev queries the live /__search endpoint; the production
  // reader runs the same matcher over the prebuilt index, client-side.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setTruncated(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // Auto-jump came from an XRef click. Skip the debounce there — the
    // user already committed and the perceived snappiness matters.
    const debounce = autoJumpRef.current ? 0 : 150;
    const applyHits = (h: Hit[], tr: boolean) => {
      setHits(h);
      setTruncated(tr);
      setCursor(0);
      // New hits → reset scroll. The ul element is reused across queries;
      // without this, the scroll position from a previous search persists
      // and the freshly-rendered row 0 is rendered mid-list.
      if (listRef.current) listRef.current.scrollTop = 0;
    };
    const handle = setTimeout(async () => {
      if (import.meta.env.DEV) {
        try {
          const res = await fetch(
            `/__search?q=${encodeURIComponent(q)}&doc=${encodeURIComponent(docId)}`,
          );
          const data = (await res.json()) as {
            ok: boolean;
            hits?: Hit[];
            truncated?: boolean;
            pdfStatus?: Record<string, PdfStatus>;
          };
          if (cancelled) return;
          if (data.ok && data.hits) applyHits(data.hits, Boolean(data.truncated));
          else applyHits([], false);
          const ps = data.pdfStatus?.[docId];
          if (ps) setPdfStatus(ps);
        } catch {
          if (!cancelled) setHits([]);
        } finally {
          if (!cancelled) setLoading(false);
        }
      } else {
        // Production: run the shared matcher over the static index. If it
        // hasn't finished loading, stay put — this effect re-runs when
        // indexState flips to 'ready' (it's in the dependency list).
        const idx = indexRef.current;
        if (!idx) {
          if (!cancelled) setLoading(false);
          return;
        }
        const { hits: h, truncated: tr } = searchIndex(idx, q);
        if (cancelled) return;
        applyHits(h, tr);
        setLoading(false);
      }
    }, debounce);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, docId, indexState]);

  // While indexing is still in flight, poll status so the banner clears
  // without the user having to retype. Cheap — `f` is rare and the loop
  // self-terminates the moment the index is ready. Dev-only: prod's index
  // is prebuilt and complete, so there's nothing to poll.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!open) return;
    if (pdfStatus.state !== 'extracting') return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `/__search?q=&doc=${encodeURIComponent(docId)}`,
        );
        const data = (await res.json()) as {
          pdfStatus?: Record<string, PdfStatus>;
        };
        if (cancelled) return;
        const ps = data.pdfStatus?.[docId];
        if (ps) setPdfStatus(ps);
      } catch {
        // ignore — the next tick will retry
      }
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [open, docId, pdfStatus.state]);

  const goToGenRef = useRef(0);
  const goTo = useCallback(
    (h: Hit) => {
      close();
      // Cancel any in-flight retry/scroll chain from a previous goTo, so a slow
      // cold-page chunk can't hijack the viewport after the user has already
      // navigated elsewhere (pages now lazy-load on demand under the continuous
      // scroller, so a retry loop can outlive its relevance).
      const myGen = ++goToGenRef.current;
      const onCurrentPage = currentHashPageId() === h.pageId;
      const finish = (attempt = 0): void => {
        if (myGen !== goToGenRef.current) return; // superseded by a newer navigation
        // Original-source hits have no element coords — they were matched
        // against the PDF's plain text, not the JSX. onGoToPage below already
        // scrolled the target page to the top (with header clearance), so we're
        // done. (Previously this did window.scrollTo({top:0}); under the
        // window-scrolled continuous reader that jumps to page 1, not the
        // target page.)
        if (h.source === 'original') return;
        const el = findByIdentity(h.file, h.elementLine, h.elementCol);
        if (!el) {
          if (attempt < 20) {
            setTimeout(() => finish(attempt + 1), 50);
          }
          return;
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashElement(el);
      };
      if (!onCurrentPage) {
        if (onGoToPage) {
          onGoToPage(h.pageId);
        } else {
          window.location.hash = `#/d/${encodeURIComponent(docId)}/p/${encodeURIComponent(h.pageId)}`;
        }
        finish(0);
      } else {
        finish(0);
      }
    },
    [close, onGoToPage, docId],
  );

  // Keep the cursor row at the nearest viewport edge of the list. We do
  // the math by hand instead of calling row.scrollIntoView({ block:
  // 'nearest' }) because the latter also walks up the ancestor chain and
  // scrolls the document body (the SearchBar is fixed-positioned), which
  // shifts the page underneath the dialog and reads as the highlight
  // "jumping to the middle". Mutating ul.scrollTop directly only moves
  // the list — nothing else.
  useEffect(() => {
    const ul = listRef.current;
    if (!ul) return;
    const row = ul.querySelector<HTMLLIElement>('[data-cursor="true"]');
    if (!row) return;
    const ulRect = ul.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // Position of the row's top inside the list's scroll-content
    // coordinate space (independent of offsetParent quirks).
    const rowTop = rowRect.top - ulRect.top + ul.scrollTop;
    const rowBottom = rowTop + rowRect.height;
    if (rowBottom > ul.scrollTop + ul.clientHeight) {
      // Row is below the visible area → pin its bottom to the viewport
      // bottom (cursor sits at the bottom edge, prior rows scroll up).
      ul.scrollTop = rowBottom - ul.clientHeight;
    } else if (rowTop < ul.scrollTop) {
      // Row is above the visible area → pin its top to the viewport top.
      ul.scrollTop = rowTop;
    }
  }, [cursor]);

  // Auto-jump triggered by an XRef click. We only jump when confident; any
  // genuine ambiguity falls through to the picker so the user decides (and
  // never lands somewhere surprising like a table-of-contents page).
  //   1. Exactly one heading-kind hit off-page → the canonical section. The
  //      backend marks both translated <h1-h6> and heading-like lines in the
  //      PDF original (the usual case: the English title was translated away
  //      and only survives in the original), so this fires across languages.
  //   2. No headings but exactly one off-page hit total → the only candidate.
  //   3. Anything else (0, or 2+ equally-good targets) → show the picker.
  // autoJumpRef is cleared after evaluation so subsequent typing in the
  // prefilled input doesn't keep re-jumping.
  useEffect(() => {
    if (!autoJumpRef.current) return;
    if (loading) return;
    const offPage = hits.filter((h) => h.pageId !== currentPageId);
    autoJumpRef.current = false;
    const headings = offPage.filter((h) => h.kind === 'heading');
    if (headings.length === 1) {
      goTo(headings[0]);
      return;
    }
    if (headings.length === 0 && offPage.length === 1) {
      goTo(offPage[0]);
    }
  }, [hits, loading, currentPageId, goTo]);

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(hits.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const h = hits[cursor];
      if (h) goTo(h);
    }
  }

  // Pre-split each hit's snippet at the matched span so we can highlight it
  // without injecting HTML.
  const hitParts = useMemo(
    () =>
      hits.map((h) => ({
        before: h.snippet.slice(0, h.snippetMatchStart),
        match: h.snippet.slice(
          h.snippetMatchStart,
          h.snippetMatchStart + h.snippetMatchLength,
        ),
        after: h.snippet.slice(h.snippetMatchStart + h.snippetMatchLength),
      })),
    [hits],
  );

  if (!open) return null;

  return (
    <div
      data-inspector-ui
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh]"
      style={{ background: 'rgba(21, 20, 15, 0.30)' }}
      onClick={close}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-[640px] max-w-[92vw] flex flex-col"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-ink)',
          boxShadow: '4px 4px 0 var(--color-ink)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
          <span className="eyebrow">Search translations</span>
          <span className="font-mono text-[10px] text-ink-faded">
            ↑↓ · ↩ · esc
          </span>
        </div>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="keyword across all pages…"
          className="field border-0 border-b border-rule"
          style={{ borderRadius: 0 }}
        />
        <div className="px-3 py-1 border-b border-rule font-mono text-[10px] text-ink-faded flex items-center justify-between gap-3">
          <span>
            {query.trim().length < 2
              ? 'type at least 2 characters'
              : !import.meta.env.DEV && indexState !== 'ready'
                ? indexState === 'error'
                  ? 'search unavailable'
                  : 'loading index…'
                : loading
                  ? 'searching…'
                  : `${hits.length} hit${hits.length === 1 ? '' : 's'}${truncated ? ' (first 200)' : ''}`}
          </span>
          {!import.meta.env.DEV && indexState === 'error' && (
            <span style={{ color: 'var(--color-warn)' }}>
              search index failed to load
            </span>
          )}
          {import.meta.env.DEV && pdfStatus.state === 'extracting' && (
            <span style={{ color: 'var(--color-accent)' }}>
              indexing original text…
            </span>
          )}
          {import.meta.env.DEV && pdfStatus.state === 'error' && (
            <span
              title={pdfStatus.error ?? ''}
              style={{ color: 'var(--color-warn)' }}
            >
              original-text index failed
            </span>
          )}
        </div>
        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {hits.length === 0 && query.trim().length >= 2 && !loading && (
            <li className="px-3 py-3 font-mono text-[11px] text-ink-faded uppercase tracking-wider">
              No matches
            </li>
          )}
          {hits.map((h, i) => {
            const isCursor = i === cursor;
            const parts = hitParts[i];
            return (
              // biome-ignore lint: arrow-key controlled cursor — onMouseMove just mirrors it
              <li
                key={`${h.source}:${h.pageId}:${h.elementLine}:${h.elementCol}:${i}`}
                data-cursor={isCursor ? 'true' : undefined}
                onClick={() => goTo(h)}
                // onMouseMove (not onMouseEnter) so that arrow-key scroll
                // doesn't fight the cursor: mousemove only fires on real
                // mouse movement, while mouseenter also fires whenever a
                // different element ends up under a stationary cursor —
                // which is exactly what happens when the list scrolls.
                onMouseMove={() => setCursor(i)}
                className="px-3 py-2 flex items-start gap-3 cursor-pointer"
                style={{
                  background: isCursor ? 'var(--color-accent-tint)' : 'transparent',
                  borderLeft: isCursor
                    ? '3px solid var(--color-accent)'
                    : '3px solid transparent',
                }}
              >
                <span className="font-mono text-[10px] text-ink-muted numeric pt-0.5 w-16 flex-none">
                  {h.pageId}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[10px] text-ink-muted mb-0.5 uppercase tracking-wider">
                    {h.source === 'original' ? (
                      <span style={{ color: 'var(--color-accent)' }}>
                        {h.kind === 'heading'
                          ? 'section heading · PDF original'
                          : 'from PDF original'}
                      </span>
                    ) : (
                      <>
                        {h.elementTag ? `<${h.elementTag}>` : 'jsx'}
                        <span className="numeric"> · L{h.elementLine}</span>
                      </>
                    )}
                  </div>
                  <div className="font-body text-[13px] text-ink break-words leading-snug">
                    {parts.before}
                    <mark
                      style={{
                        background: 'var(--color-accent)',
                        color: 'var(--color-surface)',
                        padding: '0 2px',
                      }}
                    >
                      {parts.match}
                    </mark>
                    {parts.after}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
