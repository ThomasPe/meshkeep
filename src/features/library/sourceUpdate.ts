// Batch "update from the source page" (#69): runs the single-project flow of the "From the
// model page" dialog (read the page, write chosen fields through the normal sidecar save with
// the stamp the project was read with, download the cover) for many projects, one after the
// other. Nothing here fetches or parses a page itself; every step is an engine command.
import type { Backend } from '@/lib/backend';
import { isAppError, type PageSuggestion, type Project, type ProjectSummary, type UpdateMetadata } from '@/lib/types';

export type SourceField = 'title' | 'creator' | 'license' | 'description' | 'tags' | 'image';
export interface SourceUpdateOptions {
  /** Write title, creator, license, description and tags. */
  metadata: boolean;
  /** Download the page's cover picture and make it the preview. */
  image: boolean;
  /** `fill` only writes what the project lacks; `overwrite` replaces what the page says otherwise. */
  mode: 'fill' | 'overwrite';
}
export const DEFAULT_OPTIONS: SourceUpdateOptions = { metadata: true, image: true, mode: 'fill' };

export type SkipReason = 'no_link' | 'offline' | 'nothing_new' | 'cancelled';
export type SourceResult = { id: string; title: string } & (
  | { status: 'updated'; changed: SourceField[] }
  | { status: 'skipped'; reason: SkipReason }
  /** `changed` lists what was written before the failure (metadata is saved before the picture). */
  | { status: 'failed'; code: string; message: string; changed: SourceField[] }
);
export interface SourceProgress { done: number; total: number; current: string | null }

type Target = Pick<ProjectSummary, 'id' | 'title' | 'offline'>;
type Api = Pick<Backend, 'getProject' | 'projectHints' | 'fetchModelPage' | 'updateMetadata' | 'setPageThumbnail'>;

/**
 * What the page would change in a project. Like the single-project dialog, a field is only
 * touched when the page says something different, and tags are merged, never removed. In
 * `fill` mode a field the project already has stays as it is (the title always has a value).
 */
export function planMetadata(p: Project, s: PageSuggestion, mode: SourceUpdateOptions['mode']): { update: UpdateMetadata; fields: SourceField[] } {
  const update: UpdateMetadata = {};
  const fields: SourceField[] = [];
  const overwrite = mode === 'overwrite';
  if (overwrite && s.title && s.title !== p.title) { update.title = s.title; fields.push('title'); }
  for (const f of ['creator', 'license', 'description'] as const) {
    const value = s[f];
    if (value && value !== (p[f] ?? '') && (overwrite || !p[f])) { update[f] = value; fields.push(f); }
  }
  if (s.tags.some((x) => !p.tags.includes(x)) && (overwrite || p.tags.length === 0)) { update.tags = [...new Set([...p.tags, ...s.tags])]; fields.push('tags'); }
  return { update, fields };
}

/** The cover is downloaded when the page names one and, in `fill` mode, no preview was chosen yet. */
export function wantsImage(p: Project, s: PageSuggestion, opts: SourceUpdateOptions): boolean {
  return opts.image && !!s.image && (opts.mode === 'overwrite' || !p.thumbnail);
}

const failure = (e: unknown): { code: string; message: string } =>
  isAppError(e) ? { code: e.code, message: e.message } : { code: 'unknown', message: e instanceof Error ? e.message : String(e) };

/**
 * Runs the update for `targets` in order. One project's failure never stops the rest; a
 * cancel (`signal`) finishes the project in work and reports the others as skipped. Requests
 * to the model sites are spaced by `gapMs`, like the engine's own batch read (1 request/s).
 */
export async function runSourceUpdate(
  api: Api,
  targets: Target[],
  opts: SourceUpdateOptions,
  run: { signal?: AbortSignal; gapMs?: number; onProgress?: (p: SourceProgress) => void; onResult?: (r: SourceResult, project: Project | null) => void } = {},
): Promise<SourceResult[]> {
  const gapMs = run.gapMs ?? 1000;
  const results: SourceResult[] = [];
  let lastRequest = 0;
  const polite = async () => {
    const wait = lastRequest + gapMs - Date.now();
    if (lastRequest && wait > 0) await sleep(wait, run.signal);
  };
  for (const [i, t] of targets.entries()) {
    const base = { id: t.id, title: t.title };
    const push = (r: SourceResult, project: Project | null = null) => { results.push(r); run.onResult?.(r, project); };
    if (run.signal?.aborted) { push({ ...base, status: 'skipped', reason: 'cancelled' }); continue; }
    run.onProgress?.({ done: i, total: targets.length, current: t.title });
    if (t.offline) { push({ ...base, status: 'skipped', reason: 'offline' }); continue; }
    const changed: SourceField[] = [];
    let latest: Project | null = null;
    try {
      // read afresh: its stamp guards the write below against an edit made in the meantime
      const p = await api.getProject(t.id);
      if (!p.source_url && (await api.projectHints(t.id)).source_url.length === 0) { push({ ...base, status: 'skipped', reason: 'no_link' }); continue; }
      await polite();
      if (run.signal?.aborted) { push({ ...base, status: 'skipped', reason: 'cancelled' }); continue; }
      let page: PageSuggestion;
      try { page = await api.fetchModelPage(t.id); } catch (e) { lastRequest = Date.now(); throw e; }
      if (!page.cached) lastRequest = Date.now();
      if (opts.metadata) {
        const plan = planMetadata(p, page, opts.mode);
        if (plan.fields.length) {
          // never forced: a sidecar that changed on disk since the read is reported, not overwritten
          latest = await api.updateMetadata(t.id, { ...plan.update, expected_stamp: p.sidecar_stamp ?? null, force: false });
          changed.push(...plan.fields);
        }
      }
      if (wantsImage(p, page, opts)) {
        await polite();
        try { latest = await api.setPageThumbnail(t.id); } finally { lastRequest = Date.now(); }
        changed.push('image');
      }
      push(changed.length ? { ...base, status: 'updated', changed } : { ...base, status: 'skipped', reason: 'nothing_new' }, latest);
    } catch (e) {
      push({ ...base, status: 'failed', ...failure(e), changed }, latest);
    }
  }
  run.onProgress?.({ done: targets.length, total: targets.length, current: null });
  return results;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done);
  });
}
