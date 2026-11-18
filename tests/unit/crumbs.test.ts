import { describe, expect, it } from 'vitest';
import { folderCrumbs, treeAncestorKeys } from '@/lib/crumbs';

describe('breadcrumbs', () => {
  it('builds one step per folder level, each with the path down to itself', () => {
    expect(folderCrumbs('r1', 'D:\\3D Models', 'Projects/Robotics/Arm v4')).toEqual([
      { label: 'D:\\3D Models', filter: { kind: 'root', rootId: 'r1' } },
      { label: 'Projects', filter: { kind: 'folder', rootId: 'r1', path: 'Projects' } },
      { label: 'Robotics', filter: { kind: 'folder', rootId: 'r1', path: 'Projects/Robotics' } },
      { label: 'Arm v4', filter: { kind: 'folder', rootId: 'r1', path: 'Projects/Robotics/Arm v4' } },
    ]);
  });
  it('is the root alone for an empty path and ignores stray slashes', () => {
    expect(folderCrumbs('r1', 'Models', '')).toEqual([{ label: 'Models', filter: { kind: 'root', rootId: 'r1' } }]);
    expect(folderCrumbs('r1', 'Models', '/a//b/').map((c) => c.filter)).toEqual([
      { kind: 'root', rootId: 'r1' },
      { kind: 'folder', rootId: 'r1', path: 'a' },
      { kind: 'folder', rootId: 'r1', path: 'a/b' },
    ]);
  });
  it('names the tree rows above a selection, not the selection itself', () => {
    expect(treeAncestorKeys({ kind: 'root', rootId: 'r1' })).toEqual([]);
    expect(treeAncestorKeys({ kind: 'folder', rootId: 'r1', path: 'Projects' })).toEqual(['r1']);
    expect(treeAncestorKeys({ kind: 'folder', rootId: 'r1', path: 'Projects/Robotics/Arms' })).toEqual(['r1', 'r1:Projects', 'r1:Projects/Robotics']);
  });
});
