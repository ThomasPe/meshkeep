import { describe, expect, it } from 'vitest';
import { sortFolderTree } from '@/lib/folderOrder';
import type { FolderNode } from '@/lib/types';

const node = (rel_path: string, children: FolderNode[] = []): FolderNode => ({ name: rel_path.split('/').pop()!, rel_path, project_count: Math.max(1, children.length), is_project: children.length === 0, children });
const names = (list: FolderNode[]) => list.map((n) => n.name);

describe('folder tree order (#74)', () => {
  // the engine's order: byte-wise, so uppercase first, "10" before "2", umlauts after "z"
  const engine = [
    node('Part 10'),
    node('Part 2'),
    node('Zahnrad', [node('Zahnrad/V10'), node('Zahnrad/V9'), node('Zahnrad/b-Teil'), node('Zahnrad/Ärmel')]),
    node('apfel'),
    node('Örtchen'),
  ];

  it('is case-insensitive, natural and locale-aware on the top level', () => {
    expect(names(sortFolderTree(engine, 'de'))).toEqual(['apfel', 'Örtchen', 'Part 2', 'Part 10', 'Zahnrad']);
    expect(names(sortFolderTree(engine, 'en'))).toEqual(['apfel', 'Örtchen', 'Part 2', 'Part 10', 'Zahnrad']);
  });

  it('orders the projects below a folder the same way', () => {
    const zahnrad = sortFolderTree(engine, 'de').find((n) => n.name === 'Zahnrad')!;
    expect(names(zahnrad.children)).toEqual(['Ärmel', 'b-Teil', 'V9', 'V10']);
    expect(zahnrad.children.map((n) => n.rel_path)).toEqual(['Zahnrad/Ärmel', 'Zahnrad/b-Teil', 'Zahnrad/V9', 'Zahnrad/V10']);
  });

  it('leaves the input alone and is stable for names that differ in case only', () => {
    const input = [node('b'), node('A'), node('a')];
    expect(names(sortFolderTree(input, 'en'))).toEqual(names(sortFolderTree([...input].reverse(), 'en')));
    expect(names(sortFolderTree(input, 'en')).at(-1)).toBe('b');
    expect(names(input)).toEqual(['b', 'A', 'a']);
  });
});
