import { existsSync } from 'node:fs';
import path from 'node:path';
import type { InterlinearConfig } from '../config';

/**
 * Read a doc's `interlinear.config.ts` (or `.js`) via bundle-require so
 * TypeScript and ESM-only configs both work. Returns null when no config
 * file exists or the load fails — callers should fall back to defaults.
 *
 * Shared by `plugin.ts` (for the docs virtual module + safelist) and
 * `search-api.ts` (to discover each doc's sourcePdf for the original-text
 * index). Keeping a single implementation prevents the two sites from
 * drifting on config loader semantics.
 */
export async function loadDocConfig(
  docDir: string,
): Promise<InterlinearConfig | null> {
  const candidates = ['interlinear.config.ts', 'interlinear.config.js'];
  for (const c of candidates) {
    const fp = path.resolve(docDir, c);
    if (!existsSync(fp)) continue;
    try {
      const mod = await import('bundle-require');
      const { mod: loaded } = await mod.bundleRequire({ filepath: fp });
      return (
        (loaded as { default?: InterlinearConfig }).default ??
        (loaded as InterlinearConfig)
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[interlinear] failed to load ${fp}:`, e);
    }
  }
  return null;
}
