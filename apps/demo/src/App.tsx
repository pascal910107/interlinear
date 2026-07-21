import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DocChat,
  DocProvider,
  Inspector,
  JumpBackPill,
  PageJumper,
  PageNav,
  PageScroller,
  PageThumbStrip,
  SearchBar,
  ThemeToggle,
  useDocRoute,
  useJumpStack,
  useKeyboardNav,
} from '@interlinear/core';
import type { DocRoutePatch, PageScrollerHandle } from '@interlinear/core';
import { docs, type InterlinearDoc } from 'virtual:interlinear/docs';

function Home({ onPick }: { onPick: (docId: string) => void }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header
        data-inspector-ui
        className="px-8 py-4 border-b border-rule bg-paper sticky top-0 z-30"
      >
        <div className="max-w-[1600px] mx-auto flex items-baseline justify-between gap-6">
          <div className="flex items-baseline gap-4">
            <h1 className="font-display text-[20px] font-semibold tracking-[-0.01em] text-ink">
              inter<span className="text-accent">·</span>linear
            </h1>
            <span className="eyebrow">post-editing workbench</span>
          </div>
          <ThemeToggle />
        </div>
      </header>
      <main className="max-w-[1100px] mx-auto px-8 py-10 w-full flex-1">
        <div className="eyebrow mb-4">
          Documents · <span className="numeric">{docs.length}</span>
        </div>
        {docs.length === 0 ? (
          <div
            className="px-4 py-6 font-body italic text-[13px] text-ink-muted"
            style={{
              background: 'var(--color-paper-deep)',
              borderLeft: '3px solid var(--color-rule)',
            }}
          >
            尚未發現任何 doc。在 <code className="font-mono">docs/</code> 下新增一個 folder，
            放入 <code className="font-mono">interlinear.config.ts</code> 跟{' '}
            <code className="font-mono">pages/</code>，重新整理即可。
          </div>
        ) : (
          <ul className="flex flex-col">
            {docs.map((d, i) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => onPick(d.id)}
                  className="w-full flex items-baseline gap-4 px-4 py-3 text-left hover:bg-paper-deep"
                  style={{
                    borderTop: '1px solid var(--color-rule)',
                    borderBottom:
                      i === docs.length - 1 ? '1px solid var(--color-rule)' : 'none',
                  }}
                >
                  <span className="font-mono text-[11px] uppercase tracking-wider text-ink-muted w-48 flex-none">
                    {d.id}
                  </span>
                  <span className="font-display text-[16px] text-ink flex-1">
                    {d.title}
                  </span>
                  <span className="font-mono text-[10px] text-ink-faded numeric">
                    {d.pageIds.length} pages · {d.locale ?? '—'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

// Pixels kept clear at the top of the viewport when a jump lands a page, so
// it sits below the sticky header (≈57px) rather than underneath it.
const HEADER_OFFSET = 64;

function DocView({
  doc,
  pageId,
  go,
}: {
  doc: InterlinearDoc;
  pageId: string | null;
  go: (patch: DocRoutePatch) => void;
}) {
  const pageIds = doc.pageIds;

  // In continuous-scroll mode the viewed page is driven by scroll position, not
  // the route — so `currentId` is local state (seeded from the deep-linked
  // pageId), and the URL becomes a one-way mirror of it (see below).
  const [currentId, setCurrentId] = useState<string | null>(() =>
    pageId && pageIds.includes(pageId) ? pageId : (pageIds[0] ?? null),
  );
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  // Captured once (DocView is keyed by doc.id, so it remounts per doc) — the
  // page PageScroller starts mounted at. Kept stable so it never re-scrolls.
  const initialPageIdRef = useRef(currentId);

  const scrollerRef = useRef<PageScrollerHandle>(null);

  // 'push' when a discrete jump (thumbnail, jumper) should leave a browser
  // history entry so Back returns to the prior position; 'replace' (default)
  // for passive scroll and adjacent stepping, which must not spam history.
  // Consumed by the URL-mirror effect below.
  const historyModeRef = useRef<'push' | 'replace'>('replace');

  // The single funnel for every intentional navigation (keyboard, PageNav,
  // thumbs, jumper, xref). Sets currentId immediately (so the jump stack sees a
  // discrete origin→target change) and asks the scroller to bring the page in.
  const navigateTo = useCallback(
    (id: string, opts?: { smooth?: boolean; push?: boolean }) => {
      if (!pageIds.includes(id)) return; // ignore unknown page ids (typo'd URL, stale link)
      if (id === currentIdRef.current) return; // already here — a no-op scroll can't clear its own suppression
      if (opts?.push) historyModeRef.current = 'push';
      setCurrentId(id);
      scrollerRef.current?.scrollToPage(id, opts);
    },
    [pageIds],
  );

  // Passive scroll → whichever page is at the viewport center becomes current.
  const handleVisiblePageChange = useCallback((id: string) => {
    setCurrentId(id);
  }, []);

  // Mirror the viewed page into the URL. Neither replaceState nor pushState
  // fires a hashchange, so this write never loops back through useDocRoute to
  // re-scroll. Passive scroll uses replaceState (no history spam); a discrete
  // jump flagged 'push' leaves a history entry so browser Back returns to it.
  useEffect(() => {
    if (!currentId) return;
    const mode = historyModeRef.current;
    historyModeRef.current = 'replace'; // consume; default back to replace
    const target = `#/d/${encodeURIComponent(doc.id)}/p/${encodeURIComponent(currentId)}`;
    if (window.location.hash === target) return;
    if (mode === 'push') window.history.pushState(null, '', target);
    else window.history.replaceState(null, '', target);
  }, [currentId, doc.id]);

  // External navigation only: browser back/forward or a manually edited hash.
  // We read window.location.hash directly instead of route.pageId, because our
  // replaceState mirror fires no hashchange — so useDocRoute's route.pageId goes
  // stale vs the real URL and can't be the trigger (navigating to a page you'd
  // scrolled past would no-op). Internal navs use replaceState (no hashchange),
  // so this listener never fires for them.
  useEffect(() => {
    function onHashChange() {
      const m = /^#\/d\/([^/?]+)\/p\/([^/?]+)/.exec(window.location.hash);
      if (!m) return;
      if (decodeURIComponent(m[1]) !== doc.id) return;
      const target = decodeURIComponent(m[2]);
      if (target !== currentIdRef.current) navigateTo(target, { smooth: false });
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [doc.id, navigateTo]);

  // Cold deep-link correction. `initialTopMostItemIndex` positions by estimated
  // heights; pages above a deep target never render, so a cold load can settle
  // ~a page off (and the mirror would then adopt the neighbor). Once the target
  // and its neighbours have rendered their real heights, snap exactly onto it.
  // No-op for warm loads / page 1 (already precise). Runs once on mount, and is
  // cancelled the instant the user scrolls or keys — so it never yanks someone
  // who started reading elsewhere before the correction fired.
  useEffect(() => {
    const target = initialPageIdRef.current;
    if (!target || pageIds.indexOf(target) <= 0) return;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    const opts = { passive: true, once: true } as const;
    // `pointerdown` covers click/scrollbar navigation (thumbnail, PageNav,
    // jumper, xref, scrollbar drag); wheel/touch/keydown cover the rest — so
    // ANY user navigation within the window cancels the correction.
    window.addEventListener('pointerdown', cancel, opts);
    window.addEventListener('wheel', cancel, opts);
    window.addEventListener('touchstart', cancel, opts);
    window.addEventListener('keydown', cancel, { once: true });
    const t = window.setTimeout(() => {
      if (cancelled) return; // user navigated/interacted first
      if (currentIdRef.current === target) return; // already exact — nothing to correct (avoids a zero-distance suppression stall)
      scrollerRef.current?.scrollToPage(target);
    }, 600);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('pointerdown', cancel);
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchstart', cancel);
      window.removeEventListener('keydown', cancel);
    };
    // Mount-only: corrects the initial deep-link landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useKeyboardNav({
    pageIds,
    currentId,
    onGo: (next) => navigateTo(next, { smooth: true }),
  });

  // Cross-reference navigation history. SearchBar routes through xrefJump so
  // each hit-pick / auto-jump records the page being left; any other navigation
  // (arrow keys, PageNav, PageJumper, passive scroll) changes currentId without
  // a pending marker and clears the chain. navigateTo is stable, so xrefJump/pop
  // stay as referentially stable as currentId allows.
  const stableGo = useCallback(
    (id: string) => navigateTo(id, { smooth: false }),
    [navigateTo],
  );
  const { stack, xrefJump, pop } = useJumpStack({
    currentPageId: currentId,
    go: stableGo,
  });

  // Doc metadata only — stable per doc, so scrolling (which changes currentId
  // on every page boundary) doesn't hand every useDoc() consumer a new context
  // value. The viewed page travels through its own CurrentPageContext.
  const docMeta = useMemo(
    () => ({
      id: doc.id,
      title: doc.title,
      locale: doc.locale,
      pageFiles: doc.pageFiles,
      pageIds: doc.pageIds,
    }),
    [doc],
  );

  return (
    <DocProvider value={docMeta} currentPageId={currentId}>
      <div className="min-h-screen">
        <header
          data-inspector-ui
          className="px-8 py-4 border-b border-rule bg-paper sticky top-0 z-30"
        >
          <div className="max-w-[1600px] mx-auto flex items-baseline justify-between gap-6">
            <div className="flex items-baseline gap-4">
              <button
                type="button"
                onClick={() => go({ docId: null })}
                title="Back to all documents"
                className="font-display text-[20px] font-semibold tracking-[-0.01em] text-ink hover:text-accent"
              >
                inter<span className="text-accent">·</span>linear
              </button>
              <span className="eyebrow">post-editing workbench</span>
            </div>
            <div className="flex items-baseline gap-6">
              <div className="eyebrow text-ink-faded">
                {doc.title} · {currentId ?? '—'} · {doc.locale ?? ''}
              </div>
              {currentId && (
                <PageNav
                  pageIds={pageIds}
                  currentId={currentId}
                  onGo={(id) => navigateTo(id, { smooth: true })}
                />
              )}
              <ThemeToggle />
            </div>
          </div>
        </header>
        <PageScroller
          ref={scrollerRef}
          pageIds={pageIds}
          loadPage={doc.loadPage}
          initialPageId={initialPageIdRef.current}
          headerOffset={HEADER_OFFSET}
          onVisiblePageChange={handleVisiblePageChange}
        />
        <PageThumbStrip
          pageIds={pageIds}
          currentId={currentId}
          onGo={(id) => navigateTo(id, { push: true })}
          thumbnailSrc={(id) => `/${doc.id}/${id}.png`}
        />
        <PageJumper
          pageIds={pageIds}
          currentId={currentId}
          onGo={(id) => navigateTo(id, { push: true })}
        />
        {import.meta.env.DEV && <SearchBar onGoToPage={xrefJump} />}
        {import.meta.env.DEV && <DocChat />}
        {import.meta.env.DEV && <Inspector onGoToPage={xrefJump} />}
        <JumpBackPill stack={stack} onPop={pop} />
      </div>
    </DocProvider>
  );
}

export function App() {
  const [route, go] = useDocRoute();

  // Auto-select the single doc if there's only one — keeps the legacy
  // "one PDF, one server" feel when the user hasn't grown into multi-doc yet.
  // Fire ONCE: without this guard, backing out of the doc to Home (browser Back
  // in single-doc mode) would instantly re-select and remount at page 1 —
  // a jarring flash. After the first auto-select, Home stays Home.
  const didResolveInitialRef = useRef(false);
  useEffect(() => {
    // Arm on the FIRST run regardless of how we entered — including a direct
    // deep link (#/d/doc/p/page), where route.docId is already set so no
    // auto-select happens. Otherwise the flag would stay unarmed and a later
    // click to Home would be re-hijacked straight back into the doc.
    if (didResolveInitialRef.current) return;
    didResolveInitialRef.current = true;
    if (!route.docId && docs.length === 1) {
      go({ docId: docs[0].id });
    }
  }, [route.docId, go]);

  if (!route.docId) {
    return <Home onPick={(id) => go({ docId: id })} />;
  }
  const doc = docs.find((d) => d.id === route.docId);
  if (!doc) {
    return <Home onPick={(id) => go({ docId: id })} />;
  }
  return <DocView key={doc.id} doc={doc} pageId={route.pageId} go={go} />;
}
