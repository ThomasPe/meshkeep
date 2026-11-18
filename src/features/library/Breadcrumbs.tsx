import { useTranslation } from 'react-i18next';
import { type Crumb, treeAncestorKeys } from '@/lib/crumbs';
import { navigate } from '@/lib/router';
import { useTree, useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

/**
 * Selects a root or folder the way a click in the sidebar tree does (same store, same route)
 * and expands the rows above it, so the selection is visible in the tree.
 */
function openCrumb(filter: Crumb['filter']) {
  const tree = useTree.getState();
  for (const key of treeAncestorKeys(filter)) if (tree.open[key] !== true) tree.setOpen(key, true);
  useUi.getState().setFilter(filter);
  navigate({ page: 'library' });
}

/**
 * A breadcrumb trail (#73): every step above the current place is a button that goes there,
 * the current place is plain content marked with `aria-current`.
 */
export function Breadcrumbs({ lead, crumbs, current, className }: { lead?: React.ReactNode; crumbs: Crumb[]; current: React.ReactNode; className?: string }) {
  const { t } = useTranslation();
  const sep = <span aria-hidden="true">/</span>;
  return (
    <nav aria-label={t('nav.breadcrumb')} className="min-w-0" data-testid="breadcrumbs">
      <ol className={cn('flex flex-wrap items-center gap-1.5 text-xs font-semibold text-muted-foreground', className)}>
        {lead && <li className="inline-flex items-center">{lead}</li>}
        {crumbs.map((c, i) => (
          <li key={c.filter.kind === 'root' ? '' : c.filter.path} className="inline-flex min-w-0 items-center gap-1.5">
            {(lead || i > 0) && sep}
            <button type="button" onClick={() => openCrumb(c.filter)} className="max-w-[40ch] truncate rounded-sm outline-none ring-ring hover:text-primary hover:underline focus-visible:text-primary focus-visible:ring-2" title={c.label} data-testid="crumb" data-kind={c.filter.kind} data-path={c.filter.kind === 'folder' ? c.filter.path : ''}>{c.label}</button>
          </li>
        ))}
        <li className="inline-flex min-w-0 items-center gap-1.5" aria-current="page" data-testid="crumb-current">
          {(lead || crumbs.length > 0) && sep}
          {current}
        </li>
      </ol>
    </nav>
  );
}
