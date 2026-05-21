import { useTheme } from './useTheme';

/**
 * Compact toggle button — mono caps + hairline, fits D15's chrome. The
 * label reads the *current* theme: clicking flips it. No arrow / icon
 * — the button is its own affordance, and the editorial aesthetic
 * doesn't want UI scribble.
 */
export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const next = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      type="button"
      data-inspector-ui
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      className="btn-ghost"
    >
      {theme}
    </button>
  );
}
