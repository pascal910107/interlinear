import {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';

// Quote shapes treated as cross-references. Single-line only — a literal
// newline inside the brackets means it's almost certainly not a reference
// (just nearby punctuation), and we'd otherwise span paragraphs.
// 4+ inner chars filters out trivial decorative quotes like 「OK」.
const QUOTE_RE = /(「[^「」\n]{4,}」|『[^『』\n]{4,}』)/g;

// Tags whose contents should never be turned into cross-references. Code,
// keyboard hints, and the inspector's own JSX should stay untouched.
const SKIP_TAGS = new Set(['code', 'pre', 'kbd', 'samp', 'script', 'style']);

function quoteInner(quoted: string): string {
  // Strip the single outer char on each side (corner brackets are 1 BMP char).
  return quoted.slice(1, -1);
}

/**
 * Scan a string for `「…」` / `『…』` quote spans and wrap each in an
 * <XRef> button. Other characters pass through verbatim.
 */
function transformString(text: string, keyPrefix: string): ReactNode {
  // Fast path: no opener at all, no work to do.
  if (!text.includes('「') && !text.includes('『')) return text;
  const parts = text.split(QUOTE_RE);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    // QUOTE_RE has one capturing group around the whole quote, so the
    // split result alternates [plain, quote, plain, quote, ...].
    if (i % 2 === 1) {
      const inner = quoteInner(part);
      return (
        <XRef key={`${keyPrefix}:${i}`} query={inner}>
          {part}
        </XRef>
      );
    }
    return <Fragment key={`${keyPrefix}:${i}`}>{part}</Fragment>;
  });
}

/**
 * Recursively walk React children and replace `「…」` / `『…』` string
 * spans with clickable cross-reference buttons. Skips code-ish tags and
 * any element whose `data-no-xref` is set.
 *
 * Used by BilingualPage to retrofit every translated page with
 * click-to-jump behavior on quoted English headings — the common pattern
 * for "請參閱「<original heading>」" references after the heading itself
 * has been translated and the English text no longer appears on the
 * target page.
 */
export function scanChildren(children: ReactNode, keyPrefix = 'x'): ReactNode {
  return Children.map(children, (child, idx): ReactNode => {
    const key = `${keyPrefix}.${idx}`;
    if (typeof child === 'string') return transformString(child, key);
    if (typeof child === 'number' || typeof child === 'boolean') return child;
    if (child == null) return child;
    if (Array.isArray(child)) return scanChildren(child, key);
    if (!isValidElement(child)) return child;

    const el = child as ReactElement<{
      children?: ReactNode;
      'data-no-xref'?: unknown;
    }>;
    const tagName = typeof el.type === 'string' ? el.type : null;
    if (tagName && SKIP_TAGS.has(tagName)) return el;
    if (el.props && el.props['data-no-xref'] != null) return el;
    if (el.props?.children == null) return el;
    return cloneElement(el, undefined, scanChildren(el.props.children, key));
  });
}

function emitSearchEvent(query: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<string>('interlinear:search', { detail: query }),
  );
}

/**
 * Renders the original quoted text inline with a subtle dotted underline
 * + pointer affordance. Click fires `interlinear:search` so SearchBar can
 * open prefilled and (when there's a unique off-page hit) auto-jump.
 */
function XRef({ query, children }: { query: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        emitSearchEvent(query);
      }}
      title={`Search «${query}»`}
      className="xref-link"
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
        borderBottom: '1px dotted currentColor',
      }}
    >
      {children}
    </button>
  );
}
