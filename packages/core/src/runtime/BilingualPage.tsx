import type { ReactNode } from 'react';
import { scanChildren } from './XrefScan';

type Props = {
  originalSrc: string;
  pageLabel: string;
  footerLeft?: string;
  footerCenter?: string;
  footerRight?: string;
  children: ReactNode;
};

export function BilingualPage({
  originalSrc,
  pageLabel,
  footerLeft,
  footerCenter,
  footerRight,
  children,
}: Props) {
  const showFooter = Boolean(footerLeft || footerCenter || footerRight);
  return (
    <div className="grid grid-cols-2 gap-10 px-8 py-10 max-w-[1600px] mx-auto">
      <aside className="relative">
        <div className="sticky top-20">
          <div className="eyebrow mb-2 flex items-center gap-2">
            <span>Original</span>
            <span className="h-px flex-1 bg-rule" />
            <span className="numeric text-ink-faded">{pageLabel}</span>
          </div>
          <div className="border border-ink bg-surface">
            <img
              src={originalSrc}
              alt={`Original ${pageLabel}`}
              className="w-full h-auto block"
            />
          </div>
        </div>
      </aside>

      <article className="translation-pane flex flex-col min-h-full">
        <div className="eyebrow mb-2 flex items-center gap-2">
          <span>Translation</span>
          <span className="h-px flex-1 bg-rule" />
          <span className="text-ink-faded">zh-Hant</span>
        </div>

        <div className="bg-surface border border-ink flex flex-col flex-1">
          <div className="px-7 py-8 flex-1">{scanChildren(children)}</div>

          {showFooter && (
            <footer className="px-7 py-2 border-t border-rule font-mono text-[10px] tracking-[0.08em] uppercase text-ink-faded flex items-baseline gap-4">
              <span className="numeric flex-none w-12">{footerLeft}</span>
              <span className="flex-1 text-center normal-case tracking-normal font-body italic text-ink-muted">
                {footerCenter}
              </span>
              <span className="flex-none w-32 text-right normal-case tracking-normal font-body italic text-ink-muted">
                {footerRight}
              </span>
            </footer>
          )}
        </div>
      </article>
    </div>
  );
}
