import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDoc } from './DocContext';

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
 * Cross-page keyword search. Press `f` (or click the icon in the header)
 * to open. Searches translation JSX text across every page via the dev
 * /__search endpoint; click a hit to jump to its page, scroll the target
 * element into view, and flash an outline around it.
 *
 * Dev-only: the static prod build has no /__search endpoint, so this
 * component renders nothing when `import.meta.env.DEV` is false.
 */
export function SearchBar({ onGoToPage }: Props = {}) {
  const { id: docId } = useDoc();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHits([]);
    setTruncated(false);
    setCursor(0);
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

  // Focus input when opened.
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Debounced fetch.
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
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/__search?q=${encodeURIComponent(q)}&doc=${encodeURIComponent(docId)}`,
        );
        const data = (await res.json()) as {
          ok: boolean;
          hits?: Hit[];
          truncated?: boolean;
        };
        if (cancelled) return;
        if (data.ok && data.hits) {
          setHits(data.hits);
          setTruncated(Boolean(data.truncated));
          setCursor(0);
        } else {
          setHits([]);
          setTruncated(false);
        }
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, docId]);

  const goTo = useCallback(
    (h: Hit) => {
      close();
      const onCurrentPage = currentHashPageId() === h.pageId;
      const finish = (attempt = 0): void => {
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

  if (!import.meta.env.DEV) return null;
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
        <div className="px-3 py-1 border-b border-rule font-mono text-[10px] text-ink-faded flex items-center justify-between">
          <span>
            {query.trim().length < 2
              ? 'type at least 2 characters'
              : loading
                ? 'searching…'
                : `${hits.length} hit${hits.length === 1 ? '' : 's'}${truncated ? ' (first 200)' : ''}`}
          </span>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto">
          {hits.length === 0 && query.trim().length >= 2 && !loading && (
            <li className="px-3 py-3 font-mono text-[11px] text-ink-faded uppercase tracking-wider">
              No matches
            </li>
          )}
          {hits.map((h, i) => {
            const isCursor = i === cursor;
            const parts = hitParts[i];
            return (
              // biome-ignore lint: arrow-key controlled cursor — onMouseEnter just mirrors it
              <li
                key={`${h.pageId}:${h.elementLine}:${h.elementCol}:${i}`}
                onClick={() => goTo(h)}
                onMouseEnter={() => setCursor(i)}
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
                    {h.elementTag ? `<${h.elementTag}>` : 'jsx'}
                    <span className="numeric"> · L{h.elementLine}</span>
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
