import { createContext, useContext, type ReactNode } from 'react';

export type DocContextValue = {
  id: string;
  title: string;
  locale: string | null;
  /** pageId -> path relative to the workspace's docs/ directory. */
  pageFiles: Record<string, string>;
  pageIds: readonly string[];
};

const DocContext = createContext<DocContextValue | null>(null);

// The currently-viewed page lives in its OWN context, separate from the doc
// metadata above. Under the continuous scroller this changes on every page
// boundary crossed while scrolling; keeping it out of DocContext means the
// (stable) doc-metadata value doesn't get a new identity on every scroll, so
// consumers that only need metadata (e.g. DocChat) don't re-render per page.
const CurrentPageContext = createContext<string | null>(null);

export function DocProvider({
  value,
  currentPageId,
  children,
}: {
  value: DocContextValue;
  currentPageId: string | null;
  children: ReactNode;
}) {
  return (
    <DocContext.Provider value={value}>
      <CurrentPageContext.Provider value={currentPageId}>
        {children}
      </CurrentPageContext.Provider>
    </DocContext.Provider>
  );
}

export function useDoc(): DocContextValue {
  const v = useContext(DocContext);
  if (!v) {
    throw new Error(
      'useDoc() called outside <DocProvider>. Components like Inspector, ' +
        'DocChat, SearchBar, and BilingualPage must render inside a doc view.',
    );
  }
  return v;
}

/** Non-throwing variant — returns null when no doc is mounted (e.g. home page). */
export function useDocMaybe(): DocContextValue | null {
  return useContext(DocContext);
}

/** The currently-viewed pageId, or null. Changes as the reader scrolls. */
export function useCurrentPageId(): string | null {
  return useContext(CurrentPageContext);
}
