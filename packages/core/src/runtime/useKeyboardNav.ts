import { useEffect } from 'react';

type Args = {
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
 * Vim-ish page navigation bound at window scope. `j` / ArrowDown moves to
 * the next page, `k` / ArrowUp moves to the previous one. Inert when the
 * user is typing into an Inspector textarea or any input/contenteditable.
 */
export function useKeyboardNav({ pageIds, currentId, onGo }: Args): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const idx = currentId ? pageIds.indexOf(currentId) : -1;
      if (idx < 0) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        if (idx < pageIds.length - 1) {
          e.preventDefault();
          onGo(pageIds[idx + 1]);
        }
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        if (idx > 0) {
          e.preventDefault();
          onGo(pageIds[idx - 1]);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageIds, currentId, onGo]);
}
