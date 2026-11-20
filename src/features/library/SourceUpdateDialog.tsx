import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Globe, Loader2, Minus, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DEFAULT_OPTIONS, runSourceUpdate, type SourceProgress, type SourceResult, type SourceUpdateOptions } from '@/features/library/sourceUpdate';
import { getBackend } from '@/lib/backend';
import { reportError } from '@/lib/errors';
import { invalidateLibrary, keys, useNetworkSettings } from '@/lib/queries';
import { navigate } from '@/lib/router';
import { kickThumbQueue, useThumbs } from '@/lib/thumbs/queue';
import { forgetThumbnail } from '@/lib/thumbs/useThumbnail';
import type { ProjectSummary } from '@/lib/types';

/** Opens the batch "update from source page" dialog for a selection (#69). */
export const useSourceUpdate = create<{ targets: ProjectSummary[]; open: (ps: ProjectSummary[]) => void; close: () => void }>((set) => ({
  targets: [],
  open: (targets) => set({ targets }),
  close: () => set({ targets: [] }),
}));

/**
 * One up-front choice (what to write, fill or overwrite), then the projects are worked off one
 * after the other with a progress bar and a cancel button, and a summary says per project what
 * happened. Rendered once in the library page.
 */
export function SourceUpdateDialog() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { targets, close } = useSourceUpdate();
  const net = useNetworkSettings();
  const [opts, setOpts] = useState<SourceUpdateOptions>(DEFAULT_OPTIONS);
  const [progress, setProgress] = useState<SourceProgress | null>(null);
  const [results, setResults] = useState<SourceResult[] | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const open = targets.length > 0;
  const running = !!progress && !results;
  const allowed = net.data?.fetch_model_pages ?? false;

  useEffect(() => {
    if (open) { setOpts(DEFAULT_OPTIONS); setProgress(null); setResults(null); setCancelling(false); }
  }, [open]);

  const start = async () => {
    const ctl = new AbortController();
    abort.current = ctl;
    setProgress({ done: 0, total: targets.length, current: null });
    try {
      const b = await getBackend();
      const out = await runSourceUpdate(b, targets, opts, {
        signal: ctl.signal,
        onProgress: setProgress,
        onResult: (r, fresh) => { if (fresh) qc.setQueryData(keys.project(r.id), fresh); },
      });
      // a replaced preview is rendered again, like after choosing one by hand
      for (const r of out) {
        if (r.status === 'skipped' || !r.changed.includes('image')) continue;
        const key = targets.find((p) => p.id === r.id)?.thumb ?? useThumbs.getState().fresh[r.id];
        if (key) forgetThumbnail(key);
        useThumbs.setState((s) => { const f = { ...s.fresh }; delete f[r.id]; return { fresh: f }; });
      }
      invalidateLibrary(qc);
      void kickThumbQueue();
      setResults(out);
    } catch (e) {
      reportError(e);
      close();
    }
  };
  const cancel = () => { setCancelling(true); abort.current?.abort(); };

  const updated = results?.filter((r) => r.status === 'updated') ?? [];
  const skipped = results?.filter((r) => r.status === 'skipped') ?? [];
  const failed = results?.filter((r) => r.status === 'failed') ?? [];
  const fields = (r: SourceResult) => (r.status === 'skipped' ? [] : r.changed).map((f) => t(`inspector.suggestField.${f}`)).join(', ');
  const detail = (r: SourceResult) =>
    r.status === 'updated' ? fields(r)
    : r.status === 'skipped' ? t(`sourceUpdate.skip.${r.reason}`)
    : r.code === 'sidecar_conflict' ? t('sourceUpdate.conflict')
    : t(`errors.${r.code}`, { defaultValue: r.message, message: r.message }) + (r.changed.length ? ` ${t('sourceUpdate.partly', { fields: fields(r) })}` : '');

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !running) close(); }}>
      <DialogContent className="max-w-xl" data-testid="source-update-dialog" data-phase={results ? 'done' : running ? 'running' : 'options'} onEscapeKeyDown={(e) => { if (running) e.preventDefault(); }} onInteractOutside={(e) => { if (running) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Globe className="size-4 text-primary" />{t('sourceUpdate.title', { count: targets.length })}</DialogTitle>
          <DialogDescription>{t('sourceUpdate.body')}</DialogDescription>
        </DialogHeader>

        {!progress && !results && (
          <div className="grid gap-3 text-sm">
            {net.data && !allowed && (
              <div className="grid gap-3 rounded-[10px] bg-accent p-3 text-accent-foreground" data-testid="source-update-setup">
                {t('inspector.page.suggestSetup')}
                <div><Button size="sm" variant="outline" onClick={() => { close(); navigate({ page: 'settings' }); }} data-testid="source-update-open-settings"><SettingsIcon />{t('inspector.suggestOpenSettings')}</Button></div>
              </div>
            )}
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{t('sourceUpdate.what')}</legend>
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={opts.metadata} onChange={(e) => setOpts((o) => ({ ...o, metadata: e.target.checked }))} data-testid="source-update-metadata" /><span><b>{t('sourceUpdate.metadata')}</b><br /><span className="text-xs text-muted-foreground">{t('sourceUpdate.metadataNote')}</span></span></label>
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={opts.image} onChange={(e) => setOpts((o) => ({ ...o, image: e.target.checked }))} data-testid="source-update-image" /><span><b>{t('sourceUpdate.image')}</b><br /><span className="text-xs text-muted-foreground">{t('inspector.page.imageNote')}</span></span></label>
            </fieldset>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{t('sourceUpdate.how')}</legend>
              <label className="flex items-start gap-2"><input type="radio" name="source-update-mode" className="mt-0.5 size-4 accent-primary" checked={opts.mode === 'fill'} onChange={() => setOpts((o) => ({ ...o, mode: 'fill' }))} data-testid="source-update-fill" /><span><b>{t('sourceUpdate.fill')}</b><br /><span className="text-xs text-muted-foreground">{t('sourceUpdate.fillNote')}</span></span></label>
              <label className="flex items-start gap-2"><input type="radio" name="source-update-mode" className="mt-0.5 size-4 accent-primary" checked={opts.mode === 'overwrite'} onChange={() => setOpts((o) => ({ ...o, mode: 'overwrite' }))} data-testid="source-update-overwrite" /><span><b>{t('sourceUpdate.overwrite')}</b><br /><span className="text-xs text-muted-foreground">{t('sourceUpdate.overwriteNote')}</span></span></label>
            </fieldset>
          </div>
        )}

        {running && progress && (
          <div className="grid gap-2 py-2 text-sm" data-testid="source-update-progress">
            <div className="flex items-center gap-2"><Loader2 className="size-4 shrink-0 animate-spin" /><span className="min-w-0 flex-1 truncate">{cancelling ? t('sourceUpdate.cancelling') : progress.current ?? t('inspector.page.suggestLoading')}</span><span className="tabular text-muted-foreground" data-testid="source-update-count">{t('sourceUpdate.progress', { done: progress.done, total: progress.total })}</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          </div>
        )}

        {results && (
          <div className="grid gap-3 text-sm" data-testid="source-update-summary">
            <div className="font-semibold" data-testid="source-update-totals" data-updated={updated.length} data-skipped={skipped.length} data-failed={failed.length}>{t('sourceUpdate.totals', { updated: updated.length, skipped: skipped.length, failed: failed.length })}</div>
            <ul className="grid max-h-72 gap-1.5 overflow-auto">
              {[...failed, ...updated, ...skipped].map((r) => (
                <li key={r.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 rounded-[10px] bg-background px-3 py-2" data-testid="source-update-result" data-status={r.status}>
                  {r.status === 'updated' ? <Check className="mt-0.5 size-4 text-primary" /> : r.status === 'failed' ? <AlertTriangle className="mt-0.5 size-4 text-warning" /> : <Minus className="mt-0.5 size-4 text-muted-foreground" />}
                  <div className="min-w-0"><div className="truncate font-semibold">{r.title}</div><div className="text-xs text-muted-foreground">{detail(r)}</div></div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          {results ? <Button onClick={close} data-testid="source-update-close">{t('common.close')}</Button>
            : running ? <Button variant="outline" disabled={cancelling} onClick={cancel} data-testid="source-update-cancel">{t('common.cancel')}</Button>
            : <><Button variant="outline" onClick={close}>{t('common.cancel')}</Button><Button disabled={!allowed || (!opts.metadata && !opts.image)} onClick={() => void start()} data-testid="source-update-start"><Globe />{t('sourceUpdate.start')}</Button></>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
