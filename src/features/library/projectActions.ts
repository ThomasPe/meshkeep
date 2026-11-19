import type { TFunction } from 'i18next';
import { Archive, Eye, FolderHeart, FolderInput, FolderMinus, FolderOpen, Globe, ImageUp, PackageOpen, Pencil, Plus, Sparkles, Star, StarOff, Trash2, type LucideIcon } from 'lucide-react';
import type { Collection, Project, ProjectSummary } from '@/lib/types';

/** What a project action does; implemented once in `useProjectActions`. */
export interface ProjectActions {
  open: (p: ProjectSummary) => void;
  toggleFavorite: (p: ProjectSummary) => void;
  rename: (p: ProjectSummary) => void;
  remove: (p: ProjectSummary) => void;
  reveal: (p: ProjectSummary) => void;
  /** Opens the "Move to…" folder picker for one or several projects. */
  move: (ps: ProjectSummary[]) => void;
  /** LIB-9: pack the loose models of these projects into a zip each, or extract packed ones again. */
  pack: (ps: ProjectSummary[]) => void;
  unpack: (ps: ProjectSummary[]) => void;
  /** Throws the cached preview away and lets the queue render it again. */
  rerenderThumbnail: (p: ProjectSummary) => void;
  /** Opens the suggestion dialog: an AI answer, or what the model's web page says. */
  suggest: (p: ProjectSummary, mode: 'ai' | 'page') => void;
  /** Add to an existing collection (or `null` to create a new one first). */
  addToCollection: (p: ProjectSummary, collectionId: string | null) => void;
  /** Present only while a manual collection is being viewed. */
  removeFromCollection?: (p: ProjectSummary) => void;
  collections: Collection[];
  filterByCreator: (creator: string) => void;
  /** Multi-selection: delete several projects after one confirmation. */
  removeMany: (ps: ProjectSummary[]) => void;
  addManyToCollection: (ps: ProjectSummary[], collectionId: string | null) => void;
  setFavoriteMany: (ps: ProjectSummary[], favorite: boolean) => void;
}

export type ProjectActionId = 'open' | 'favorite' | 'addToCollection' | 'removeFromCollection' | 'rename' | 'move' | 'reveal' | 'rerenderThumbnail' | 'suggest' | 'fetchPage' | 'pack' | 'unpack' | 'delete';

/** One entry of a sub-menu (the collections of "Add to collection"). */
export interface ProjectActionChoice {
  key: string;
  /** Suffix of the `data-testid`; the surface puts its own prefix in front. */
  testId: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** A separator goes above this entry. */
  separated?: boolean;
  run: () => void;
}

/** One action as a surface shows it: the context menu, the inspector and the details page render this. */
export interface ProjectActionItem {
  id: ProjectActionId;
  /** Suffix of the `data-testid`: `menu-…` in the context menu, `inspector-…`, `project-…`. */
  testId: string;
  /** Label of a menu entry, and tooltip of an icon button. */
  label: string;
  /** Shorter label for a button, where the menu label would be too long. */
  short?: string;
  icon: LucideIcon;
  disabled: boolean;
  destructive?: boolean;
  /** A separator goes above this entry in a menu. */
  separated?: boolean;
  run?: () => void;
  /** A sub-menu instead of `run`. */
  choices?: ProjectActionChoice[];
}

/**
 * THE list of project actions (#70). Every surface that offers actions for a project renders
 * what this returns, so the context menu, the inspector and the details page cannot drift
 * apart: a new action is added here once and shows up in all of them.
 *
 * `targets` is one project, or the selection the context menu acts on. Entries that only make
 * sense for a single project (open, rename, reveal, the suggestions) are left out for many;
 * labels say how many projects an entry acts on.
 */
export function projectActionItems(targets: ProjectSummary[], actions: ProjectActions, t: TFunction): ProjectActionItem[] {
  const p = targets[0];
  if (!p) return [];
  const many = targets.length > 1;
  const n = targets.length;
  const movable = targets.filter((x) => !x.offline && x.rel_path !== '');
  const allFav = targets.every((x) => x.favorite);
  const packable = movable.filter((x) => !x.packed && x.model_count > 0);
  const unpackable = targets.filter((x) => !x.offline && x.packed);
  const items: ProjectActionItem[] = [];

  if (!many) items.push({ id: 'open', testId: 'open', label: t('inspector.open'), icon: Eye, disabled: false, run: () => actions.open(p) });
  items.push({ id: 'favorite', testId: 'favorite', label: t(allFav ? 'favorites.removeN' : 'favorites.addN', { count: n }), icon: allFav ? StarOff : Star, disabled: false, run: () => (many ? actions.setFavoriteMany(targets, !allFav) : actions.toggleFavorite(p)) });
  items.push({
    id: 'addToCollection', testId: 'add-to-collection', label: t('collections.addNTo', { count: n }), icon: FolderHeart, disabled: false,
    choices: [
      ...actions.collections.map((c) => ({ key: c.id, testId: 'collection', label: c.name, disabled: targets.every((x) => c.projects.includes(x.id)), run: () => (many ? actions.addManyToCollection(targets, c.id) : actions.addToCollection(p, c.id)) })),
      { key: '', testId: 'new-collection', label: t('collections.new'), icon: Plus, separated: actions.collections.length > 0, run: () => (many ? actions.addManyToCollection(targets, null) : actions.addToCollection(p, null)) },
    ],
  });
  const removeFrom = actions.removeFromCollection;
  if (removeFrom) items.push({ id: 'removeFromCollection', testId: 'remove-from-collection', label: t('collections.removeNFrom', { count: n }), icon: FolderMinus, disabled: false, run: () => { for (const x of targets) removeFrom(x); } });
  if (!many) items.push({ id: 'rename', testId: 'rename', label: t('actions.rename'), icon: Pencil, disabled: p.offline || p.rel_path === '', run: () => actions.rename(p) });
  items.push({ id: 'move', testId: 'move', label: t('actions.moveN', { count: n }), icon: FolderInput, disabled: movable.length === 0, run: () => actions.move(movable) });
  if (!many) items.push({ id: 'reveal', testId: 'reveal', label: t('inspector.reveal'), icon: FolderOpen, disabled: p.offline, run: () => actions.reveal(p) });
  items.push({ id: 'rerenderThumbnail', testId: 'rethumb', label: t('actions.rerenderN', { count: n }), icon: ImageUp, disabled: targets.every((x) => x.offline), run: () => { for (const x of targets) if (!x.offline) actions.rerenderThumbnail(x); } });
  if (!many) {
    items.push({ id: 'suggest', testId: 'suggest', label: t('inspector.suggest'), icon: Sparkles, disabled: p.offline, run: () => actions.suggest(p, 'ai') });
    items.push({ id: 'fetchPage', testId: 'fetch-page', label: t('inspector.page.suggest'), icon: Globe, disabled: p.offline, run: () => actions.suggest(p, 'page') });
  }
  if (packable.length > 0) items.push({ id: 'pack', testId: 'pack', label: t('actions.packN', { count: packable.length }), short: many ? undefined : t('actions.pack'), icon: Archive, disabled: false, run: () => actions.pack(packable) });
  if (unpackable.length > 0) items.push({ id: 'unpack', testId: 'unpack', label: t('actions.unpackN', { count: unpackable.length }), icon: PackageOpen, disabled: false, run: () => actions.unpack(unpackable) });
  items.push({ id: 'delete', testId: 'delete', label: t('actions.deleteN', { count: n }), icon: Trash2, disabled: movable.length === 0, destructive: true, separated: true, run: () => (many ? actions.removeMany(movable) : actions.remove(p)) });
  return items;
}

/** The list entry of a fully loaded project, which is what the actions take. */
export function toSummary(p: Project): ProjectSummary {
  return { id: p.id, root_id: p.root_id, rel_path: p.rel_path, title: p.title, creator: p.creator, tags: p.tags, thumbnail: p.thumbnail, file_count: p.files.length, model_count: p.model_count, total_bytes: p.total_bytes, modified: p.modified, has_sidecar: p.sidecar.state === 'ok', offline: p.offline, favorite: p.favorite, added: p.added, thumb: p.thumb, slicer: p.slicer, packed: p.packed };
}
