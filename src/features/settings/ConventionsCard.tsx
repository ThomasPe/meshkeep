import { FolderOpen, ListChecks, Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { getBackend } from '@/lib/backend';
import { reportError } from '@/lib/errors';
import { useRoots } from '@/lib/queries';
import { type ConventionDeviation, type ConventionReport, type LibraryRoot } from '@/lib/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from './Card';

/**
 * Library conventions per root (#58): the YAML file is the source of truth, this card edits
 * it, offers a starter set and shows where the library deviates from the rules.
 */
export function ConventionsCard() {
  const { t } = useTranslation();
  const roots = useRoots();
  return (
    <Card title={t('settings.conventions')} hint={t('settings.conventionsHint')}>
      {(roots.data ?? []).map((r) => <ConventionsEditor key={r.id} root={r} />)}
      {roots.data?.length === 0 && <p className="py-3 text-sm text-muted-foreground">{t('status.noRoots')}</p>}
    </Card>
  );
}

function ConventionsEditor({ root }: { root: LibraryRoot }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ['conventions', root.id], queryFn: async () => (await getBackend()).getConventions(root.id) });
  const [draft, setDraft] = useState<string | null>(null);
  const [report, setReport] = useState<ConventionReport | null>(null);
  const [checking, setChecking] = useState(false);
  const save = useMutation({
    mutationFn: async (text: string) => (await getBackend()).setConventions(root.id, text),
    onSuccess: (v) => { qc.setQueryData(['conventions', root.id], v); setDraft(null); setReport(null); toast.success(v.text ? t('settings.conventionsSaved') : t('settings.conventionsRemoved')); },
    onError: reportError,
  });
  const text = draft ?? view.data?.text ?? '';
  const dirty = draft !== null && draft !== (view.data?.text ?? '');
  const starter = async () => { const b = await getBackend(); setDraft(await b.starterConventions()); };
  const check = async () => {
    setChecking(true);
    try { const b = await getBackend(); setReport(await b.checkConventions(root.id)); } catch (e) { reportError(e); } finally { setChecking(false); }
  };
  const kindLabel = (k: ConventionDeviation['kind']) => t(`settings.conventionKind.${k}`);
  return (
    <div className="grid gap-2 border-b border-border py-3.5 last:border-0" data-testid="conventions-root" data-root={root.id} data-state={view.data?.error ? 'invalid' : view.data?.text ? 'set' : 'none'}>
      <div className="flex flex-wrap items-center gap-2">
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" /><b className="min-w-0 flex-1 truncate text-sm" title={root.path}>{root.path}</b>
        {view.data?.text && !view.data.error && <Badge variant="success" data-testid="conventions-state">{t('settings.conventionsSet')}</Badge>}
        {view.data?.error && <Badge variant="warning" data-testid="conventions-state">{t('settings.conventionsInvalid')}</Badge>}
        {view.data && !view.data.text && <Badge variant="outline" data-testid="conventions-state">{t('settings.conventionsNone')}</Badge>}
      </div>
      <Textarea value={text} spellCheck={false} rows={text ? Math.min(24, text.split('\n').length + 1) : 4} placeholder={t('settings.conventionsPlaceholder')} className="font-mono text-xs leading-relaxed" onChange={(e) => setDraft(e.target.value)} data-testid="conventions-text" />
      {view.data?.error && draft === null && <p className="text-xs font-semibold text-warning" data-testid="conventions-error">{view.data.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(text)} data-testid="conventions-save">{t('settings.conventionsSave')}</Button>
        {!text && <Button size="sm" variant="outline" onClick={() => void starter()} data-testid="conventions-starter"><Sparkles />{t('settings.conventionsStarter')}</Button>}
        <Button size="sm" variant="outline" disabled={checking || !view.data?.text || !!view.data?.error || dirty} onClick={() => void check()} data-testid="conventions-check">{checking ? <Loader2 className="animate-spin" /> : <ListChecks />}{t('settings.conventionsCheck')}</Button>
        <span className="text-xs text-muted-foreground" title={view.data?.path}>{t('settings.conventionsFile')}</span>
      </div>
      {report && (
        <div className="grid gap-1 rounded-[10px] bg-secondary p-3 text-xs" data-testid="conventions-report">
          <b>{report.deviations.length === 0 ? t('settings.conventionsClean', { count: report.checked }) : t('settings.conventionsDeviations', { count: report.deviations.length, checked: report.checked })}</b>
          {report.deviations.slice(0, 50).map((d, i) => (
            <div key={i} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2" data-testid="conventions-deviation" data-kind={d.kind}>
              <Badge variant={d.fixable ? 'accent' : 'outline'} className="self-start">{kindLabel(d.kind)}</Badge>
              <span className="min-w-0 break-words"><span className="font-semibold">{d.rel_path}</span> · {d.current} → {d.expected}</span>
            </div>
          ))}
          {report.deviations.length > 50 && <span className="text-muted-foreground">…</span>}
          {report.deviations.some((d) => d.fixable) && <span className="text-muted-foreground">{t('settings.conventionsFixHint')}</span>}
        </div>
      )}
    </div>
  );
}
