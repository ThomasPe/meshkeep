import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu';
import { projectActionItems, type ProjectActions } from '@/features/library/projectActions';
import type { ProjectSummary } from '@/lib/types';

export type { ProjectActions } from '@/features/library/projectActions';

/**
 * Context menu of a card or row. Like Explorer: when the clicked project is part of the
 * selection the menu acts on the whole selection and says so in its labels; otherwise the
 * caller selects the clicked project alone first (see `onContextMenu` on the card/row) and
 * the menu acts on that one. The entries come from `projectActionItems`, the list the
 * inspector and the details page show as well (#70).
 */
export function ProjectMenu({ project: p, selection = [], actions, children }: { project: ProjectSummary; selection?: ProjectSummary[]; actions: ProjectActions; children: React.ReactNode }) {
  const { t } = useTranslation();
  const targets = selection.some((s) => s.id === p.id) && selection.length > 1 ? selection : [p];
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="project-menu" data-count={targets.length}>
        {projectActionItems(targets, actions, t).map((a) => (
          <Fragment key={a.id}>
            {a.separated && <ContextMenuSeparator />}
            {a.choices ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger disabled={a.disabled} data-testid={`menu-${a.testId}`} data-action={a.id}><a.icon />{a.label}</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {a.choices.map((c) => (
                    <Fragment key={c.key}>
                      {c.separated && <ContextMenuSeparator />}
                      <ContextMenuItem disabled={c.disabled} onSelect={c.run} data-testid={`menu-${c.testId}`}>{c.icon && <c.icon />}{c.label}</ContextMenuItem>
                    </Fragment>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            ) : <ContextMenuItem variant={a.destructive ? 'destructive' : undefined} disabled={a.disabled} onSelect={a.run} data-testid={`menu-${a.testId}`} data-action={a.id}><a.icon />{a.label}</ContextMenuItem>}
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
