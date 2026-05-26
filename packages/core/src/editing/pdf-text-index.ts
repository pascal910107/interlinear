import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-doc background index of the source PDF's plain text. Lets the
 * search endpoint find an English phrase that only appears in the
 * original (e.g. a cross-reference like "請參閱「To display the debug
 * message…」" where the heading itself has been translated to zh-Hant
 * on the target page).
 *
 * Lifecycle:
 *   - Dev server boot triggers start() once with every doc that has a
 *     sourcePdf. Each doc is kicked off in parallel; missing PDFs and
 *     extractor failures are reported per-doc, never thrown.
 *   - First on-disk cache hit (same PDF sha256) resolves instantly with
 *     no Python invocation.
 *   - While extraction is in flight, getStatus() returns
 *     { state: 'extracting' } so SearchBar can surface a banner instead
 *     of silently returning zero original-text hits.
 */

export type PdfIndexState =
  | { state: 'idle' }
  | { state: 'extracting'; startedAt: number }
  | { state: 'ready'; pages: Record<string, string>; pdfHash: string; loadedAt: number }
  | { state: 'error'; error: string };

export type PdfIndexDoc = {
  docId: string;
  /** Absolute path to the doc directory (where .interlinear/ lives). */
  docDir: string;
  /** Absolute path to the source PDF, or null if the doc has none. */
  sourcePdf: string | null;
};

export type PdfTextIndex = {
  /** Kick off background extraction for any doc not already in flight. */
  start(docs: PdfIndexDoc[]): void;
  /** Current state for a doc. Defaults to 'idle' if start() was never called. */
  getStatus(docId: string): PdfIndexState;
  /** Convenience: returns ready pages or null if not ready. */
  getPages(docId: string): Record<string, string> | null;
};

const CACHE_REL = path.join('.interlinear', 'original-text.json');
const CACHE_VERSION = 1;

type CacheFile = {
  version: number;
  pdfHash: string;
  pages: Record<string, string>;
};

async function fileSha256(filepath: string): Promise<string> {
  const buf = await readFile(filepath);
  return createHash('sha256').update(buf).digest('hex');
}

async function loadCache(docDir: string): Promise<CacheFile | null> {
  const fp = path.resolve(docDir, CACHE_REL);
  if (!existsSync(fp)) return null;
  try {
    const data = JSON.parse(await readFile(fp, 'utf8')) as unknown;
    if (!data || typeof data !== 'object') return null;
    const c = data as Partial<CacheFile>;
    if (c.version !== CACHE_VERSION) return null;
    if (typeof c.pdfHash !== 'string') return null;
    if (!c.pages || typeof c.pages !== 'object') return null;
    return c as CacheFile;
  } catch {
    return null;
  }
}

async function saveCache(docDir: string, cache: CacheFile): Promise<void> {
  const fp = path.resolve(docDir, CACHE_REL);
  await mkdir(path.dirname(fp), { recursive: true });
  await writeFile(fp, JSON.stringify(cache), 'utf8');
}

function runExtractor(
  pdfPath: string,
  extractorPath: string,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const tmp = path.join(
      os.tmpdir(),
      `interlinear-text-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.json`,
    );
    const proc = spawn(
      'python3',
      [extractorPath, '--pdf', pdfPath, '--out-json', tmp],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      void unlink(tmp).catch(() => {});
      reject(err);
    });
    proc.on('close', async (code) => {
      if (code !== 0) {
        void unlink(tmp).catch(() => {});
        reject(
          new Error(
            `extract_text.py exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        );
        return;
      }
      try {
        const raw = await readFile(tmp, 'utf8');
        await unlink(tmp).catch(() => {});
        const data = JSON.parse(raw) as { pages?: Record<string, string> };
        if (!data?.pages || typeof data.pages !== 'object') {
          reject(new Error('extract_text.py produced no pages'));
          return;
        }
        resolve(data.pages);
      } catch (e) {
        reject(e);
      }
    });
  });
}

export type CreatePdfTextIndexOptions = {
  /**
   * Absolute path to extract_text.py. The vite plugin passes
   * `<package-root>/src/extract/extract_text.py` resolved from import.meta.url
   * so this module stays decoupled from the runtime package layout.
   */
  extractorPath: string;
};

export function createPdfTextIndex({
  extractorPath,
}: CreatePdfTextIndexOptions): PdfTextIndex {
  const status = new Map<string, PdfIndexState>();

  function setStatus(docId: string, next: PdfIndexState): void {
    status.set(docId, next);
  }

  async function extractOne(doc: PdfIndexDoc): Promise<void> {
    const { docId, docDir, sourcePdf } = doc;
    if (!sourcePdf) {
      setStatus(docId, { state: 'idle' });
      return;
    }
    if (!existsSync(sourcePdf)) {
      setStatus(docId, {
        state: 'error',
        error: `sourcePdf not found: ${sourcePdf}`,
      });
      return;
    }
    setStatus(docId, { state: 'extracting', startedAt: Date.now() });
    try {
      const pdfHash = await fileSha256(sourcePdf);
      const cached = await loadCache(docDir);
      if (cached && cached.pdfHash === pdfHash) {
        setStatus(docId, {
          state: 'ready',
          pages: cached.pages,
          pdfHash,
          loadedAt: Date.now(),
        });
        return;
      }
      const pages = await runExtractor(sourcePdf, extractorPath);
      await saveCache(docDir, { version: CACHE_VERSION, pdfHash, pages });
      setStatus(docId, {
        state: 'ready',
        pages,
        pdfHash,
        loadedAt: Date.now(),
      });
    } catch (e) {
      setStatus(docId, { state: 'error', error: String(e) });
    }
  }

  return {
    start(docs) {
      for (const doc of docs) {
        const cur = status.get(doc.docId);
        if (cur?.state === 'extracting') continue;
        if (cur?.state === 'ready') continue;
        // Fire and forget; status is observable via getStatus().
        void extractOne(doc);
      }
    },
    getStatus(docId) {
      return status.get(docId) ?? { state: 'idle' };
    },
    getPages(docId) {
      const s = status.get(docId);
      return s?.state === 'ready' ? s.pages : null;
    },
  };
}
