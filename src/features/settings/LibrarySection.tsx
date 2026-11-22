import { FolderOpen, HardDrive, Images, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ScanState } from '@/App';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useLibraryActions } from '@/features/library/useLibraryActions';
import { getBackend } from '@/lib/backend';
import { reportError } from '@/lib/errors';
import { formatDate, formatDuration } from '@/lib/format';
import { invalidateLibrary, keys, useContainerDirs, useIgnorePatterns, useRoots, useSetThumbLocation, useThumbLocation, useThumbStats } from '@/lib/queries';
import { kickThumbQueue, useThumbs } from '@/lib/thumbs/queue';
import { dropThumbnailCache } from '@/lib/thumbs/useThumbnail';
import { type LibraryRoot, type SyncMode, type ThumbLocation } from '@/lib/types';
import { useQueryClient } from '@tanstack/react-query';
import { Card, Row } from './Card';
import { ConventionsCard } from './ConventionsCard';

/** Settings › Library: what the app indexes and how (roots, scanner rules, conventions, previews). */
export function LibrarySection({ scanning, onScanEnd }: { scanning: ScanState; onScanEnd: (rootId: string) => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const roots = useRoots();
  const ignore = useIgnorePatterns();
  const containers = useContainerDirs();
  const thumbStats = useThumbStats();
  const thumbs = useThumbs();
  const thumbLocation = useThumbLocation();
  const setThumbLocation = useSetThumbLocation();
  const { scan, addRootViaPicker, removeRoot } = useLibraryActions(onScanEnd);
  const [removing, setRemoving] = useState<LibraryRoot | null>(null);
  const [pattern, setPattern] = useState('');
  const [container, setContainer] = useState('');

  const setMode = async (root: LibraryRoot, mode: SyncMode, pollIntervalSecs?: number) => {
    try { const b = await getBackend(); await b.setRootMode(root.id, mode, pollIntervalSecs); await qc.invalidateQueries({ queryKey: keys.roots }); } catch (e) { reportError(e); }
  };
  const saveContainers = async (next: string[]) => {
    try { const b = await getBackend(); await b.setContainerDirs(next); await qc.invalidateQueries({ queryKey: keys.containers }); toast.success(t('settings.containerSaved')); } catch (e) { reportError(e); }
  };
  const clearThumbs = async () => {
    try { const b = await getBackend(); await b.clearThumbnails(); dropThumbnailCache(); invalidateLibrary(qc); toast(t('settings.thumbsCleared')); void kickThumbQueue(); } catch (e) { reportError(e); }
  };
  const savePatterns = async (next: string[]) => {
    try { const b = await getBackend(); await b.setIgnorePatterns(next); await qc.invalidateQueries({ queryKey: keys.ignore }); toast.success(t('settings.patternSaved')); } catch (e) { reportError(e); }
  };

  return (
    <>
      <Card title={t('settings.roots')} hint={t('settings.rootsHint')} action={<Button size="sm" onClick={() => void addRootViaPicker()} data-testid="add-root"><Plus />{t('settings.addFolder')}</Button>}>
        {(roots.data ?? []).map((r) => (
          <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_minmax(190px,max-content)_auto_auto] items-center gap-3.5 border-b border-border py-3.5 last:border-0" data-testid="root-row">
            <div className="flex min-w-0 items-center gap-2.5"><FolderOpen className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0"><div className="truncate font-extrabold" title={r.path}>{r.path}</div><div className="text-xs font-semibold text-muted-foreground">{r.last_scan_at ? t('settings.lastScan', { when: formatDate(r.last_scan_at, i18n.language) }) : t('settings.neverScanned')}</div>
              {r.last_scan && <div className="text-xs text-muted-foreground tabular" data-testid="root-scan-summary">{t('settings.scanSummary', { projects: r.last_scan.projects, files: r.last_scan.files, time: formatDuration(r.last_scan.millis), trigger: t(`settings.trigger.${r.last_scan.trigger}`, { defaultValue: r.last_scan.trigger }) })}{r.last_scan.warning_count > 0 && <details className="inline"><summary className="ml-2 inline cursor-pointer text-warning">{t('settings.scanWarnings', { count: r.last_scan.warning_count })}</summary><ul className="mt-1 list-disc pl-4 text-warning">{r.last_scan.warnings.map((w) => <li key={w} className="break-all">{w}</li>)}</ul></details>}</div>}
              {r.last_error && <div className="text-xs font-semibold text-warning" data-testid="root-error">{t('settings.lastError')}: {r.last_error}</div>}</div></div>
            <div className="grid gap-1">
              <Select value={r.mode} onValueChange={(v) => void setMode(r, v as SyncMode)}>
                <SelectTrigger size="sm" className="w-full shadow-none" data-testid="root-mode"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="watch">{t('settings.mode.watch')}</SelectItem><SelectItem value="poll">{t('settings.mode.poll')}</SelectItem><SelectItem value="manual">{t('settings.mode.manual')}</SelectItem></SelectContent>
              </Select>
              {r.mode === 'poll' && (
                <Select value={String(nearestInterval(r.poll_interval_secs))} onValueChange={(v) => void setMode(r, 'poll', Number(v))}>
                  <SelectTrigger size="sm" className="w-full shadow-none" data-testid="poll-interval"><span className="text-muted-foreground">{t('settings.every')}</span><SelectValue /></SelectTrigger>
                  <SelectContent>{INTERVALS.map((m) => <SelectItem key={m} value={String(m * 60)}>{t('settings.minutes', { count: m })}</SelectItem>)}</SelectContent>
                </Select>
              )}
            </div>
            <Badge variant={r.status === 'offline' ? 'warning' : r.status === 'online' ? 'success' : 'outline'}>{t(`settings.status.${r.status}`)}</Badge>
            <div className="flex gap-1">
              <Button size="icon-sm" variant="ghost" title={t('settings.rescan')} disabled={r.id in scanning} onClick={() => void scan(r.id)} data-testid="rescan-root"><RefreshCw className={r.id in scanning ? 'animate-spin' : ''} /></Button>
              <Button size="icon-sm" variant="ghost" title={t('settings.remove')} onClick={() => setRemoving(r)} data-testid="remove-root"><Trash2 /></Button>
            </div>
          </div>
        ))}
        {roots.data?.length === 0 && <p className="py-3 text-sm text-muted-foreground">{t('status.noRoots')}</p>}
      </Card>

      <Card title={t('settings.ignore')} hint={t('settings.ignoreHint')}>
        <div className="flex flex-wrap items-center gap-1.5">
          {(ignore.data ?? []).map((p) => <span key={p} className="inline-flex items-center gap-1 rounded-full bg-secondary pl-2.5 pr-1 py-0.5 font-mono text-xs font-semibold">{p}<button type="button" aria-label={`remove ${p}`} className="rounded-full p-0.5 text-muted-foreground hover:text-destructive" onClick={() => void savePatterns((ignore.data ?? []).filter((x) => x !== p))}><X className="size-3" /></button></span>)}
          <Input value={pattern} placeholder={t('settings.addPattern')} className="h-7 w-44 rounded-full font-mono text-xs" onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && pattern.trim()) { void savePatterns([...(ignore.data ?? []), pattern.trim()]); setPattern(''); } }} />
        </div>
      </Card>

      <Card title={t('settings.containers')} hint={t('settings.containersHint')}>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="container-dirs">
          {(containers.data ?? []).map((n) => <span key={n} className="inline-flex items-center gap-1 rounded-full bg-secondary pl-2.5 pr-1 py-0.5 font-mono text-xs font-semibold">{n}<button type="button" aria-label={`remove ${n}`} className="rounded-full p-0.5 text-muted-foreground hover:text-destructive" onClick={() => void saveContainers((containers.data ?? []).filter((x) => x !== n))}><X className="size-3" /></button></span>)}
          <Input value={container} placeholder={t('settings.addContainer')} className="h-7 w-44 rounded-full font-mono text-xs" onChange={(e) => setContainer(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && container.trim()) { void saveContainers([...(containers.data ?? []), container.trim()]); setContainer(''); } }} />
        </div>
      </Card>

      <ConventionsCard />

      <Card title={t('settings.previews')} hint={t('settings.previewsHint')} action={<Button size="sm" variant="outline" onClick={() => void clearThumbs()} data-testid="clear-thumbs"><Images />{t('settings.clearThumbs')}</Button>}>
        <div className="text-[13px] font-semibold text-secondary-foreground" data-testid="thumb-summary">
          {t('settings.thumbSummary', { done: thumbStats.data?.done ?? 0, pending: thumbStats.data?.pending ?? 0, failed: thumbStats.data?.failed ?? 0 })}
          {thumbs.unavailable && <span className="ml-2 text-warning" title={thumbs.unavailable}>{t('status.thumbsUnavailable')}</span>}
        </div>
        <Row label={t('settings.thumbLocation')}>
          <div className="grid justify-items-end gap-1">
            <ToggleGroup type="single" value={thumbLocation.data ?? 'app_data'} onValueChange={(v) => { if (v) setThumbLocation.mutate(v as ThumbLocation, { onSuccess: () => toast.success(t('settings.thumbLocationSaved')), onError: reportError }); }} data-testid="thumb-location">
              <ToggleGroupItem value="app_data" data-testid="thumb-location-app"><HardDrive />{t('settings.thumbLocationApp')}</ToggleGroupItem>
              <ToggleGroupItem value="project" data-testid="thumb-location-project"><FolderOpen />{t('settings.thumbLocationProject')}</ToggleGroupItem>
            </ToggleGroup>
            <span className="max-w-[46ch] text-right text-xs text-muted-foreground">{thumbLocation.data === 'project' ? t('settings.thumbLocationHintProject') : t('settings.thumbLocationHintApp')}</span>
          </div>
        </Row>
      </Card>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('settings.removeTitle', { path: removing?.path })}</DialogTitle><DialogDescription>{t('settings.removeBody')}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setRemoving(null)}>{t('common.cancel')}</Button><Button variant="destructive" data-testid="confirm-remove" onClick={() => { if (removing) void removeRoot(removing.id); setRemoving(null); }}>{t('settings.remove')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const INTERVALS = [1, 5, 15, 30, 60, 180];
function nearestInterval(secs: number): number {
  const m = secs / 60;
  return (INTERVALS.find((x) => x >= m) ?? INTERVALS[INTERVALS.length - 1]!) * 60;
}
