import { Bell, Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { hotkeyCaps, hotkeysFor, type HotkeyAction } from '@/lib/hotkeys';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { LANGUAGES, setLanguage, type Language } from '@/i18n';
import { applyTheme, loadNotifications, loadTheme, saveNotifications, type Theme } from '@/lib/store';
import { Card, Row } from './Card';

/** Settings › General: how the app looks and behaves for this user. */
export function GeneralSection() {
  const { t, i18n } = useTranslation();
  const [notify, setNotify] = useState(loadNotifications());
  const [theme, setTheme] = useState<Theme>(loadTheme());
  return (
    <>
      <Card title={t('settings.appearance')}>
        <Row label={t('settings.theme')}>
          <ToggleGroup type="single" value={theme} onValueChange={(v) => { if (v) { applyTheme(v as Theme); setTheme(v as Theme); } }}>
            <ToggleGroupItem value="light"><Sun />{t('settings.themes.light')}</ToggleGroupItem>
            <ToggleGroupItem value="dark"><Moon />{t('settings.themes.dark')}</ToggleGroupItem>
            <ToggleGroupItem value="system"><Monitor />{t('settings.themes.system')}</ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <Row label={t('settings.language')}>
          <Select value={i18n.language.slice(0, 2)} onValueChange={(v) => setLanguage(v as Language)}>
            <SelectTrigger size="sm" className="shadow-none" data-testid="language"><SelectValue /></SelectTrigger>
            <SelectContent>{LANGUAGES.map((l) => <SelectItem key={l} value={l}>{l === 'de' ? 'Deutsch' : 'English'}</SelectItem>)}</SelectContent>
          </Select>
        </Row>
      </Card>

      <Card title={t('settings.notifications')} hint={t('settings.notificationsHint')}>
        <Row label={t('settings.notificationsToggle')}>
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><Bell className="size-4" /><Switch checked={notify} onCheckedChange={(v) => { setNotify(v); saveNotifications(v); }} data-testid="notifications-toggle" aria-label={t('settings.notificationsToggle')} /></label>
        </Row>
      </Card>

      <ShortcutsCard />
    </>
  );
}

const SHORTCUT_ACTIONS: HotkeyAction[] = ['selectAll', 'open', 'rename', 'delete', 'clearSelection', 'focusSearch'];

/** The shortcuts of the library, read from the key map so the list cannot drift from it (#68). */
function ShortcutsCard() {
  const { t } = useTranslation();
  return (
    <Card title={t('hotkeys.title')} hint={t('hotkeys.hint')}>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 text-[13px]" data-testid="shortcuts">
        {SHORTCUT_ACTIONS.map((action) => (
          <div key={action} className="col-span-2 grid grid-cols-subgrid items-center border-b border-border py-2 last:border-0" data-testid="shortcut" data-action={action}>
            <dt className="font-semibold">{t(`hotkeys.actions.${action}`)}</dt>
            <dd className="flex flex-wrap justify-end gap-x-2 gap-y-1">
              {hotkeysFor(action).map((h) => (
                <span key={h.key} className="flex gap-1">
                  {hotkeyCaps(h).map((c) => <kbd key={c} className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{t(`hotkeys.keys.${c}`, { defaultValue: c.toUpperCase() })}</kbd>)}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
