import type { LibraryFilter } from '@/lib/store';

/** One step of a breadcrumb trail: what it shows and the library selection it stands for. */
export interface Crumb {
  label: string;
  filter: Extract<LibraryFilter, { kind: 'root' | 'folder' }>;
}

/**
 * The trail from a library root down a `/`-separated path below it: the root first, then one
 * step per folder level, each carrying the path up to and including itself.
 */
export function folderCrumbs(rootId: string, rootLabel: string, relPath: string): Crumb[] {
  const segments = relPath.split('/').filter(Boolean);
  return [
    { label: rootLabel, filter: { kind: 'root', rootId } },
    ...segments.map((label, i): Crumb => ({ label, filter: { kind: 'folder', rootId, path: segments.slice(0, i + 1).join('/') } })),
  ];
}

/**
 * Keys of the tree rows (see `useTree`) that have to be expanded for a selection to be visible
 * in the folder tree: the root and every folder above the selected one.
 */
export function treeAncestorKeys(filter: Crumb['filter']): string[] {
  if (filter.kind === 'root') return [];
  const segments = filter.path.split('/').filter(Boolean);
  return [filter.rootId, ...segments.slice(0, -1).map((_, i) => `${filter.rootId}:${segments.slice(0, i + 1).join('/')}`)];
}
