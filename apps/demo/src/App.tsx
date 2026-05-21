import { Suspense, lazy, useMemo } from 'react';
import {
  Inspector,
  PageJumper,
  PageNav,
  ThemeToggle,
  useHashRoute,
  useKeyboardNav,
} from '@interlinear/core';
import { pageIds, loadPage } from 'virtual:interlinear/pages';
import meta from 'virtual:interlinear/meta';

export function App() {
  const [routeId, go] = useHashRoute();
  const currentId = routeId && pageIds.includes(routeId) ? routeId : pageIds[0];

  useKeyboardNav({ pageIds, currentId, onGo: go });

  const Page = useMemo(
    () => (currentId ? lazy(() => loadPage(currentId)) : null),
    [currentId],
  );

  return (
    <div className="min-h-screen">
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
          <div className="flex items-baseline gap-6">
            <div className="eyebrow text-ink-faded">
              {meta.title} · {currentId ?? '—'} · {meta.locale ?? ''}
            </div>
            {currentId && (
              <PageNav pageIds={pageIds} currentId={currentId} onGo={go} />
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>
      {Page && (
        <Suspense fallback={null}>
          <Page />
        </Suspense>
      )}
      <PageJumper pageIds={pageIds} currentId={currentId} onGo={go} />
      {import.meta.env.DEV && <Inspector />}
    </div>
  );
}
