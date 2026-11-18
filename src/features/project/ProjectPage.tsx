import { Archive, ChevronLeft, CloudOff, ImageUp, RotateCcw, Star } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProjectActionBar } from '@/features/library/ProjectActionBar';
import { toSummary } from '@/features/library/projectActions';
import { Thumb } from '@/features/library/Thumb';
import { useProjectActions } from '@/features/library/useProjectActions';
import { FilesTable } from '@/features/project/FilesTable';
import { ImageGallery, useProjectImageCache } from '@/features/project/ImageGallery';
import { MetadataForm } from '@/features/project/MetadataForm';
import { Viewer } from '@/features/project/Viewer';
import { useChooseThumbnail } from '@/features/project/useChooseThumbnail';
import { formatBytes, initials } from '@/lib/format';
import { useEmbeddedPictures, useProject, useRoots } from '@/lib/queries';
import { navigate, routeHref } from '@/lib/router';
import { useFileThumbListing, useFileThumbScope } from '@/lib/thumbs/useFileThumb';
import { cn } from '@/lib/utils';

export function ProjectPage({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const project = useProject(id);
  const pictures = useEmbeddedPictures(project.data);
  useProjectImageCache(project.data?.id ?? null);
  // VIEW-8: one listing of the file previews for the strip under the viewer and the Files tab
  const listing = useFileThumbListing(id);
  useFileThumbScope(id);
  const [tab, setTab] = useState('overview');
  // the model on screen belongs to one project; another project starts with its first model (#53)
  const [shown, setShown] = useState<{ projectId: string; rel: string } | null>(null);
  const roots = useRoots();
  const choose = useChooseThumbnail(project.data ?? null);
  const { actions, dialogs } = useProjectActions({ onRenamed: (_old, newId) => navigate({ page: 'project', id: newId }), onDeleted: () => navigate({ page: 'library' }) });
  if (project.isPending) return <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>;
  if (project.isError || !project.data) return <div className="p-6"><p className="text-sm text-destructive">{t('errors.not_found')}</p><Button asChild variant="outline" className="mt-3"><a href={routeHref({ page: 'library' })}>{t('project.back')}</a></Button></div>;
  const p = project.data;
  const root = roots.data?.find((r) => r.id === p.root_id);
  const imageCount = p.files.filter((f) => f.kind === 'image').length + (pictures.data?.length ?? 0);
  const summary = toSummary(p);
  return (
    <div className="h-full overflow-auto" data-testid="project-page">
      {dialogs}
      {/* no maximum width (#52): the viewer takes what the window offers, the form keeps a readable width */}
      <div className="grid gap-5 px-6 pb-10 pt-5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <a href={routeHref({ page: 'library' })} className="inline-flex items-center gap-1 hover:text-primary" data-testid="back"><ChevronLeft className="size-4" />{t('project.back')}</a>
          {root && <><span>/</span><span>{root.path}</span></>}
          {p.rel_path.split('/').filter(Boolean).map((seg, i) => <span key={i} className="contents"><span>/</span><span>{seg}</span></span>)}
        </div>
        <div className="flex flex-wrap items-start gap-3.5">
          {/* the same preview the card and the inspector show, so a chosen image or captured view is confirmed right here */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="shrink-0 rounded-[10px] outline-none ring-ring focus-visible:ring-2" title={t('project.previewMenu')} aria-label={t('project.previewMenu')} data-testid="project-thumb">
                <Thumb thumb={p.thumb} projectId={p.id} className="aspect-[5/3] w-[100px] overflow-hidden rounded-[10px]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem disabled={p.offline} onSelect={() => actions.rerenderThumbnail(summary)} data-testid="project-thumb-rerender"><RotateCcw />{t('actions.rerenderThumb')}</DropdownMenuItem>
              {p.thumbnail && <DropdownMenuItem disabled={p.offline} onSelect={() => void choose.useImage(null)} data-testid="project-thumb-auto"><ImageUp />{t('project.chooseAutomatically')}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="grid min-w-[200px] flex-1 gap-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-extrabold tracking-tight" data-testid="project-title">{p.title}</h1>
              <Button size="icon-sm" variant="ghost" aria-pressed={p.favorite} aria-label={p.favorite ? t('favorites.remove') : t('favorites.add')} title={p.favorite ? t('favorites.remove') : t('favorites.add')} data-testid="project-favorite" data-action="favorite" onClick={() => actions.toggleFavorite(summary)} className={cn(p.favorite && 'text-warning')}><Star className={cn(p.favorite && 'fill-current')} /></Button>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 text-[13px] font-semibold text-muted-foreground">
              {p.creator ? <><span className="grid size-5 place-items-center rounded-full bg-accent text-[9px] font-extrabold text-accent-foreground">{initials(p.creator)}</span>{p.creator}</> : t('library.unknownCreator')}
              <span>·</span><span>{t('library.files', { count: p.files.length })} · {formatBytes(p.total_bytes, i18n.language)}</span>
              {p.slicer && <Badge variant="accent" data-testid="slicer-badge">{p.slicer}</Badge>}
              {p.packed && <Badge variant="outline" title={t('library.packedHint')} data-testid="packed-badge"><Archive />{t('library.packed')}</Badge>}
              {p.offline && <Badge variant="outline"><CloudOff />{t('library.offline')}</Badge>}
            </div>
          </div>
          {/* every project action (#70): the usual ones as buttons, the rest under "more" */}
          <ProjectActionBar project={summary} actions={actions} prefix="project" exclude={['open', 'favorite']} labeled={['pack', 'unpack', 'reveal', 'rename', 'delete']} inline={['pack', 'unpack', 'reveal', 'rename', 'delete']} />
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">{t('project.overview')}</TabsTrigger>
            <TabsTrigger value="files">{t('project.files')} <span className="text-muted-foreground">{p.files.length}</span></TabsTrigger>
            {imageCount > 0 && <TabsTrigger value="images" data-testid="tab-images">{t('project.images')} <span className="text-muted-foreground">{imageCount}</span></TabsTrigger>}
          </TabsList>
          <TabsContent value="overview" className="mt-4">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,32%)] 2xl:grid-cols-[minmax(0,1fr)_minmax(360px,520px)]">
              <Viewer project={p} files={p.files} offline={p.offline} selected={shown?.projectId === p.id ? shown.rel : null} onSelect={(rel) => setShown({ projectId: p.id, rel })} listing={listing} />
              <div className="rounded-2xl bg-card p-5 shadow-card"><MetadataForm project={p} onReload={() => void project.refetch()} /></div>
            </div>
          </TabsContent>
          <TabsContent value="files" className="mt-4"><FilesTable projectId={p.id} files={p.files} offline={p.offline} packed={p.packed} listing={listing} onShow={(rel) => { setShown({ projectId: p.id, rel }); setTab('overview'); }} /></TabsContent>
          <TabsContent value="images" className="mt-4"><ImageGallery project={p} files={p.files} pictures={pictures.data ?? []} offline={p.offline} /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
