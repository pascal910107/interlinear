import { Suspense, lazy, useEffect, useMemo } from 'react';
import {
  DocChat,
  DocProvider,
  Inspector,
  PageJumper,
  PageNav,
  PageThumbStrip,
  SearchBar,
  ThemeToggle,
  useDocRoute,
  useKeyboardNav,
} from '@interlinear/core';
import type { DocRoutePatch } from '@interlinear/core';
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
  const currentId =
    pageId && pageIds.includes(pageId) ? pageId : (pageIds[0] ?? null);

  useKeyboardNav({
    pageIds,
    currentId,
    onGo: (next) => go({ pageId: next }),
  });

  const Page = useMemo(
    () => (currentId ? lazy(() => doc.loadPage(currentId)) : null),
    [doc, currentId],
  );

  const ctxValue = useMemo(
    () => ({
      id: doc.id,
      title: doc.title,
      locale: doc.locale,
      pageFiles: doc.pageFiles,
      pageIds: doc.pageIds,
      currentPageId: currentId,
    }),
    [doc, currentId],
  );

  return (
    <DocProvider value={ctxValue}>
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
                  onGo={(id) => go({ pageId: id })}
                />
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
        <PageThumbStrip
          pageIds={pageIds}
          currentId={currentId}
          onGo={(id) => go({ pageId: id })}
          thumbnailSrc={(id) => `/${doc.id}/${id}.png`}
        />
        <PageJumper
          pageIds={pageIds}
          currentId={currentId}
          onGo={(id) => go({ pageId: id })}
        />
        {import.meta.env.DEV && <SearchBar onGoToPage={(id) => go({ pageId: id })} />}
        {import.meta.env.DEV && <DocChat />}
        {import.meta.env.DEV && <Inspector />}
      </div>
    </DocProvider>
  );
}

export function App() {
  const [route, go] = useDocRoute();

  // Auto-select the single doc if there's only one — keeps the legacy
  // "one PDF, one server" feel when the user hasn't grown into multi-doc yet.
  useEffect(() => {
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
  return <DocView doc={doc} pageId={route.pageId} go={go} />;
}
