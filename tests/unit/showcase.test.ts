import { describe, expect, it } from 'vitest';
import { showcaseFileNames, showcaseLanguage, showcaseProjects, showcaseStl } from '@/lib/backend/showcase';
import { parseStl } from '@/lib/mesh/stl';

// The showcase library only runs when the Store and website screenshots are taken
// (scripts/store-screenshots.mjs), so its models are checked here: a broken generator would
// otherwise show up as an empty card in a picture.
describe('showcase library', () => {
  it('has a model the STL parser accepts behind every file', () => {
    const names = showcaseFileNames();
    expect(new Set(names).size).toBe(names.length); // models are looked up by file name
    for (const name of names) {
      const stl = showcaseStl(name);
      expect(stl, name).not.toBeNull();
      const mesh = parseStl(stl!);
      expect(mesh.triangles, name).toBeGreaterThan(20);
      expect(mesh.positions.every((v) => Number.isFinite(v)), name).toBe(true);
      // a real object: it has a size on every axis and stands on or near the print bed
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, mesh.positions[i + k]!); max[k] = Math.max(max[k]!, mesh.positions[i + k]!); }
      for (let k = 0; k < 3; k++) expect(max[k]! - min[k]!, `${name} axis ${k}`).toBeGreaterThan(5);
      expect(min[2], name).toBeGreaterThan(-10);
    }
    expect(showcaseStl('not_in_the_showcase.stl')).toBeNull();
  });

  it('lists the same projects in both listing languages', () => {
    const en = showcaseProjects('en'), de = showcaseProjects('de');
    expect(de.length).toBe(en.length);
    expect(new Set(en.map((p) => p.path)).size).toBe(en.length);
    expect(new Set(de.map((p) => p.path)).size).toBe(de.length);
    en.forEach((p, i) => {
      expect(de[i]!.files, p.title).toEqual(p.files);
      expect(de[i]!.tags.length, p.title).toBe(p.tags.length);
      expect(p.files[0]!.bytes, p.title).toBe(Math.max(...p.files.map((x) => x.bytes))); // the first file is the preview
    });
    expect(en.some((p) => p.title !== de[en.indexOf(p)]!.title)).toBe(true);
  });

  it('only switches on for a listing language', () => {
    expect(showcaseLanguage('de')).toBe('de');
    expect(showcaseLanguage('en')).toBe('en');
    expect(showcaseLanguage('1')).toBeNull();
    expect(showcaseLanguage(null)).toBeNull();
  });
});
