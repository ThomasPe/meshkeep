import { MoreHorizontal } from 'lucide-react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { projectActionItems, type ProjectActionChoice, type ProjectActionId, type ProjectActionItem, type ProjectActions } from '@/features/library/projectActions';
import type { ProjectSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Props {
  project: ProjectSummary;
  actions: ProjectActions;
  /** Prefix of every `data-testid` in the bar: `inspector`, `project`. */
  prefix: string;
  /** Actions shown as buttons, in this order; every other action sits in the "more" menu. */
  inline: ProjectActionId[];
  /** Inline buttons that show their label; the rest are icon buttons with a tooltip. */
  labeled?: ProjectActionId[];
  /** The one filled button. */
  primary?: ProjectActionId;
  /** Actions this surface shows elsewhere (the star next to the title) or that make no sense on it. */
  exclude?: ProjectActionId[];
  size?: 'sm' | 'default';
  className?: string;
}

/**
 * The actions of one project as buttons plus a "more" menu (#70). It renders the list of
 * `projectActionItems` completely: what is not a button is an entry of the menu, so the
 * inspector and the details page offer exactly what the context menu offers.
 */
export function ProjectActionBar({ project, actions, prefix, inline, labeled = [], primary, exclude = [], size = 'default', className }: Props) {
  const { t } = useTranslation();
  const items = projectActionItems([project], actions, t).filter((a) => !exclude.includes(a.id));
  const buttons = inline.map((id) => items.find((a) => a.id === id)).filter((a): a is ProjectActionItem => !!a);
  const rest = items.filter((a) => !inline.includes(a.id));
  const iconSize = size === 'sm' ? 'icon-sm' : 'icon';
  const choice = (c: ProjectActionChoice) => (
    <Fragment key={c.key}>
      {c.separated && <DropdownMenuSeparator />}
      <DropdownMenuItem disabled={c.disabled} onSelect={c.run} data-testid={`${prefix}-${c.testId}`}>{c.icon && <c.icon />}{c.label}</DropdownMenuItem>
    </Fragment>
  );
  const button = (a: ProjectActionItem) => {
    const text = labeled.includes(a.id);
    return (
      <Button key={a.id} size={text ? size : iconSize} variant={a.id === primary ? 'default' : 'outline'} disabled={a.disabled} onClick={a.run} title={a.label} aria-label={text ? undefined : a.label} data-testid={`${prefix}-${a.testId}`} data-action={a.id} className={cn(a.destructive && 'text-destructive hover:text-destructive')}>
        <a.icon />{text && (a.short ?? a.label)}
      </Button>
    );
  };
  return (
    <div className={cn('flex flex-wrap gap-2', className)} data-testid={`${prefix}-actions`}>
      {buttons.map((a) => (a.choices
        ? <DropdownMenu key={a.id}><DropdownMenuTrigger asChild>{button(a)}</DropdownMenuTrigger><DropdownMenuContent align="start">{a.choices.map(choice)}</DropdownMenuContent></DropdownMenu>
        : button(a)))}
      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size={iconSize} variant="outline" title={t('actions.more')} aria-label={t('actions.more')} data-testid={`${prefix}-more`}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid={`${prefix}-more-menu`}>
            {rest.map((a) => (
              <Fragment key={a.id}>
                {a.separated && <DropdownMenuSeparator />}
                {a.choices ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={a.disabled} data-testid={`${prefix}-${a.testId}`} data-action={a.id}><a.icon />{a.label}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>{a.choices.map(choice)}</DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : <DropdownMenuItem variant={a.destructive ? 'destructive' : undefined} disabled={a.disabled} onSelect={a.run} data-testid={`${prefix}-${a.testId}`} data-action={a.id}><a.icon />{a.label}</DropdownMenuItem>}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
