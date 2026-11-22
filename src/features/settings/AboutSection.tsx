import { Bug, Download, FileArchive, FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { openFeedback } from '@/features/feedback/feedback';
import { getBackend } from '@/lib/backend';
import { reportError } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { useAppInfo } from '@/lib/queries';
import { type DiagnosticsReport, type UpdateInfo } from '@/lib/types';
import { Card } from './Card';

/** Settings › About & support: the version that runs, its updates, and how a problem reaches a bug report. */
export function AboutSection() {
  const { t } = useTranslation();
  const info = useAppInfo();
  const [update, setUpdate] = useState<{ state: 'idle' | 'checking' | 'result' | 'installing'; info?: UpdateInfo; error?: string }>({ state: 'idle' });
  const checkUpdate = async () => {
    setUpdate({ state: 'checking' });
    try { const b = await getBackend(); setUpdate({ state: 'result', info: await b.checkUpdate() }); } catch (e) { setUpdate({ state: 'result', error: e instanceof Error ? e.message : (e as { message?: string }).message ?? String(e) }); }
  };
  const installUpdate = async () => {
    setUpdate((u) => ({ ...u, state: 'installing' }));
    try { const b = await getBackend(); await b.installUpdate(); } catch (e) { reportError(e); setUpdate({ state: 'idle' }); }
  };

  return (
    <>
      <Card title={t('settings.updates')} hint={info.data?.store ? t('settings.updatesStore') : info.data?.updater ? (info.data.channel === 'dev' ? t('settings.updatesDevChannel') : t('settings.updatesPrivate')) : t('settings.updatesDev')} action={info.data?.updater ? <Button size="sm" variant="outline" disabled={update.state === 'checking' || update.state === 'installing'} onClick={() => void checkUpdate()} data-testid="check-update"><Download />{t('settings.checkUpdate')}</Button> : undefined}>
        <div className="text-[13px] font-semibold text-secondary-foreground" data-testid="update-status">
          {update.state === 'checking' && t('settings.updateChecking')}
          {update.state === 'result' && update.error && <span className="text-warning">{t('settings.updateError', { message: update.error })}</span>}
          {update.state === 'result' && update.info && !update.info.available && t('settings.updateNone')}
          {(update.state === 'result' || update.state === 'installing') && update.info?.available && (
            <span className="flex flex-wrap items-center gap-2">{t('settings.updateAvailable', { version: update.info.version })}<Button size="sm" disabled={update.state === 'installing'} onClick={() => void installUpdate()} data-testid="install-update">{update.state === 'installing' ? t('settings.updateInstalling') : t('settings.installUpdate')}</Button></span>
          )}
          {update.state === 'idle' && (info.data?.updater ? t('settings.updateIdle') : info.data?.store ? t('settings.updatesStore') : t('settings.updatesDev'))}
        </div>
      </Card>

      <Card title={t('settings.feedback')} hint={t('settings.feedbackHint')} action={<Button size="sm" variant="outline" onClick={() => openFeedback()} data-testid="send-feedback"><Bug />{t('settings.sendFeedback')}</Button>}>
        <div className="text-[13px] font-semibold text-secondary-foreground"><a className="underline-offset-2 hover:underline" href="https://github.com/ThomasPe/meshkeep/issues" target="_blank" rel="noreferrer">github.com/ThomasPe/meshkeep/issues</a></div>
      </Card>

      <DiagnosticsCard />

      <Card title={t('settings.about')}>
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
          <dt className="text-muted-foreground">{t('settings.version')}</dt><dd className="font-semibold">{info.data?.version} {info.data?.testMode && <Badge variant="warning">{t('settings.testMode')}</Badge>} {info.data?.e2eBuild && <Badge variant="outline">e2e</Badge>} {info.data?.store && <Badge variant="accent">Store</Badge>} {info.data?.channel && <Badge variant="outline" data-testid="channel-badge">{t('settings.channel', { channel: info.data.channel })}</Badge>}</dd>
          <dt className="text-muted-foreground">{t('settings.dataDir')}</dt><dd className="break-all font-mono text-xs" data-testid="data-dir">{info.data?.dataDir}</dd>
          <dt className="text-muted-foreground">{t('settings.webview')}</dt><dd className="font-semibold">{info.data?.webview} · {info.data?.os} {info.data?.arch}</dd>
        </dl>
      </Card>
    </>
  );
}

/**
 * APP-8: the diagnostics package. The spec rules out telemetry and crash upload, so this is
 * how a problem in the field reaches a bug report: one zip the user saves and attaches.
 */
function DiagnosticsCard() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<{ busy: boolean; report?: DiagnosticsReport | null }>({ busy: false });
  const exportPackage = async () => {
    setState({ busy: true });
    try {
      const b = await getBackend();
      const report = await b.exportDiagnostics();
      setState({ busy: false, report });
      if (report) toast.success(t('settings.diagnosticsToast'));
    } catch (e) { reportError(e); setState({ busy: false }); }
  };
  const openLogs = async () => { try { const b = await getBackend(); await b.openLogDir(); } catch (e) { reportError(e); } };
  return (
    <Card title={t('settings.diagnostics')} hint={t('settings.diagnosticsHint')} action={<span className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void openLogs()} data-testid="open-log-dir"><FolderOpen />{t('settings.openLogDir')}</Button><Button size="sm" variant="outline" disabled={state.busy} onClick={() => void exportPackage()} data-testid="export-diagnostics"><FileArchive />{state.busy ? t('settings.exportDiagnosticsBusy') : t('settings.exportDiagnostics')}</Button></span>}>
      <div className="text-[13px] font-semibold text-secondary-foreground" data-testid="diagnostics-status" data-state={state.busy ? 'busy' : state.report ? 'written' : state.report === null ? 'cancelled' : 'idle'} aria-live="polite">
        {state.report ? <><span className="break-all font-mono text-xs">{t('settings.diagnosticsWritten', { path: state.report.path, size: formatBytes(state.report.bytes, i18n.language), count: state.report.entries.length })}</span><ul className="mt-1 list-disc pl-4 font-mono text-xs text-muted-foreground" data-testid="diagnostics-entries">{state.report.entries.map((e) => <li key={e}>{e}</li>)}</ul></> : state.report === null ? t('settings.diagnosticsCancelled') : t('settings.diagnosticsIdle')}
      </div>
    </Card>
  );
}
