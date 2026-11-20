import { describe, expect, it } from 'vitest';
import { planMetadata, runSourceUpdate, wantsImage, type SourceUpdateOptions } from '@/features/library/sourceUpdate';
import type { Hints, PageSuggestion, Project, UpdateMetadata } from '@/lib/types';

const project = (o: Partial<Project> = {}): Project => ({
  id: 'r:a', root_id: 'r', rel_path: 'a', title: 'A', creator: null, license: null, source_url: 'https://www.printables.com/model/1', description: null, tags: [],
  thumbnail: null, sidecar_stamp: { mtime_unix_nanos: '1', size: 1 }, offline: false, ...o,
} as Project);
const page = (o: Partial<PageSuggestion> = {}): PageSuggestion => ({ title: 'Page title', creator: 'Maker', license: 'CC0-1.0', description: 'Text', tags: ['x', 'y'], new_tags: [], image: 'https://media.printables.com/1.jpg', url: 'https://www.printables.com/model/1', site: 'printables.com', cached: false, ...o });
const all: SourceUpdateOptions = { metadata: true, image: true, mode: 'fill' };

describe('planMetadata', () => {
  it('fills only what the project lacks and leaves the title alone', () => {
    const { update, fields } = planMetadata(project({ creator: 'Me', tags: ['mine'] }), page(), 'fill');
    expect(fields).toEqual(['license', 'description']);
    expect(update).toEqual({ license: 'CC0-1.0', description: 'Text' });
  });
  it('overwrites what differs and merges tags', () => {
    const { update, fields } = planMetadata(project({ creator: 'Me', license: 'CC0-1.0', tags: ['mine', 'x'] }), page({ description: null }), 'overwrite');
    expect(fields).toEqual(['title', 'creator', 'tags']);
    expect(update).toEqual({ title: 'Page title', creator: 'Maker', tags: ['mine', 'x', 'y'] });
  });
  it('keeps a chosen preview unless overwriting', () => {
    expect(wantsImage(project(), page(), all)).toBe(true);
    expect(wantsImage(project({ thumbnail: 'photo.png' }), page(), all)).toBe(false);
    expect(wantsImage(project({ thumbnail: 'photo.png' }), page(), { ...all, mode: 'overwrite' })).toBe(true);
    expect(wantsImage(project(), page({ image: null }), all)).toBe(false);
    expect(wantsImage(project(), page(), { ...all, image: false })).toBe(false);
  });
});

function fakeApi(projects: Project[], behave: { fail?: string[]; conflict?: string[]; noImage?: string[] } = {}) {
  const calls: string[] = [];
  const writes = new Map<string, UpdateMetadata>();
  const find = (id: string) => projects.find((p) => p.id === id)!;
  return {
    calls,
    writes,
    api: {
      getProject: async (id: string) => ({ ...find(id) }),
      projectHints: async (): Promise<Hints> => ({ creator: [], license: [], source_url: [] }),
      fetchModelPage: async (id: string) => {
        calls.push(`fetch ${id}`);
        if (behave.fail?.includes(id)) throw { code: 'page_fetch', message: 'HTTP 404' };
        return page({ image: behave.noImage?.includes(id) ? null : page().image });
      },
      updateMetadata: async (id: string, u: UpdateMetadata) => {
        calls.push(`write ${id}`);
        if (behave.conflict?.includes(id)) throw { code: 'sidecar_conflict', message: 'changed' };
        writes.set(id, u);
        return find(id);
      },
      setPageThumbnail: async (id: string) => { calls.push(`image ${id}`); return find(id); },
    },
  };
}
const target = (p: Project) => ({ id: p.id, title: p.title, offline: p.offline });

describe('runSourceUpdate', () => {
  const a = project({ id: 'r:a', title: 'A' });
  const b = project({ id: 'r:b', title: 'B', source_url: null });
  const c = project({ id: 'r:c', title: 'C' });
  const d = project({ id: 'r:d', title: 'D' });
  const e = project({ id: 'r:e', title: 'E', offline: true });

  it('skips projects without a link, keeps going after a failure and never forces a write', async () => {
    const f = fakeApi([a, b, c, d, e], { fail: ['r:c'], conflict: ['r:d'] });
    const progress: number[] = [];
    const out = await runSourceUpdate(f.api, [a, b, c, d, e].map(target), all, { gapMs: 0, onProgress: (p) => progress.push(p.done) });
    expect(out.map((r) => r.status)).toEqual(['updated', 'skipped', 'failed', 'failed', 'skipped']);
    expect(out[0]).toMatchObject({ changed: ['creator', 'license', 'description', 'tags', 'image'] });
    expect(out[1]).toMatchObject({ reason: 'no_link' });
    expect(out[2]).toMatchObject({ code: 'page_fetch', message: 'HTTP 404', changed: [] });
    expect(out[3]).toMatchObject({ code: 'sidecar_conflict', changed: [] });
    expect(out[4]).toMatchObject({ reason: 'offline' });
    // the write carries the stamp the project was read with, unforced; no picture after a failed write
    expect(f.writes.get('r:a')).toMatchObject({ expected_stamp: { mtime_unix_nanos: '1', size: 1 }, force: false });
    expect(f.calls).toEqual(['fetch r:a', 'write r:a', 'image r:a', 'fetch r:c', 'fetch r:d', 'write r:d']);
    expect(progress).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('writes only what was chosen', async () => {
    const f = fakeApi([a]);
    expect((await runSourceUpdate(f.api, [target(a)], { ...all, metadata: false }, { gapMs: 0 }))[0]).toMatchObject({ status: 'updated', changed: ['image'] });
    expect(f.calls).toEqual(['fetch r:a', 'image r:a']);
    const full = project({ creator: 'Me', license: 'MIT', description: 'Mine', tags: ['t'], thumbnail: 'photo.png' });
    const g = fakeApi([full]);
    expect((await runSourceUpdate(g.api, [target(full)], all, { gapMs: 0 }))[0]).toMatchObject({ status: 'skipped', reason: 'nothing_new' });
    expect(g.calls).toEqual(['fetch r:a']);
  });

  it('stops after the project in work when cancelled', async () => {
    const f = fakeApi([a, c, d]);
    const ctl = new AbortController();
    const out = await runSourceUpdate(f.api, [a, c, d].map(target), all, { gapMs: 0, signal: ctl.signal, onResult: () => ctl.abort() });
    expect(out.map((r) => (r.status === 'skipped' ? r.reason : r.status))).toEqual(['updated', 'cancelled', 'cancelled']);
    expect(f.calls.filter((x) => x.startsWith('fetch'))).toEqual(['fetch r:a']);
  });

  it('spaces requests to the model site', async () => {
    const f = fakeApi([a, c], { noImage: ['r:a', 'r:c'] });
    const started = Date.now();
    await runSourceUpdate(f.api, [a, c].map(target), { ...all, metadata: false }, { gapMs: 60 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });
});
