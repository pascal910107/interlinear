import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'interlinear:theme';

function readInitial(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // localStorage may be unavailable (sandbox, private mode); silently fall through.
  }
  return 'light';
}

/**
 * Reads/writes the interlinear color theme. Source of truth is the
 * `data-theme` attribute on `<body>`; CSS tokens flip via the
 * `body[data-theme="dark"]` selector in `tokens.css`. localStorage
 * persists across reloads; before-paint flash is avoided by injecting a
 * tiny inline script in `index.html` (the demo template does this).
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readInitial);

  useEffect(() => {
    document.body.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore — same reasoning as readInitial
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  }, []);

  return [theme, toggle];
}
