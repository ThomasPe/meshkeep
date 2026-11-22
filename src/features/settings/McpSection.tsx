import { Copy, Download, Eye, EyeOff, FolderOpen, PencilLine, Plug, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { getBackend } from '@/lib/backend';
import { reportError } from '@/lib/errors';
import { routeHref } from '@/lib/router';
import { useAiSettings, useClearMcpAudit, useMcpAudit, useMcpSettings, useMcpStatus, useRegenerateMcpToken, useSetMcpSettings } from '@/lib/queries';
import { type McpAuditEntry, type McpSettings } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Card, Row } from './Card';

/** Settings › Agents (MCP): the local server, and the journal of what agents changed through it. */
export function McpSection() {
  const { t } = useTranslation();
  return (
    <>
      <McpCard />
      <McpAuditCard />
      <p className="px-1 text-xs font-semibold text-muted-foreground" data-testid="mcp-conventions-note">{t('settings.mcpConventions')} <a href={routeHref({ page: 'settings', section: 'library' })} className="text-primary underline-offset-2 hover:underline" data-testid="mcp-conventions-link">{t('settings.mcpConventionsLink')}</a></p>
    </>
  );
}

/**
 * The local MCP server (ADR-0004): an AI agent on this machine (Claude Desktop, Claude Code)
 * reads and, when allowed, writes the library through it. Everything stays on 127.0.0.1 and
 * behind a token; the card writes the client configuration for the user.
 */
function McpCard() {
  const { t } = useTranslation();
  const mcp = useMcpSettings();
  const status = useMcpStatus(!!mcp.data?.enabled);
  const set = useSetMcpSettings();
  const regen = useRegenerateMcpToken();
  const ai = useAiSettings();
  const [showToken, setShowToken] = useState(false);
  const [port, setPort] = useState<string | null>(null);
  const s = mcp.data;
  const save = (next: Partial<McpSettings>, done?: string) => {
    if (!s) return;
    set.mutate({ ...s, ...next }, { onSuccess: () => { if (done) toast.success(done); }, onError: reportError });
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast.success(t('settings.mcpCopied')); } catch { toast.error(t('settings.mcpCopyFailed')); } };
  const addFolder = async () => {
    const b = await getBackend();
    const path = await b.pickFolder();
    if (!path || !s) return;
    if (s.import_dirs.includes(path)) return;
    save({ import_dirs: [...s.import_dirs, path] }, t('settings.mcpFolderAdded'));
  };
  const useDownloads = () => { const d = status.data?.downloadsDir; if (d && s && !s.import_dirs.includes(d)) save({ import_dirs: [...s.import_dirs, d] }, t('settings.mcpFolderAdded')); };
  const curPort = port ?? String(s?.port ?? 7340);
  const portDirty = !!s && curPort !== String(s.port);
  const url = `http://127.0.0.1:${s?.port ?? 7340}/mcp`;
  const token = s?.token ?? '';
  const exe = status.data?.exePath ?? 'meshkeep';
  const desktopConfig = JSON.stringify({ mcpServers: { meshkeep: { command: exe, args: ['--mcp', url, token] } } }, null, 2);
  const codeCommand = `claude mcp add --transport http meshkeep ${url} --header "Authorization: Bearer ${token}"`;
  const on = !!s?.enabled;
  const stateText = !on ? t('settings.mcpOff') : status.data?.error ? t('settings.mcpError', { message: status.data.error }) : status.data?.running ? t('settings.mcpRunning', { port: status.data.port, requests: status.data.requests }) : t('settings.mcpStarting');
  return (
    <Card title={t('settings.mcp')} hint={t('settings.mcpHint')}>
      <Row label={t('settings.mcpEnable')}>
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><Plug className="size-4" /><Switch checked={on} disabled={!s || set.isPending} onCheckedChange={(v) => save({ enabled: v }, v ? t('settings.mcpOn') : t('settings.mcpOffToast'))} data-testid="mcp-toggle" aria-label={t('settings.mcpEnable')} /></label>
      </Row>
      <p className="py-2 text-xs font-semibold text-muted-foreground" data-testid="mcp-state" data-state={!on ? 'off' : status.data?.error ? 'error' : status.data?.running ? 'running' : 'starting'}>{stateText}</p>
      <Row label={t('settings.mcpWrites')}>
        <div className="grid max-w-md justify-items-end gap-1">
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><PencilLine className="size-4" /><Switch checked={!!s?.allow_writes} disabled={!s || set.isPending} onCheckedChange={(v) => save({ allow_writes: v }, v ? t('settings.mcpWritesOn') : t('settings.mcpWritesOff'))} data-testid="mcp-writes" aria-label={t('settings.mcpWrites')} /></label>
          <span className="text-right text-xs text-muted-foreground">{s?.allow_writes ? t('settings.mcpWritesHintOn') : t('settings.mcpWritesHintOff')}</span>
        </div>
      </Row>
      <Row label={t('settings.mcpDeletes')}>
        <div className="grid max-w-md justify-items-end gap-1">
          <label className={cn('flex items-center gap-2 text-sm text-muted-foreground', !s?.allow_writes && 'opacity-60')}><Trash2 className="size-4" /><Switch checked={!!s?.allow_writes && !!s?.allow_deletes} disabled={!s || !s.allow_writes || set.isPending} onCheckedChange={(v) => save({ allow_deletes: v }, v ? t('settings.mcpDeletesOn') : t('settings.mcpDeletesOff'))} data-testid="mcp-deletes" aria-label={t('settings.mcpDeletes')} /></label>
          <span className="text-right text-xs text-muted-foreground">{!s?.allow_writes ? t('settings.mcpDeletesNeedsWrites') : s.allow_deletes ? t('settings.mcpDeletesHintOn') : t('settings.mcpDeletesHintOff')}</span>
        </div>
      </Row>
      <Row label={t('settings.mcpAi')}>
        <div className="grid justify-items-end gap-1">
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><Sparkles className="size-4" /><Switch checked={!!s?.allow_ai} disabled={!s || set.isPending} onCheckedChange={(v) => save({ allow_ai: v }, v ? t('settings.mcpAiOn') : t('settings.mcpAiOff'))} data-testid="mcp-ai" aria-label={t('settings.mcpAi')} /></label>
          <span className="text-right text-xs text-muted-foreground" data-testid="mcp-ai-hint">{!s?.allow_ai ? t('settings.mcpAiHintOff') : ai.data?.hasKey ? t('settings.mcpAiHintOn') : t('settings.mcpAiHintNoKey')}{/* the key lives in another area of the settings */}{!!s?.allow_ai && !!ai.data && !ai.data.hasKey && <> <a href={routeHref({ page: 'settings', section: 'ai' })} className="font-semibold text-primary underline-offset-2 hover:underline" data-testid="mcp-ai-open-key">{t('settings.mcpAiOpenKey')}</a></>}</span>
        </div>
      </Row>
      <Row label={t('settings.mcpPort')}>
        <div className="flex items-center gap-2">
          <Input value={curPort} inputMode="numeric" className="h-8 w-24 font-mono text-xs" onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} data-testid="mcp-port" />
          <Button size="sm" disabled={!portDirty || set.isPending} onClick={() => { const p = Number(curPort); if (p >= 1024 && p <= 65535) { set.mutate({ ...s!, port: p }, { onSuccess: () => { setPort(null); toast.success(t('settings.mcpPortSaved', { port: p })); }, onError: reportError }); } else toast.error(t('settings.mcpPortInvalid')); }} data-testid="mcp-port-save">{t('settings.aiSave')}</Button>
        </div>
      </Row>
      <Row label={t('settings.mcpToken')}>
        <div className="grid w-full max-w-md justify-items-end gap-1.5">
          <div className="flex w-full items-center gap-2">
            <Input readOnly value={token ? (showToken ? token : '•'.repeat(24)) : ''} placeholder={t('settings.mcpTokenNone')} className="h-8 font-mono text-xs" data-testid="mcp-token" data-shown={showToken || undefined} />
            <Button size="icon-sm" variant="outline" disabled={!token} onClick={() => setShowToken((v) => !v)} title={showToken ? t('settings.mcpTokenHide') : t('settings.mcpTokenShow')} aria-label={showToken ? t('settings.mcpTokenHide') : t('settings.mcpTokenShow')} data-testid="mcp-token-show">{showToken ? <EyeOff /> : <Eye />}</Button>
            <Button size="icon-sm" variant="outline" disabled={!token} onClick={() => void copy(token)} title={t('settings.mcpCopy')} aria-label={t('settings.mcpCopy')}><Copy /></Button>
            <Button size="sm" variant="outline" disabled={!s || regen.isPending} onClick={() => regen.mutate(undefined, { onSuccess: () => toast.success(t('settings.mcpTokenNew')), onError: reportError })} data-testid="mcp-token-regen"><RefreshCw />{t('settings.mcpTokenRegen')}</Button>
          </div>
          <span className="text-right text-xs text-muted-foreground">{t('settings.mcpTokenHint')}</span>
        </div>
      </Row>
      <Row label={t('settings.mcpFolders')}>
        <div className="grid w-full max-w-md justify-items-end gap-1.5">
          <ul className="grid w-full gap-1" data-testid="mcp-folders">
            {(s?.import_dirs ?? []).map((d) => (
              <li key={d} className="flex items-center gap-2 rounded-[10px] bg-secondary px-3 py-1.5 text-xs" data-testid="mcp-folder">
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-mono" title={d}>{d}</span>
                <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-destructive" aria-label={t('settings.remove')} onClick={() => save({ import_dirs: s!.import_dirs.filter((x) => x !== d) }, t('settings.mcpFolderRemoved'))} data-testid="mcp-folder-remove"><X className="size-3.5" /></button>
              </li>
            ))}
            {(s?.import_dirs ?? []).length === 0 && <li className="text-xs text-muted-foreground">{t('settings.mcpFoldersNone')}</li>}
          </ul>
          <div className="flex gap-2">
            {status.data?.downloadsDir && !s?.import_dirs.includes(status.data.downloadsDir) && <Button size="sm" variant="outline" disabled={!s || set.isPending} onClick={useDownloads} data-testid="mcp-folder-downloads"><Download />{t('settings.mcpUseDownloads')}</Button>}
            <Button size="sm" variant="outline" disabled={!s || set.isPending} onClick={() => void addFolder()} data-testid="mcp-folder-add"><Plus />{t('settings.addFolder')}</Button>
          </div>
          <span className="text-right text-xs text-muted-foreground">{t('settings.mcpFoldersHint')}</span>
        </div>
      </Row>
      {on && token && (
        <div className="grid gap-3 py-3" data-testid="mcp-snippets">
          <p className="text-xs font-semibold text-muted-foreground">{t('settings.mcpConnectHint')}</p>
          <div className="grid gap-1">
            <div className="flex items-center justify-between gap-2"><b className="text-sm">{t('settings.mcpClaudeDesktop')}</b><Button size="sm" variant="ghost" onClick={() => void copy(desktopConfig)} data-testid="mcp-copy-desktop"><Copy />{t('settings.mcpCopy')}</Button></div>
            <pre className="overflow-x-auto rounded-[10px] bg-secondary p-3 font-mono text-[11px] leading-relaxed" data-testid="mcp-snippet-desktop">{desktopConfig}</pre>
            <span className="text-xs text-muted-foreground">{t('settings.mcpClaudeDesktopHint')}</span>
          </div>
          <div className="grid gap-1">
            <div className="flex items-center justify-between gap-2"><b className="text-sm">{t('settings.mcpClaudeCode')}</b><Button size="sm" variant="ghost" onClick={() => void copy(codeCommand)} data-testid="mcp-copy-code"><Copy />{t('settings.mcpCopy')}</Button></div>
            <pre className="overflow-x-auto rounded-[10px] bg-secondary p-3 font-mono text-[11px] leading-relaxed" data-testid="mcp-snippet-code">{codeCommand}</pre>
          </div>
        </div>
      )}
      <p className="rounded-[10px] bg-accent p-3 text-xs font-semibold text-accent-foreground" data-testid="mcp-sent">{t('settings.mcpSent')}</p>
    </Card>
  );
}

const AUDIT_PAGE = 20;
const AUDIT_PROJECTS_SHOWN = 4;

/**
 * What agents changed over MCP (#103): the engine's journal of writing tool calls, newest
 * first. A record to inspect; taking a change back comes with undo/redo (APP-6).
 */
function McpAuditCard() {
  const { t } = useTranslation();
  const mcp = useMcpSettings();
  const [limit, setLimit] = useState(AUDIT_PAGE);
  const audit = useMcpAudit(limit, !!mcp.data?.enabled);
  const clear = useClearMcpAudit();
  const [confirming, setConfirming] = useState(false);
  const entries = audit.data?.entries ?? [];
  const total = audit.data?.total ?? 0;
  return (
    <Card title={t('settings.mcpAudit')} hint={t('settings.mcpAuditHint')} action={<Button size="sm" variant="outline" disabled={total === 0 || clear.isPending} onClick={() => setConfirming(true)} data-testid="mcp-audit-clear"><Trash2 />{t('settings.mcpAuditClear')}</Button>}>
      {total === 0
        ? <p className="py-3 text-sm text-muted-foreground" data-testid="mcp-audit-empty">{t('settings.mcpAuditEmpty')}</p>
        : (
          <>
            <p className="py-2 text-xs font-semibold text-muted-foreground" data-testid="mcp-audit-count">{t('settings.mcpAuditCount', { count: total })}</p>
            <ul className="grid" data-testid="mcp-audit">
              {entries.map((e, i) => <McpAuditRow key={`${e.at}-${e.tool}-${i}`} entry={e} />)}
            </ul>
            {total > entries.length && <div className="pt-3"><Button size="sm" variant="outline" disabled={audit.isFetching} onClick={() => setLimit((n) => n + AUDIT_PAGE)} data-testid="mcp-audit-more">{t('settings.mcpAuditShowMore')}</Button></div>}
            <p className="pt-3 text-xs text-muted-foreground">{t('settings.mcpAuditUndo')}</p>
          </>
        )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('settings.mcpAuditClearTitle')}</DialogTitle><DialogDescription>{t('settings.mcpAuditClearBody')}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button><Button variant="destructive" data-testid="mcp-audit-clear-confirm" onClick={() => { setConfirming(false); clear.mutate(undefined, { onSuccess: () => { setLimit(AUDIT_PAGE); toast.success(t('settings.mcpAuditCleared')); }, onError: reportError }); }}>{t('settings.mcpAuditClear')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function McpAuditRow({ entry }: { entry: McpAuditEntry }) {
  const { t, i18n } = useTranslation();
  const when = new Date(entry.at);
  const shown = entry.projects.slice(0, AUDIT_PROJECTS_SHOWN);
  const more = entry.project_count - shown.length;
  return (
    <li className="grid gap-1.5 border-b border-border py-3 last:border-0" data-testid="mcp-audit-entry" data-tool={entry.tool}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-xs font-semibold">{entry.tool}</code>
        <time dateTime={entry.at} className="text-xs font-semibold text-muted-foreground" title={entry.at}>{Number.isNaN(when.getTime()) ? entry.at : when.toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })}</time>
        {entry.failed > 0 && <span className="text-xs font-semibold text-warning" data-testid="mcp-audit-failed">{t('settings.mcpAuditFailed', { count: entry.failed })}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        {shown.map((p) => <a key={p.id} href={routeHref({ page: 'project', id: p.id })} className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold hover:bg-accent hover:text-accent-foreground" title={t('settings.mcpAuditProject', { title: p.title })} data-testid="mcp-audit-project">{p.title}</a>)}
        {more > 0 && <span className="text-xs text-muted-foreground">{t('settings.mcpAuditMore', { count: more })}</span>}
        {entry.project_count === 0 && <span className="text-xs text-muted-foreground">{t('settings.mcpAuditNoProjects')}</span>}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none font-semibold" data-testid="mcp-audit-details">{t('settings.mcpAuditDetails')}</summary>
        <pre className="mt-1.5 overflow-x-auto rounded-[10px] bg-secondary p-3 font-mono text-[11px] leading-relaxed text-foreground" data-testid="mcp-audit-args">{JSON.stringify(entry.args, null, 2)}</pre>
      </details>
    </li>
  );
}
