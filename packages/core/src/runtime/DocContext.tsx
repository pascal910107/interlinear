import { createContext, useContext, type ReactNode } from 'react';

export type DocContextValue = {
  id: string;
  title: string;
  locale: string | null;
  /** pageId -> path relative to the workspace's docs/ directory. */
  pageFiles: Record<string, string>;
  pageIds: readonly string[];
  /** Currently-rendered page within the doc, if any. */
  currentPageId: string | null;
};

const DocContext = createContext<DocContextValue | null>(null);

export function DocProvider({
  value,
  children,
}: {
  value: DocContextValue;
  children: ReactNode;
}) {
  return <DocContext.Provider value={value}>{children}</DocContext.Provider>;
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
