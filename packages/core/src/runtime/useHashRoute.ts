import { useEffect, useState } from 'react';

function readPageId(): string | null {
  const m = /^#\/([^/?]+)/.exec(window.location.hash);
  return m ? m[1] : null;
}

/**
 * Hash-based single-segment route. Returns the current page id (e.g.
 * "page-0001") parsed from `#/page-0001`, or `null` if no hash route is set.
 * Pair with a list of known page ids to render the matching page; fall back
 * to the first id when the hook returns null.
 */
export function useHashRoute(): [string | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readPageId(),
  );

  useEffect(() => {
    function onChange() {
      setId(readPageId());
    }
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  function go(next: string) {
    if (window.location.hash === `#/${next}`) return;
    window.location.hash = `#/${next}`;
  }

  return [id, go];
}
