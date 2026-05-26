import { useEffect } from 'react';

type Props = {
  /** Snapshot of the jump-stack; bottom is oldest. Pill renders when non-empty. */
  stack: readonly string[];
  /** Called to pop the top entry and navigate to it. */
  onPop: () => void;
};

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

/**
 * Contextual back-affordance that appears in the bottom-left after a
 * cross-reference jump. Click pops one level; Backspace does the same
 * (when not typing). Hidden whenever the stack is empty so it never
 * sits idle on screen.
 *
 * Visual treatment mirrors the SearchBar card — same surface/border/
 * shadow — so the dialog-class affordances of the workbench feel like
 * a set instead of one-offs.
 */
export function JumpBackPill({ stack, onPop }: Props) {
  useEffect(() => {
    if (stack.length === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Backspace') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      onPop();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stack.length, onPop]);

  if (stack.length === 0) return null;
  const target = stack[stack.length - 1];

  return (
    <button
      type="button"
      onClick={onPop}
      title={`Back to ${target} (Backspace)`}
      data-inspector-ui
      className="fixed bottom-4 left-4 z-[60] px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink hover:text-accent"
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-ink)',
        boxShadow: '4px 4px 0 var(--color-ink)',
        cursor: 'pointer',
      }}
    >
      ← <span className="numeric">{target}</span>
    </button>
  );
}
