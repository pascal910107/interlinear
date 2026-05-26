/// <reference path="../vite/client.d.ts" />
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDoc } from './DocContext';

type Identity = { file: string; line: number; col: number };

type Anchor = {
  identity: Identity;
  el: HTMLElement;
  tag: string;
  editableText: string | null; // null → has nested structure, comment-only
};

type PageComment = {
  id: string;
  file: string;
  pageId: string;
  ts: string;
  note: string;
  hint?: string;
  markerLine: number;
  elementLine: number | null;
  elementCol: number | null;
  elementTag: string | null;
};

type Toast = { kind: 'ok' | 'err'; msg: string };

function readAttrs(el: HTMLElement, fileSet: Set<string>): Identity | null {
  const file = el.getAttribute('data-src-file');
  const lineStr = el.getAttribute('data-src-line');
  const colStr = el.getAttribute('data-src-col');
  if (!file || !lineStr || !colStr) return null;
  if (!fileSet.has(file)) return null;
  return { file, line: Number(lineStr), col: Number(colStr) };
}

function readEditableText(el: HTMLElement): string | null {
  if (el.getAttribute('data-src-editable') !== 'true') return null;
  return el.textContent ?? '';
}

function pickAncestorWithSrc(start: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = start;
  while (cur && !cur.hasAttribute?.('data-src-file')) {
    cur = cur.parentElement;
  }
  return cur;
}

function snapshotAnchor(el: HTMLElement, fileSet: Set<string>): Anchor | null {
  const identity = readAttrs(el, fileSet);
  if (!identity) return null;
  return {
    identity,
    el,
    tag: el.tagName.toLowerCase(),
    editableText: readEditableText(el),
  };
}

function findByIdentity(id: Identity): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-src-file="${id.file}"][data-src-line="${id.line}"][data-src-col="${id.col}"]`,
  );
}

function sameIdentity(a: Identity | null, b: Identity | null): boolean {
  if (!a || !b) return a === b;
  return a.file === b.file && a.line === b.line && a.col === b.col;
}

export function Inspector() {
  const doc = useDoc();
  const { pageFiles, currentPageId, id: docId } = doc;

  // Build a stable map/set of valid (pageId → file) pairs from the doc.
  const fileToPageId = useMemo(() => {
    const out = new Map<string, string>();
    for (const [pageId, file] of Object.entries(pageFiles)) out.set(file, pageId);
    return out;
  }, [pageFiles]);
  const fileSet = useMemo(() => new Set(fileToPageId.keys()), [fileToPageId]);
  const pageEntries = useMemo(() => Object.entries(pageFiles), [pageFiles]);

  const [hoverAnchor, setHoverAnchor] = useState<Anchor | null>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [selected, setSelected] = useState<Anchor | null>(null);
  const [selectedRect, setSelectedRect] = useState<DOMRect | null>(null);
  const [textDraft, setTextDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [busy, setBusy] = useState<'text' | 'note' | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const [pageComments, setPageComments] = useState<PageComment[]>([]);
  const [commentsOpen, setCommentsOpen] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);

  const refreshComments = useCallback(async () => {
    try {
      const batches = await Promise.all(
        pageEntries.map(async ([pageId, file]) => {
          try {
            const res = await fetch(`/__list_comments?file=${encodeURIComponent(file)}`);
            const data = (await res.json()) as {
              ok: boolean;
              comments?: Omit<PageComment, 'file' | 'pageId'>[];
            };
            if (!data.ok || !data.comments) return [] as PageComment[];
            return data.comments.map((c) => ({ ...c, file, pageId }));
          } catch {
            return [] as PageComment[];
          }
        }),
      );
      setPageComments(batches.flat());
    } catch {
      // ignore
    }
  }, [pageEntries]);

  // Reset state on doc change so we don't carry hover/selection across docs.
  useEffect(() => {
    setHoverAnchor(null);
    setHoverRect(null);
    setSelected(null);
    setSelectedRect(null);
    setPageComments([]);
  }, [docId]);

  useEffect(() => {
    refreshComments();
    const hot = import.meta.hot;
    const onHmr = () => refreshComments();
    hot?.on('vite:afterUpdate', onHmr);
    hot?.on('interlinear:page-changed', onHmr);
    return () => {
      hot?.off('vite:afterUpdate', onHmr);
      hot?.off('interlinear:page-changed', onHmr);
    };
  }, [refreshComments]);

  useEffect(() => {
    if (!commentsOpen) return;
    function onDown(e: MouseEvent) {
      if (!badgeRef.current?.contains(e.target as Node)) {
        setCommentsOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [commentsOpen]);

  async function deleteComment(c: PageComment) {
    try {
      const res = await fetch('/__delete_comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: c.file, id: c.id }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setToast({ kind: 'ok', msg: `Comment ${c.id} deleted.` });
        refreshComments();
      } else {
        setToast({ kind: 'err', msg: `Delete failed: ${data.error}` });
      }
    } catch (e) {
      setToast({ kind: 'err', msg: `Delete failed: ${String(e)}` });
    }
  }

  function gotoComment(c: PageComment) {
    setCommentsOpen(false);
    const onCurrentPage = currentPageId === c.pageId || pageEntries.length === 1;
    const finish = (attempt = 0): void => {
      if (c.elementLine == null || c.elementCol == null) return;
      const el = findByIdentity({
        file: c.file,
        line: c.elementLine,
        col: c.elementCol,
      });
      if (!el) {
        if (attempt < 20) {
          setTimeout(() => finish(attempt + 1), 50);
        } else {
          setToast({ kind: 'err', msg: 'Target element not found in DOM.' });
        }
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const snap = snapshotAnchor(el, fileSet);
      if (snap) {
        setSelected(snap);
        setSelectedRect(el.getBoundingClientRect());
      }
    };
    if (!onCurrentPage) {
      window.location.hash = `#/d/${encodeURIComponent(docId)}/p/${encodeURIComponent(c.pageId)}`;
      finish(0);
    } else {
      finish(0);
    }
  }

  const selectedKey = useMemo(
    () =>
      selected
        ? `${selected.identity.file}:${selected.identity.line}:${selected.identity.col}`
        : null,
    [selected?.identity.file, selected?.identity.line, selected?.identity.col],
  );

  // biome-ignore lint: deliberate identity-key dependency
  useEffect(() => {
    if (selected) {
      setTextDraft(selected.editableText ?? '');
      setNoteDraft('');
    } else {
      setTextDraft('');
      setNoteDraft('');
    }
  }, [selectedKey]);

  // biome-ignore lint: deliberate identity-key dependency
  useLayoutEffect(() => {
    if (selected?.editableText !== null && textRef.current) {
      textRef.current.focus();
      textRef.current.setSelectionRange(
        textRef.current.value.length,
        textRef.current.value.length,
      );
    }
  }, [selectedKey]);

  const refreshSelectedRect = useCallback(() => {
    setSelected((cur) => {
      if (!cur) return cur;
      const el = cur.el.isConnected ? cur.el : findByIdentity(cur.identity);
      if (!el) {
        setSelectedRect(null);
        return null;
      }
      const nextText = readEditableText(el);
      setSelectedRect(el.getBoundingClientRect());
      if (el === cur.el && nextText === cur.editableText) return cur;
      return {
        identity: cur.identity,
        el,
        tag: el.tagName.toLowerCase(),
        editableText: nextText,
      };
    });
  }, []);

  useEffect(() => {
    refreshSelectedRect();
    const onScroll = () => refreshSelectedRect();
    const onResize = () => refreshSelectedRect();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    const hot = import.meta.hot;
    const onHmr = () => {
      requestAnimationFrame(refreshSelectedRect);
    };
    hot?.on('vite:afterUpdate', onHmr);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      hot?.off('vite:afterUpdate', onHmr);
    };
  }, [refreshSelectedRect]);

  useEffect(() => {
    function inPanel(el: EventTarget | null): boolean {
      return el instanceof Node ? !!panelRef.current?.contains(el) : false;
    }

    function onMove(e: PointerEvent) {
      if (inPanel(e.target)) {
        setHoverAnchor(null);
        setHoverRect(null);
        return;
      }
      const cur = pickAncestorWithSrc(e.target as HTMLElement | null);
      if (!cur) {
        setHoverAnchor(null);
        setHoverRect(null);
        return;
      }
      const snap = snapshotAnchor(cur, fileSet);
      if (!snap) {
        setHoverAnchor(null);
        setHoverRect(null);
        return;
      }
      setHoverAnchor(snap);
      setHoverRect(cur.getBoundingClientRect());
    }

    function onClick(e: MouseEvent) {
      if (inPanel(e.target)) return;
      // XrefScan wraps quoted text in <button.xref-link> buttons that
      // dispatch their own 'interlinear:search' event for click-to-jump.
      // Inspector listens in capture phase, so without this opt-out we'd
      // preventDefault/stopPropagation the click before the button's own
      // onClick runs and the popup would open instead of jumping.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.xref-link')) return;
      const cur = pickAncestorWithSrc(target);

      // Popup open → any click outside it closes, unless it's on the currently
      // selected element (so accidental clicks within the highlight don't dismiss).
      if (selected) {
        const onSelected =
          !!cur && sameIdentity(readAttrs(cur, fileSet), selected.identity);
        if (!onSelected) {
          e.preventDefault();
          e.stopPropagation();
          setSelected(null);
          setSelectedRect(null);
        }
        return;
      }

      // No popup → open one on src elements.
      if (!cur) return;
      const snap = snapshotAnchor(cur, fileSet);
      if (!snap) return;
      e.preventDefault();
      e.stopPropagation();
      setSelected(snap);
      setSelectedRect(cur.getBoundingClientRect());
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement | null;
        if (selected) {
          e.preventDefault();
          if (target && panelRef.current?.contains(target)) {
            (target as HTMLElement).blur?.();
          }
          setSelected(null);
          setSelectedRect(null);
        }
      }
    }

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [selected, fileSet]);

  useEffect(() => {
    if (!hoverAnchor) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = 'pointer';
    return () => {
      document.body.style.cursor = prev;
    };
  }, [hoverAnchor]);

  useEffect(() => {
    if (!toast) return;
    const dwell = Math.min(
      9000,
      Math.max(toast.kind === 'err' ? 5000 : 3000, toast.msg.length * 80),
    );
    const id = setTimeout(() => setToast(null), dwell);
    return () => clearTimeout(id);
  }, [toast]);

  const textDirty = selected?.editableText !== null && textDraft !== (selected?.editableText ?? '');

  async function saveText() {
    if (!selected) return;
    if (selected.editableText === null) return;
    setBusy('text');
    try {
      const res = await fetch('/__apply_edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: selected.identity.file,
          line: selected.identity.line,
          col: selected.identity.col,
          text: textDraft,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setToast({ kind: 'ok', msg: 'Text saved.' });
      } else {
        setToast({ kind: 'err', msg: `Save failed: ${data.error}` });
      }
    } catch (e) {
      setToast({ kind: 'err', msg: `Save failed: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function saveNote() {
    if (!selected) return;
    const note = noteDraft.trim();
    if (!note) return;
    setBusy('note');
    try {
      const res = await fetch('/__apply_comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: selected.identity.file,
          line: selected.identity.line,
          col: selected.identity.col,
          note,
        }),
      });
      const data = (await res.json()) as { ok: boolean; id?: string; error?: string };
      if (data.ok) {
        setToast({ kind: 'ok', msg: `Marker ${data.id} inserted. Run /apply-comments.` });
        setNoteDraft('');
      } else {
        setToast({ kind: 'err', msg: `Failed: ${data.error}` });
      }
    } catch (e) {
      setToast({ kind: 'err', msg: `Request failed: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  const showHoverOverlay =
    hoverAnchor &&
    hoverRect &&
    (!selected || !sameIdentity(hoverAnchor.identity, selected.identity));

  const commentsOnSelected = useMemo(() => {
    if (!selected) return [];
    return pageComments.filter(
      (c) =>
        c.file === selected.identity.file &&
        c.elementLine === selected.identity.line &&
        c.elementCol === selected.identity.col,
    );
  }, [pageComments, selected]);

  const PANEL_W = 384;
  const PANEL_H_EST = 360;
  let panelTop = 0;
  let panelLeft = 0;
  if (selected && selectedRect) {
    const r = selectedRect;
    const spaceRight = window.innerWidth - r.right;
    const spaceLeft = r.left;
    if (spaceRight >= PANEL_W + 16) {
      panelLeft = r.right + 12;
    } else if (spaceLeft >= PANEL_W + 16) {
      panelLeft = r.left - PANEL_W - 12;
    } else {
      panelLeft = Math.max(8, window.innerWidth - PANEL_W - 8);
    }
    panelTop = Math.max(8, Math.min(window.innerHeight - PANEL_H_EST - 8, r.top));
  }

  return (
    <>
      {showHoverOverlay && hoverRect && (
        <div
          className="fixed z-40 pointer-events-none"
          style={{
            top: hoverRect.top - 2,
            left: hoverRect.left - 2,
            width: hoverRect.width + 4,
            height: hoverRect.height + 4,
            border: '1px dashed var(--color-accent)',
            opacity: 0.55,
          }}
        />
      )}

      {selected && selectedRect && (
        <div
          className="fixed z-40 pointer-events-none"
          style={{
            top: selectedRect.top - 2,
            left: selectedRect.left - 2,
            width: selectedRect.width + 4,
            height: selectedRect.height + 4,
            border: '1.5px solid var(--color-accent)',
            background: 'var(--color-accent-tint)',
          }}
        />
      )}

      {selected && selectedRect && (
        <div
          ref={panelRef}
          data-inspector-ui
          className="fixed z-50 flex flex-col"
          style={{
            top: panelTop,
            left: panelLeft,
            width: PANEL_W,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-ink)',
            boxShadow: '4px 4px 0 var(--color-ink)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-rule">
            <div className="flex items-center gap-2 min-w-0">
              <span className="tag-chip">&lt;{selected.tag}&gt;</span>
              <span className="font-mono text-[10px] text-ink-muted truncate">
                {selected.identity.file}:
                <span className="numeric text-ink">{selected.identity.line}</span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setSelectedRect(null);
              }}
              className="font-mono text-[11px] text-ink-faded hover:text-accent px-1"
              title="Deselect (Esc)"
            >
              ESC ✕
            </button>
          </div>

          <div className="flex flex-col gap-3 p-3">
            {commentsOnSelected.length > 0 && (
              <section
                className="px-3 py-2"
                style={{
                  background: 'var(--color-warn-soft)',
                  borderLeft: '3px solid var(--color-warn)',
                }}
              >
                <div className="eyebrow mb-1.5" style={{ color: '#7a5710' }}>
                  Pending · {commentsOnSelected.length} on this element
                </div>
                <ul className="flex flex-col gap-1.5">
                  {commentsOnSelected.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-start gap-2 text-[13px] leading-snug text-ink"
                    >
                      <span className="text-accent leading-none mt-0.5">¶</span>
                      <span className="flex-1 break-words whitespace-pre-wrap font-body">
                        {c.note}
                      </span>
                      <button
                        type="button"
                        onClick={() => deleteComment(c)}
                        className="flex-none font-mono text-[10px] text-ink-faded hover:text-accent uppercase tracking-wider"
                        title="Delete marker"
                      >
                        DEL
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {selected.editableText !== null ? (
              <section className="flex flex-col gap-1.5">
                <div className="eyebrow">編輯譯文 · revise translation</div>
                <textarea
                  ref={textRef}
                  value={textDraft}
                  onChange={(e) => setTextDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      saveText();
                    }
                  }}
                  rows={4}
                  className="field resize-y"
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] tracking-wider uppercase flex items-center gap-1.5">
                    {textDirty ? (
                      <>
                        <span
                          className="inline-block size-1.5 rounded-full"
                          style={{ background: 'var(--color-accent)' }}
                        />
                        <span style={{ color: 'var(--color-accent)' }}>Unsaved</span>
                      </>
                    ) : (
                      <>
                        <span
                          className="inline-block size-1.5 rounded-full"
                          style={{ background: 'var(--color-ok)' }}
                        />
                        <span style={{ color: 'var(--color-ok)' }}>Saved</span>
                      </>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-ink-faded tracking-wider">
                      ⌘↩
                    </span>
                    <button
                      type="button"
                      onClick={saveText}
                      disabled={!textDirty || busy === 'text'}
                      className="btn-accent"
                    >
                      {busy === 'text' ? 'Saving' : 'Save text'}
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              <section
                className="px-3 py-2 font-body italic text-[12.5px] text-ink-muted"
                style={{
                  background: 'var(--color-paper-deep)',
                  borderLeft: '3px solid var(--color-rule)',
                }}
              >
                此元素含巢狀結構，無法直接編輯文字。請改用下方留言請 agent 處理。
              </section>
            )}

            <div className="h-px bg-rule" />

            <section className="flex flex-col gap-1.5">
              <div className="eyebrow">留言給 agent · note for agent</div>
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    saveNote();
                  }
                }}
                rows={3}
                placeholder="e.g. 把『register』翻成『暫存器』，跟其他章節一致"
                className="field resize-y"
              />
              <div className="flex items-center justify-end gap-2">
                <span className="font-mono text-[10px] text-ink-faded tracking-wider">
                  ⌘↩
                </span>
                <button
                  type="button"
                  onClick={saveNote}
                  disabled={!noteDraft.trim() || busy === 'note'}
                  className="btn-ghost"
                >
                  {busy === 'note' ? 'Saving' : 'Leave marker'}
                </button>
              </div>
            </section>
          </div>
        </div>
      )}

      {pageComments.length > 0 && (
        <div
          ref={badgeRef}
          data-inspector-ui
          className="fixed top-16 right-8 z-50"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setCommentsOpen((o) => !o)}
            className="flex items-center gap-2 px-3 py-1.5"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-ink)',
              boxShadow: '3px 3px 0 var(--color-ink)',
            }}
          >
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: 'var(--color-accent)' }}
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink">
              <span className="numeric font-semibold">{pageComments.length}</span> pending
            </span>
          </button>
          {commentsOpen && (
            <div
              className="absolute right-0 mt-2 w-[420px]"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-ink)',
                boxShadow: '4px 4px 0 var(--color-ink)',
              }}
            >
              <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
                <span className="eyebrow">Pending comments</span>
                <span className="font-mono text-[10px] text-ink-faded">
                  run /apply-comments
                </span>
              </div>
              <ul className="max-h-80 overflow-y-auto">
                {pageComments.map((c, i) => (
                  <li
                    key={`${c.pageId}:${c.id}`}
                    className="px-3 py-2.5 flex items-start gap-3 hover:bg-paper-deep"
                    style={{
                      borderTop: i === 0 ? 'none' : '1px solid var(--color-rule-soft)',
                    }}
                  >
                    <span className="font-mono text-[10px] text-ink-muted numeric pt-0.5 w-16 flex-none">
                      {c.pageId}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-[10px] text-ink-muted mb-0.5 uppercase tracking-wider">
                        {c.elementTag ? `<${c.elementTag}>` : 'orphan'}
                        {c.elementLine != null && (
                          <span className="numeric"> · L{c.elementLine}</span>
                        )}
                      </div>
                      <div className="font-body text-[13px] text-ink break-words whitespace-pre-wrap leading-snug">
                        {c.note}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 flex-none">
                      <button
                        type="button"
                        onClick={() => gotoComment(c)}
                        className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 border border-rule hover:bg-paper text-ink"
                      >
                        Goto
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteComment(c)}
                        className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 border border-rule hover:bg-accent hover:text-surface hover:border-accent text-ink-muted"
                      >
                        Del
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

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
    </>
  );
}
