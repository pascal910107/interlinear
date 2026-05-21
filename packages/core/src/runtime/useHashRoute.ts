import { useEffect, useState } from 'react';

export type DocRoute = {
  docId: string | null;
  pageId: string | null;
};

export type DocRoutePatch = {
  docId?: string | null | undefined;
  pageId?: string | null | undefined;
};

const DOC_RE = /^#\/d\/([^/?]+)(?:\/p\/([^/?]+))?/;

function readRoute(): DocRoute {
  if (typeof window === 'undefined') return { docId: null, pageId: null };
  const m = DOC_RE.exec(window.location.hash);
  if (!m) return { docId: null, pageId: null };
  return { docId: decodeURIComponent(m[1]), pageId: m[2] ? decodeURIComponent(m[2]) : null };
}

function formatRoute({ docId, pageId }: DocRoute): string {
  if (!docId) return '';
  const docPart = `/d/${encodeURIComponent(docId)}`;
  if (!pageId) return `#${docPart}`;
  return `#${docPart}/p/${encodeURIComponent(pageId)}`;
}

/**
 * Two-level hash route for multi-doc workspaces.
 *
 *   #                              → home (no doc selected)
 *   #/d/<docId>                    → doc selected, no specific page
 *   #/d/<docId>/p/<pageId>         → specific page within doc
 *
 * `go({ pageId: 'page-0002' })` keeps the current docId; pass `docId: null`
 * to return to the home view.
 */
export function useDocRoute(): [DocRoute, (patch: DocRoutePatch) => void] {
  const [route, setRoute] = useState<DocRoute>(readRoute);

  useEffect(() => {
    function onChange() {
      setRoute(readRoute());
    }
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  function go(patch: DocRoutePatch) {
    const cur = readRoute();
    const next: DocRoute = {
      docId: patch.docId === undefined ? cur.docId : patch.docId,
      pageId: patch.pageId === undefined ? cur.pageId : patch.pageId,
    };
    // Changing docId without specifying pageId clears the pageId.
    if (patch.docId !== undefined && patch.pageId === undefined) {
      next.pageId = null;
    }
    const target = formatRoute(next);
    if (window.location.hash === target) return;
    if (target === '') {
      // Clear hash without leaving a stray "#" that React-style routers re-trigger.
      const url = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, '', url);
      setRoute({ docId: null, pageId: null });
      // Fire a synthetic event in case listeners are attached.
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.location.hash = target;
    }
  }

  return [route, go];
}

/**
 * Back-compat for callers that still want the bare pageId string. Returns
 * the pageId segment of the current doc route, or null.
 */
export function useHashPageId(): string | null {
  const [route] = useDocRoute();
  return route.pageId;
}
