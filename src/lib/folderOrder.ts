import type { FolderNode } from '@/lib/types';

/**
 * Orders a folder tree the way a file manager does, on every level: folders first, the
 * projects below them (like files below the directories), each group case-insensitive, by the
 * rules of the UI language (umlauts next to their base letter) and with digit runs as numbers
 * ("Part 2" before "Part 10"). The engine hands the tree over in byte order of the names
 * (uppercase before lowercase, "10" before "2", umlauts last); it does not know the UI language,
 * so the order is made here. Returns a new tree, the input is left alone.
 */
export function sortFolderTree(nodes: FolderNode[], locale: string): FolderNode[] {
  const collator = new Intl.Collator(locale, { numeric: true });
  const sort = (list: FolderNode[]): FolderNode[] =>
    list
      .map((n) => ({ ...n, children: sort(n.children) }))
      // names that only differ in a way the collator ignores keep a stable, defined order
      .sort((a, b) => Number(a.is_project) - Number(b.is_project) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sort(nodes);
}
