/// <reference path="../vite/client.d.ts" />
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDoc } from './DocContext';

type Entry = {
  id: string;
  askedAt: string;
  question: string;
  answer: string | null;
  answeredAt: string | null;
};

type Toast = { kind: 'ok' | 'err'; msg: string };

const STORAGE_KEY = 'interlinear:docchat-open';
const PANEL_W = 380;
const HANDLE_W = 22;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

// Minimal markdown renderer for the agent's answers. Supports the
// subset the ask-doc skill emits: paragraphs separated by blank lines,
// `- ` bullet lists, **bold**, and `code`. Anything else falls through
// as plain text. We avoid pulling in react-markdown for one dev-only
// panel.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      parts.push(<strong key={`${keyPrefix}-b${i}`}>{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      parts.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="font-mono text-[12px]"
          style={{ color: 'var(--color-accent)' }}
        >
          {m[2]}
        </code>,
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MarkdownAnswer({ text }: { text: string }) {
  // Split into blocks on blank lines, then within each block detect
  // whether it's a bullet list (every line starts with `- `) or a
  // paragraph. Single newlines inside a paragraph become spaces.
  const blocks = text.split(/\n\s*\n/);
  return (
    <>
      {blocks.map((raw, bi) => {
        const block = raw.trim();
        if (!block) return null;
        const lines = block.split('\n');
        const isList = lines.every((l) => /^\s*-\s+/.test(l));
        if (isList) {
          return (
            <ul
              key={bi}
              className="list-disc pl-5 mb-2 last:mb-0 text-ink leading-relaxed"
            >
              {lines.map((l, li) => (
                <li key={li}>
                  {renderInline(l.replace(/^\s*-\s+/, ''), `b${bi}l${li}`)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi} className="mb-2 last:mb-0 text-ink leading-relaxed">
            {renderInline(block.replace(/\n/g, ' '), `b${bi}`)}
          </p>
        );
      })}
    </>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Document-level Q&A sidebar. The user asks free-form questions about
 * the whole translated document; the question is persisted in
 * `.interlinear/conversation.json` via the dev endpoint. The user then
 * runs the `ask-doc` SKILL in their Claude Code session, the agent
 * grounds answers in `pages/*` and writes them back, and this panel
 * picks up the change via the WS broadcast.
 *
 * Dev-only: returns null in production (the endpoint is dev-only too,
 * so the sidebar would have nothing to talk to).
 */
export function DocChat() {
  const { id: docId } = useDoc();
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const knownIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
    } catch {
      // ignore quota / private-mode errors
    }
  }, [open]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/__doc_qa?doc=${encodeURIComponent(docId)}`);
      const data = (await res.json()) as { ok: boolean; entries?: Entry[] };
      if (data.ok && data.entries) setEntries(data.entries);
    } catch {
      // ignore — keep last good state
    }
  }, [docId]);

  // Clear stale entries when switching docs so we don't briefly show
  // the previous doc's conversation while the new one is loading.
  useEffect(() => {
    setEntries([]);
    knownIdsRef.current = new Set();
  }, [docId]);

  useEffect(() => {
    refresh();
    const hot = import.meta.hot;
    const onChange = (data?: { docId?: string }) => {
      if (!data?.docId || data.docId === docId) refresh();
    };
    hot?.on('interlinear:doc-qa-changed', onChange);
    return () => {
      hot?.off('interlinear:doc-qa-changed', onChange);
    };
  }, [refresh, docId]);

  // Global `c` toggles the sidebar.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'c') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setOpen((o) => !o);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Focus input when opening.
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => textareaRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Keep the bottom (latest) visible when entries change.
  useLayoutEffect(() => {
    if (!open) return;
    listEndRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
  }, [open, entries.length]);

  // Auto-expand newly-arrived entries; prune ids no longer in the list.
  // This way: ask a new question → it pops open. Old answers stay
  // collapsed once the user collapses them. Default seed (component
  // mount) expands the latest entry only.
  useEffect(() => {
    const currentIds = new Set(entries.map((e) => e.id));
    setExpandedIds((cur) => {
      const next = new Set<string>();
      for (const id of cur) {
        if (currentIds.has(id)) next.add(id);
      }
      const isInitialMount = knownIdsRef.current.size === 0 && entries.length > 0;
      if (isInitialMount) {
        const last = entries[entries.length - 1];
        if (last) next.add(last.id);
      } else {
        for (const id of currentIds) {
          if (!knownIdsRef.current.has(id)) next.add(id);
        }
      }
      knownIdsRef.current = currentIds;
      return next;
    });
  }, [entries]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    // Same length-scaled dwell as the Inspector toast (see Inspector.tsx).
    // The "Run /ask-doc…" hint here is ~50 chars → ~4s.
    const dwell = Math.min(
      9000,
      Math.max(toast.kind === 'err' ? 5000 : 3000, toast.msg.length * 80),
    );
    const id = setTimeout(() => setToast(null), dwell);
    return () => clearTimeout(id);
  }, [toast]);

  async function send() {
    const q = draft.trim();
    if (!q) return;
    setBusy(true);
    try {
      const res = await fetch(`/__doc_qa/ask?doc=${encodeURIComponent(docId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = (await res.json()) as { ok: boolean; entry?: Entry; error?: string };
      if (data.ok && data.entry) {
        setDraft('');
        // The WS broadcast triggers a refresh; surface the hint either way.
        setToast({
          kind: 'ok',
          msg: 'Question queued. Run /ask-doc in your Claude Code session.',
        });
        // Optimistic update in case the WS event is slow.
        setEntries((cur) => {
          if (cur.some((e) => e.id === data.entry?.id)) return cur;
          return [...cur, data.entry!];
        });
      } else {
        setToast({ kind: 'err', msg: `Ask failed: ${data.error ?? 'unknown'}` });
      }
    } catch (e) {
      setToast({ kind: 'err', msg: `Ask failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntry(id: string) {
    try {
      const res = await fetch(`/__doc_qa/delete?doc=${encodeURIComponent(docId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) setToast({ kind: 'err', msg: `Delete failed: ${data.error}` });
    } catch (e) {
      setToast({ kind: 'err', msg: `Delete failed: ${String(e)}` });
    }
  }

  if (!import.meta.env.DEV) return null;

  const pendingCount = entries.filter((e) => e.answer === null).length;

  return (
    <aside
      data-inspector-ui
      className="fixed right-0 z-30 flex flex-row-reverse"
      style={{
        top: 65,
        bottom: 0,
        transform: open ? 'translateX(0)' : `translateX(${PANEL_W}px)`,
        transition: 'transform 160ms ease',
      }}
    >
      <div
        className="flex flex-col"
        style={{
          width: PANEL_W,
          background: 'var(--color-surface)',
          borderLeft: '1px solid var(--color-ink)',
          boxShadow: open ? '-3px 0 0 var(--color-ink)' : 'none',
        }}
      >
        <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="eyebrow">Ask the document</span>
            {pendingCount > 0 && (
              <span
                className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5"
                style={{
                  background: 'var(--color-warn-soft)',
                  color: '#7a5710',
                  border: '1px solid var(--color-warn)',
                }}
                title="Pending — run /ask-doc"
              >
                {pendingCount} pending
              </span>
            )}
          </div>
          <span className="font-mono text-[10px] text-ink-faded uppercase tracking-wider">
            run /ask-doc
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4">
          {entries.length === 0 && (
            <div
              className="px-3 py-3 font-body italic text-[12.5px] text-ink-muted"
              style={{
                background: 'var(--color-paper-deep)',
                borderLeft: '3px solid var(--color-rule)',
              }}
            >
              提問關於整份文件的問題 — agent 會讀過 pages/* 然後回答。
              <br />
              例：「strict 模式跟 quiet 有什麼差別？」「第 1.3 節在講什麼？」
            </div>
          )}
          {entries.map((e) => {
            const answered = e.answer !== null;
            const expanded = expandedIds.has(e.id);
            return (
              <div key={e.id} className="flex flex-col gap-1.5">
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: row acts as a disclosure;
                    the chevron is keyboard-actionable via the embedded toggle button below */}
                <div
                  className="flex items-start gap-2 cursor-pointer select-none"
                  onClick={() => toggleExpanded(e.id)}
                  title={expanded ? 'Collapse' : 'Expand'}
                >
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      toggleExpanded(e.id);
                    }}
                    className="font-mono text-[11px] mt-0.5 numeric flex-none w-3"
                    style={{ color: 'var(--color-ink-muted)' }}
                    aria-label={expanded ? 'Collapse answer' : 'Expand answer'}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div
                      className={`font-body text-[13.5px] text-ink leading-snug break-words ${
                        expanded ? 'whitespace-pre-wrap' : 'line-clamp-1'
                      }`}
                      style={
                        expanded
                          ? undefined
                          : {
                              display: '-webkit-box',
                              WebkitLineClamp: 1,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }
                      }
                    >
                      {e.question}
                    </div>
                    <div className="font-mono text-[10px] text-ink-faded mt-0.5 flex items-center gap-2">
                      <span>{formatTime(e.askedAt)}</span>
                      {!expanded && !answered && (
                        <span
                          className="uppercase tracking-wider"
                          style={{ color: 'var(--color-warn)' }}
                        >
                          · pending
                        </span>
                      )}
                      {!expanded && answered && (
                        <span
                          className="uppercase tracking-wider"
                          style={{ color: 'var(--color-ok)' }}
                        >
                          · answered
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      deleteEntry(e.id);
                    }}
                    className="flex-none font-mono text-[10px] text-ink-faded hover:text-accent uppercase tracking-wider"
                    title="Delete this thread"
                  >
                    DEL
                  </button>
                </div>
                {expanded && (
                <div
                  className="px-3 py-2 ml-4"
                  style={{
                    background: answered
                      ? 'var(--color-paper-deep)'
                      : 'var(--color-warn-soft)',
                    borderLeft: `3px solid ${
                      answered ? 'var(--color-ok)' : 'var(--color-warn)'
                    }`,
                  }}
                >
                  {answered ? (
                    <>
                      <div className="font-mono text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--color-ok)' }}>
                        Answer · {e.answeredAt ? formatTime(e.answeredAt) : ''}
                      </div>
                      <div className="font-body text-[13px] text-ink leading-relaxed break-words">
                        <MarkdownAnswer text={e.answer ?? ''} />
                      </div>
                    </>
                  ) : (
                    <div
                      className="font-mono text-[11px] uppercase tracking-wider italic"
                      style={{ color: '#7a5710' }}
                    >
                      Pending · run /ask-doc to answer
                    </div>
                  )}
                </div>
                )}
              </div>
            );
          })}
          <div ref={listEndRef} />
        </div>

        <div className="border-t border-rule p-3 flex flex-col gap-1.5">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                send();
              }
            }}
            rows={3}
            placeholder="Ask the document anything…"
            className="field resize-y"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-ink-faded tracking-wider">
              ⌘↩ send
            </span>
            <button
              type="button"
              onClick={send}
              disabled={!draft.trim() || busy}
              className="btn-accent"
            >
              {busy ? 'Sending' : 'Ask'}
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Hide DocChat (c)' : 'Show DocChat (c)'}
        className="flex items-center justify-center font-mono text-[12px] text-ink relative"
        style={{
          width: HANDLE_W,
          background: 'var(--color-surface)',
          borderLeft: '1px solid var(--color-ink)',
          borderTop: '1px solid var(--color-ink)',
          borderBottom: '1px solid var(--color-ink)',
          boxShadow: '-3px 3px 0 var(--color-ink)',
          alignSelf: 'flex-start',
          marginTop: 12,
        }}
      >
        {open ? '⟩' : '⟨'}
        {!open && pendingCount > 0 && (
          <span
            className="absolute -top-1 -left-1 size-2 rounded-full"
            style={{ background: 'var(--color-warn)' }}
            title={`${pendingCount} pending`}
          />
        )}
      </button>

      {toast && (
        <div
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] font-mono text-[11px] uppercase tracking-[0.12em] px-4 py-2"
          style={{
            background: toast.kind === 'ok' ? 'var(--color-ok)' : 'var(--color-accent)',
            color: 'var(--color-surface)',
            boxShadow: '3px 3px 0 var(--color-ink)',
          }}
        >
          {toast.msg}
        </div>
      )}
    </aside>
  );
}
