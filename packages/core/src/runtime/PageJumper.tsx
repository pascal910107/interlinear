import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Props = {
  pageIds: readonly string[];
  currentId: string | null;
  onGo: (id: string) => void;
};

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

/**
 * `/` opens a quick-jumper. Type to filter pageIds by substring, ↑/↓ to
 * move the selection, Enter to navigate, Esc to close. Backdrop click
 * closes too. Inert while the user is typing into any other input —
 * `/` then yields its default behavior (e.g. quick-find in the browser
 * would have stolen it anyway).
 */
export function PageJumper({ pageIds, currentId, onGo }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCursor(0);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (open) return;
      if (e.key !== '/') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setOpen(true);
      setQuery('');
      setCursor(0);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pageIds;
    return pageIds.filter((id) => id.toLowerCase().includes(q));
  }, [pageIds, query]);

  useEffect(() => {
    if (cursor >= filtered.length) {
      setCursor(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, cursor]);

  if (!open) return null;

  function selectAt(i: number) {
    const id = filtered[i];
    if (id) onGo(id);
    close();
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(filtered.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectAt(cursor);
    }
  }

  return (
    <div
      data-inspector-ui
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[18vh]"
      style={{ background: 'rgba(21, 20, 15, 0.30)' }}
      onClick={close}
      onKeyDown={(e) => {
        // Stop key events from bubbling to the page-level useKeyboardNav.
        e.stopPropagation();
      }}
    >
      <div
        className="w-[420px] flex flex-col"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-ink)',
          boxShadow: '4px 4px 0 var(--color-ink)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
          <span className="eyebrow">Jump to page</span>
          <span className="font-mono text-[10px] text-ink-faded">
            ↑↓ · ↩ · esc
          </span>
        </div>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onInputKey}
          placeholder="filter by page id…"
          className="field border-0 border-b border-rule"
          style={{ borderRadius: 0 }}
        />
        <ul className="max-h-[40vh] overflow-y-auto">
          {filtered.length === 0 && (
            <li className="px-3 py-3 font-mono text-[11px] text-ink-faded uppercase tracking-wider">
              No matches
            </li>
          )}
          {filtered.map((id, i) => {
            const isCursor = i === cursor;
            const isCurrent = id === currentId;
            return (
              // biome-ignore lint: arrow-key controlled cursor — onMouseEnter just mirrors it
              <li
                key={id}
                onClick={() => selectAt(i)}
                onMouseEnter={() => setCursor(i)}
                className="px-3 py-2 flex items-center justify-between cursor-pointer"
                style={{
                  background: isCursor ? 'var(--color-accent-tint)' : 'transparent',
                  borderLeft: isCursor
                    ? '3px solid var(--color-accent)'
                    : '3px solid transparent',
                }}
              >
                <span className="font-mono text-[12px] text-ink numeric">{id}</span>
                {isCurrent && (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faded">
                    current
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
