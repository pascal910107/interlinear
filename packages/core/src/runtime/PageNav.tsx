type Props = {
  pageIds: readonly string[];
  currentId: string;
  onGo: (id: string) => void;
};

export function PageNav({ pageIds, currentId, onGo }: Props) {
  const index = pageIds.indexOf(currentId);
  const prev = index > 0 ? pageIds[index - 1] : null;
  const next = index >= 0 && index < pageIds.length - 1 ? pageIds[index + 1] : null;

  return (
    <nav
      data-inspector-ui
      className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink"
    >
      <button
        type="button"
        onClick={() => prev && onGo(prev)}
        disabled={!prev}
        className="btn-ghost"
        title={prev ? `Prev · ${prev}` : 'First page'}
      >
        ← Prev
      </button>
      <span className="numeric text-ink-muted px-2">
        <span className="text-ink font-semibold">{index >= 0 ? index + 1 : '—'}</span>
        <span className="text-ink-faded"> / {pageIds.length}</span>
      </span>
      <button
        type="button"
        onClick={() => next && onGo(next)}
        disabled={!next}
        className="btn-ghost"
        title={next ? `Next · ${next}` : 'Last page'}
      >
        Next →
      </button>
    </nav>
  );
}
