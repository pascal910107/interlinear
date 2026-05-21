import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type Props = {
  pageIds: readonly string[];
  currentId: string | null;
  onGo: (id: string) => void;
  /** Override the convention `/${pageId}.png`. */
  thumbnailSrc?: (pageId: string) => string;
};

const STORAGE_KEY = 'interlinear:thumbs-open';
const STRIP_W = 148;
const HANDLE_W = 22;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

/**
 * Vertical, collapsible thumbnail rail for quick visual page navigation.
 * Thumbnails resolve to `/${pageId}.png` by default — override via the
 * `thumbnailSrc` prop for non-conventional asset layouts. Open state is
 * persisted in localStorage so the rail stays the way the user left it
 * across reloads. `t` toggles open/closed (inert while typing).
 */
export function PageThumbStrip({ pageIds, currentId, onGo, thumbnailSrc }: Props) {
  const src = thumbnailSrc ?? ((id: string) => `/${id}.png`);
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
    } catch {
      // ignore quota / private-mode errors
    }
  }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 't') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setOpen((o) => !o);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the current page visible in the rail.
  const listRef = useRef<HTMLUListElement>(null);
  const currentItemRef = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    currentItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [open, currentId]);

  return (
    <aside
      data-inspector-ui
      className="fixed left-0 z-20 flex"
      style={{
        top: 65, // sit below the sticky header (~57px) + a small gap
        bottom: 0,
        // Slide the rail off-screen when closed, leaving the handle.
        transform: open ? 'translateX(0)' : `translateX(-${STRIP_W}px)`,
        transition: 'transform 160ms ease',
      }}
    >
      <div
        className="flex flex-col overflow-y-auto"
        style={{
          width: STRIP_W,
          background: 'var(--color-surface)',
          borderRight: '1px solid var(--color-ink)',
          boxShadow: open ? '3px 0 0 var(--color-ink)' : 'none',
        }}
      >
        <div className="px-3 py-2 border-b border-rule flex items-center justify-between sticky top-0 bg-surface">
          <span className="eyebrow">Pages</span>
          <span className="font-mono text-[10px] text-ink-faded numeric">
            {pageIds.length}
          </span>
        </div>
        <ul ref={listRef} className="flex flex-col gap-2 p-2">
          {pageIds.map((id) => {
            const isCurrent = id === currentId;
            return (
              <li
                key={id}
                ref={isCurrent ? currentItemRef : null}
                className="flex flex-col items-stretch"
              >
                <button
                  type="button"
                  onClick={() => onGo(id)}
                  className="flex flex-col items-stretch gap-1 p-1 text-left"
                  style={{
                    background: isCurrent ? 'var(--color-accent-tint)' : 'transparent',
                    border: isCurrent
                      ? '1.5px solid var(--color-accent)'
                      : '1px solid var(--color-rule)',
                  }}
                  title={id}
                >
                  <img
                    src={src(id)}
                    alt={id}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-auto block"
                    style={{ background: 'var(--color-paper-deep)' }}
                    onError={(e) => {
                      // Hide broken-image icon; the pageId label below still
                      // tells the user which page this is.
                      (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                    }}
                  />
                  <span
                    className="font-mono text-[10px] tracking-wider numeric truncate"
                    style={{ color: isCurrent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
                  >
                    {id}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Hide thumbnails (t)' : 'Show thumbnails (t)'}
        className="flex items-center justify-center font-mono text-[12px] text-ink"
        style={{
          width: HANDLE_W,
          background: 'var(--color-surface)',
          borderRight: '1px solid var(--color-ink)',
          borderTop: '1px solid var(--color-ink)',
          borderBottom: '1px solid var(--color-ink)',
          boxShadow: '3px 3px 0 var(--color-ink)',
          alignSelf: 'flex-start',
          marginTop: 12,
        }}
      >
        {open ? '⟨' : '⟩'}
      </button>
    </aside>
  );
}
