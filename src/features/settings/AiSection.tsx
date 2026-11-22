import { Globe, KeyRound, Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { getBackend } from '@/lib/backend';
import { reportError } from '@/lib/errors';
import { useAiSettings, useNetworkSettings, useSetNetworkSettings, useSetAiKey, useSetAiSettings } from '@/lib/queries';
import { AI_PROVIDERS, isAppError, type AiProviderKind, type AiTestReport } from '@/lib/types';
import { Card, Row } from './Card';

/** Settings › AI & network: the two opt-in features that send something off this machine. */
export function AiSection() {
  return (
    <>
      <AiCard />
      <NetworkCard />
    </>
  );
}

/**
 * AI assistance (ADR-0003, Epic 9): provider, endpoint and model go to settings.json, the key
 * to the OS credential store (one per provider), and the card says in plain words what a
 * suggestion sends.
 */
function AiCard() {
  const { t } = useTranslation();
  const ai = useAiSettings();
  const setSettings = useSetAiSettings();
  const setKey = useSetAiKey();
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [key, setKeyInput] = useState('');
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'failed'; report?: AiTestReport; error?: string }>({ state: 'idle' });
  const curBase = baseUrl ?? ai.data?.base_url ?? '';
  const curModel = model ?? ai.data?.model ?? '';
  const dirty = !!ai.data && (curBase !== (ai.data.base_url ?? '') || curModel !== ai.data.model);
  const provider = ai.data?.provider ?? 'anthropic';
  const providerName = t(`settings.aiProviders.${provider}`);
  const save = () => setSettings.mutate({ provider, base_url: curBase.trim() || null, model: curModel }, {
    onSuccess: () => { setBaseUrl(null); setModel(null); toast.success(t('settings.aiSaved')); },
    onError: reportError,
  });
  // another provider is another service: its own endpoint, its default model (an empty model
  // is filled in by the engine) and its own key, so nothing typed for the old one carries over
  const switchProvider = (next: AiProviderKind) => setSettings.mutate({ provider: next, base_url: null, model: '' }, {
    onSuccess: () => { setBaseUrl(null); setModel(null); setKeyInput(''); setTest({ state: 'idle' }); toast.success(t('settings.aiSaved')); },
    onError: reportError,
  });
  const saveKey = () => setKey.mutate(key, { onSuccess: () => { setKeyInput(''); setTest({ state: 'idle' }); toast.success(t('settings.aiKeySaved')); }, onError: reportError });
  const removeKey = () => setKey.mutate(null, { onSuccess: () => { setTest({ state: 'idle' }); toast(t('settings.aiKeyRemoved')); }, onError: reportError });
  const runTest = async () => {
    setTest({ state: 'testing' });
    try { const b = await getBackend(); setTest({ state: 'ok', report: await b.testAi() }); } catch (e) { setTest({ state: 'failed', error: isAppError(e) ? t(`errors.${e.code}`, { defaultValue: e.message, message: e.message }) : String(e) }); }
  };
  return (
    <Card title={t('settings.ai')} hint={t('settings.aiHint')} action={<Button size="sm" variant="outline" disabled={!ai.data?.hasKey || test.state === 'testing'} onClick={() => void runTest()} data-testid="ai-test"><Sparkles />{test.state === 'testing' ? t('settings.aiTesting') : t('settings.aiTest')}</Button>}>
      <Row label={t('settings.aiProvider')}>
        <div className="grid w-full max-w-md justify-items-end gap-1">
          <Select value={provider} onValueChange={(v) => switchProvider(v as AiProviderKind)} disabled={!ai.data || setSettings.isPending}>
            <SelectTrigger size="sm" data-testid="ai-provider" data-provider={provider} aria-label={t('settings.aiProvider')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {AI_PROVIDERS.map((p) => <SelectItem key={p} value={p} data-testid={`ai-provider-${p}`}>{t(`settings.aiProviders.${p}`)}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-right text-xs text-muted-foreground">{t('settings.aiProviderHint')}</span>
        </div>
      </Row>
      <Row label={t('settings.aiBaseUrl')}>
        <div className="grid w-full max-w-md justify-items-end gap-1">
          <Input value={curBase} placeholder={ai.data?.defaultBaseUrl ?? ''} className="h-8 w-full font-mono text-xs" onChange={(e) => setBaseUrl(e.target.value)} data-testid="ai-base-url" />
          <span className="text-right text-xs text-muted-foreground">{t('settings.aiBaseUrlHint')}</span>
        </div>
      </Row>
      <Row label={t('settings.aiModel')}>
        <div className="flex w-full max-w-md items-center gap-2">
          <Input value={curModel} className="h-8 font-mono text-xs" onChange={(e) => setModel(e.target.value)} data-testid="ai-model" />
          <Button size="sm" disabled={!dirty || setSettings.isPending} onClick={save} data-testid="ai-save">{t('settings.aiSave')}</Button>
        </div>
      </Row>
      <Row label={t('settings.aiKey')}>
        <div className="grid w-full max-w-md justify-items-end gap-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold" data-testid="ai-key-status" data-state={ai.data?.hasKey ? 'stored' : 'missing'}><KeyRound className={ai.data?.hasKey ? 'size-3.5 text-success' : 'size-3.5 text-muted-foreground'} />{ai.data?.hasKey ? t('settings.aiKeyStored', { provider: providerName }) : t('settings.aiKeyMissing', { provider: providerName })}</div>
          <form className="flex w-full items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (key.trim()) saveKey(); }}>
            <Input type="password" autoComplete="off" value={key} placeholder={t('settings.aiKeyPlaceholder')} className="h-8 font-mono text-xs" onChange={(e) => setKeyInput(e.target.value)} data-testid="ai-key" />
            <Button type="submit" size="sm" disabled={!key.trim() || setKey.isPending} data-testid="ai-key-save">{t('settings.aiKeySave')}</Button>
            {ai.data?.hasKey && <Button type="button" size="sm" variant="ghost" disabled={setKey.isPending} onClick={removeKey} data-testid="ai-key-remove">{t('settings.aiKeyRemove')}</Button>}
          </form>
        </div>
      </Row>
      <div className="py-3 text-[13px] font-semibold text-secondary-foreground" data-testid="ai-test-status" data-state={test.state} aria-live="polite">
        {test.state === 'testing' && <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" />{t('settings.aiTesting')}</span>}
        {test.state === 'ok' && <span className="text-success">{t('settings.aiTestOk', { model: test.report?.model })}</span>}
        {test.state === 'failed' && <span className="text-warning">{t('settings.aiTestFailed', { message: test.error })}</span>}
      </div>
      <p className="rounded-[10px] bg-accent p-3 text-xs font-semibold text-accent-foreground" data-testid="ai-sent">{t('settings.aiSent')}</p>
    </Card>
  );
}

/** Opt-in network features (META-7 stage 2). Off by default; each one is named in the privacy policy. */
function NetworkCard() {
  const { t, i18n } = useTranslation();
  const net = useNetworkSettings();
  const set = useSetNetworkSettings();
  const on = net.data?.fetch_model_pages ?? false;
  const privacyUrl = i18n.language.startsWith('de') ? 'https://meshkeep.app/de/datenschutz/' : 'https://meshkeep.app/privacy/';
  return (
    <Card title={t('settings.network')} hint={t('settings.networkHint')}>
      <Row label={t('settings.fetchPages')}>
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><Globe className="size-4" /><Switch checked={on} disabled={!net.data || set.isPending} onCheckedChange={(v) => set.mutate({ ...(net.data ?? { fetch_model_pages: false }), fetch_model_pages: v }, { onSuccess: (s) => toast.success(s.fetch_model_pages ? t('settings.fetchPagesOn') : t('settings.fetchPagesOff')), onError: reportError })} data-testid="fetch-pages-toggle" aria-label={t('settings.fetchPages')} /></label>
      </Row>
      <p className="mt-2 text-xs font-semibold text-muted-foreground" data-testid="fetch-pages-status" data-state={on ? 'on' : 'off'}>{on ? t('settings.fetchPagesHintOn') : t('settings.fetchPagesHintOff')} <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => getBackend().then((b) => b.openUrl(privacyUrl)).catch(reportError)}>{t('settings.privacyPolicy')}</button></p>
    </Card>
  );
}
