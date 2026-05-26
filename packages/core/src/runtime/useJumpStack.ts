import { useCallback, useEffect, useRef, useState } from 'react';

export type JumpStackApi = {
  /** Bottom of the stack is the page the chain started from. */
  stack: readonly string[];
  /**
   * Navigate via a cross-reference. Pushes the current page on the stack
   * so the user can come back. No-op if `toPageId` equals current page.
   */
  xrefJump: (toPageId: string) => void;
  /** Pop the top of the stack and navigate to it. No-op if empty. */
  pop: () => void;
};

/**
 * Per-doc navigation history for cross-reference jumps. SearchBar's
 * goTo() routes through `xrefJump`, which records the page being left.
 * `pop` is called by the back pill and the Backspace keyboard handler.
 *
 * Any other navigation (PageNav PREV/NEXT, PageJumper, PageThumbStrip,
 * hash typed manually) clears the stack — once the user breaks the
 * reference-chasing flow, the saved "home" page is no longer what they
 * want to come back to.
 *
 * Classification is done with a pendingRef set just before `go()` is
 * called: the next `currentPageId` change is then known to be a push,
 * pop, or unclassified other-nav.
 */
export function useJumpStack({
  currentPageId,
  go,
}: {
  currentPageId: string | null;
  go: (pageId: string) => void;
}): JumpStackApi {
  const [stack, setStack] = useState<string[]>([]);
  const pendingRef = useRef<
    | { kind: 'push'; from: string; to: string }
    | { kind: 'pop'; to: string }
    | null
  >(null);

  useEffect(() => {
    const p = pendingRef.current;
    if (p && p.to === currentPageId) {
      pendingRef.current = null;
      if (p.kind === 'push') {
        setStack((s) => [...s, p.from]);
      } else {
        setStack((s) => s.slice(0, -1));
      }
      return;
    }
    pendingRef.current = null;
    // Other navigation → drop the stale chain. setState is bailed-out by
    // React when the next state is the same array reference, so no extra
    // render when the stack was already empty.
    setStack((s) => (s.length === 0 ? s : []));
  }, [currentPageId]);

  const xrefJump = useCallback(
    (to: string) => {
      if (!currentPageId) {
        go(to);
        return;
      }
      if (currentPageId === to) return;
      pendingRef.current = { kind: 'push', from: currentPageId, to };
      go(to);
    },
    [currentPageId, go],
  );

  const pop = useCallback(() => {
    if (stack.length === 0) return;
    const target = stack[stack.length - 1];
    pendingRef.current = { kind: 'pop', to: target };
    go(target);
  }, [stack, go]);

  return { stack, xrefJump, pop };
}
