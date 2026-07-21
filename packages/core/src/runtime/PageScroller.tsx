import {
  forwardRef,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ComponentType,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

// Overscan a bit beyond the viewport so scrolling doesn't reveal blank
// placeholders. Hoisted to keep a stable identity across renders.
const INCREASE_VIEWPORT = { top: 600, bottom: 900 };

// Representative page height (px). Pages above a deep-linked target never
// render, so Virtuoso can only estimate their combined height when scrolling to
// the target; a realistic default keeps that estimate accurate enough that a
// cold deep-link to e.g. page 200 lands ON page 200 rather than drifting a page
// off. Real pages measure ~1100–1400px; the exact value only affects the
// pre-measurement estimate.
const DEFAULT_PAGE_HEIGHT = 1300;

export type PageModule = { default: ComponentType };

export type PageScrollerHandle = {
  /** Scroll a page into view (page top lands just below the sticky header). */
  scrollToPage: (pageId: string, opts?: { smooth?: boolean }) => void;
};

type Props = {
  pageIds: readonly string[];
  /** Per-page dynamic import — the doc's `loadPage`. */
  loadPage: (id: string) => Promise<PageModule>;
  /** Page to render at on first mount (deep-link). */
  initialPageId?: string | null;
  /**
   * Pixels to keep clear at the top when a jump lands a page, so it sits
   * below the sticky app header instead of underneath it.
   */
  headerOffset?: number;
  /** Fired when the page occupying the vertical center of the viewport changes. */
  onVisiblePageChange?: (pageId: string) => void;
};

/**
 * Continuous, virtualized reader. Every page is stacked in one window-scrolled
 * list (react-virtuoso), so the whole doc scrolls like a normal PDF instead of
 * one-URL-per-page. Only pages near the viewport are mounted; Virtuoso handles
 * dynamic per-page heights and keeps the viewport anchored when a page above
 * grows after its lazy chunk loads.
 *
 * Page-boundary synchronization between the original (left) and translation
 * (right) is inherited for free from each page's own `grid grid-cols-2`
 * (a grid row is as tall as its taller cell), so no cross-column scroll math
 * lives here.
 *
 * `currentPageId` tracking is decoupled from React state: a single
 * IntersectionObserver watches a thin band at the viewport's vertical center
 * and reports whichever page crosses it. During a programmatic `scrollToPage`,
 * intermediate pages swept by the scroll are suppressed so the reported
 * "current page" jumps straight from origin to target — which keeps the
 * cross-reference jump stack (driven off discrete currentId changes) correct.
 */
export const PageScroller = memo(
  forwardRef<PageScrollerHandle, Props>(function PageScroller(
    { pageIds, loadPage, initialPageId, headerOffset = 64, onVisiblePageChange },
    ref,
  ) {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const ids = pageIds as string[];

    const initialIndex = useMemo(() => {
      if (!initialPageId) return 0;
      const i = ids.indexOf(initialPageId);
      return i >= 0 ? i : 0;
    }, [ids, initialPageId]);

    // --- Lazy component cache -------------------------------------------------
    // Reuse one lazy() wrapper per page id so a page that scrolls out and back
    // in remounts from React.lazy's resolved cache (no Suspense-fallback flash).
    const lazyCacheRef = useRef(new Map<string, ComponentType>());
    const getLazy = useCallback(
      (id: string): ComponentType => {
        const cache = lazyCacheRef.current;
        let C = cache.get(id);
        if (!C) {
          C = lazy(() => loadPage(id));
          cache.set(id, C);
        }
        return C;
      },
      [loadPage],
    );

    // --- Current-page detection + programmatic-scroll suppression -------------
    const onVisibleRef = useRef(onVisiblePageChange);
    onVisibleRef.current = onVisiblePageChange;

    // While set, reports are suppressed until the target page reaches center
    // (or a safety timeout fires), so mid-scroll pages don't clobber currentId.
    const suppressRef = useRef<{ target: string; timer: number } | null>(null);
    const clearSuppress = useCallback(() => {
      if (suppressRef.current) {
        clearTimeout(suppressRef.current.timer);
        suppressRef.current = null;
      }
    }, []);

    const report = useCallback((id: string) => {
      const s = suppressRef.current;
      if (s) {
        if (id !== s.target) return; // swept-past page mid-jump — ignore
        clearTimeout(s.timer);
        suppressRef.current = null;
      }
      onVisibleRef.current?.(id);
    }, []);

    // Report whichever mounted page currently occupies the viewport's vertical
    // center, computed from live rects rather than IntersectionObserver toggle
    // state. Toggle state goes stale when a page's position shifts without
    // re-crossing the observed band — e.g. a page above finishing its lazy load
    // reflows everything below — which would otherwise pin the URL/header to the
    // wrong page. Recomputing from rects always reflects the true center.
    const reportCentered = useCallback(() => {
      if (typeof document === 'undefined') return;
      const els = document.querySelectorAll<HTMLElement>('[data-page-id]');
      if (els.length === 0) return;
      // At the very bottom, a short final page may not reach the center line and
      // there is no page below to take it — report the last mounted page so
      // scrolling onto a short last page still updates the current page.
      const atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 4;
      if (atBottom) {
        const id = els[els.length - 1].getAttribute('data-page-id');
        if (id) report(id);
        return;
      }
      const line = window.innerHeight / 2;
      let nearestAbove: string | null = null;
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        const id = els[i].getAttribute('data-page-id');
        if (r.top <= line && r.bottom >= line) {
          if (id) report(id);
          return;
        }
        // Track the lowest page that starts at/above center as a fallback for
        // moments when no page brackets the line (a gap during a reflow).
        if (r.top <= line && id) nearestAbove = id;
      }
      if (nearestAbove) report(nearestAbove);
    }, [report]);

    const handleScrolling = useCallback(
      (scrolling: boolean) => {
        if (scrolling) return;
        // Scroll settled. A jump's explicit target must win over geometric
        // center: a short target page sits at the top of the reading area, not
        // the middle, so reportCentered would otherwise pick the taller
        // neighbour below it. A short hop may also never re-toggle the band, so
        // the target-match clear in report() might not have fired.
        const target = suppressRef.current?.target;
        clearSuppress();
        if (target && document.querySelector(`[data-page-id="${target}"]`)) {
          report(target);
        } else {
          reportCentered();
        }
      },
      [clearSuppress, report, reportCentered],
    );

    // The observer is only a cheap "viewport composition changed" trigger; the
    // current page itself is always recomputed from rects in reportCentered.
    const observerRef = useRef<IntersectionObserver | null>(null);
    if (observerRef.current === null && typeof IntersectionObserver !== 'undefined') {
      observerRef.current = new IntersectionObserver(() => reportCentered(), {
        rootMargin: '-45% 0px -45% 0px',
        threshold: 0,
      });
    }

    useEffect(
      () => () => {
        observerRef.current?.disconnect();
        clearSuppress();
      },
      [clearSuppress],
    );

    const register = useCallback((el: Element | null, _id: string) => {
      const obs = observerRef.current;
      if (!obs || !el) return () => {};
      obs.observe(el);
      return () => obs.unobserve(el);
    }, []);

    // --- Imperative scroll ----------------------------------------------------
    const scrollToPage = useCallback(
      (pageId: string, opts?: { smooth?: boolean }) => {
        const index = ids.indexOf(pageId);
        if (index < 0) return;
        clearSuppress();
        suppressRef.current = {
          target: pageId,
          timer: window.setTimeout(() => {
            suppressRef.current = null;
          }, 1200),
        };
        onVisibleRef.current?.(pageId); // optimistic: update chrome immediately
        virtuosoRef.current?.scrollToIndex({
          index,
          align: 'start',
          offset: -headerOffset,
          behavior: opts?.smooth ? 'smooth' : 'auto',
        });
      },
      [ids, headerOffset, clearSuppress],
    );

    useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

    return (
      <Virtuoso
        ref={virtuosoRef}
        useWindowScroll
        data={ids}
        initialTopMostItemIndex={{
          index: initialIndex,
          align: 'start',
          offset: -headerOffset,
        }}
        computeItemKey={(_, id) => id}
        isScrolling={handleScrolling}
        defaultItemHeight={DEFAULT_PAGE_HEIGHT}
        increaseViewportBy={INCREASE_VIEWPORT}
        itemContent={(_, id) => (
          <StackedPage id={id} Comp={getLazy(id)} register={register} />
        )}
      />
    );
  }),
);

function StackedPage({
  id,
  Comp,
  register,
}: {
  id: string;
  Comp: ComponentType;
  register: (el: Element | null, id: string) => () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return register(ref.current, id);
  }, [id, register]);
  return (
    <div ref={ref} data-page-id={id}>
      <Suspense fallback={<PagePlaceholder />}>
        <Comp />
      </Suspense>
    </div>
  );
}

/** Reserves vertical space while a page's chunk loads, minimizing reflow. */
function PagePlaceholder() {
  return (
    <div
      className="flex items-start justify-center"
      style={{ minHeight: '100vh' }}
    >
      <div className="eyebrow mt-24 text-ink-faded">Loading page…</div>
    </div>
  );
}
