import { FolderOpen, Info, Plug, SlidersHorizontal, Sparkles, type LucideIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScanState } from '@/App';
import { routeHref, SETTINGS_SECTIONS, type SettingsSection } from '@/lib/router';
import { cn } from '@/lib/utils';
import { AboutSection } from './AboutSection';
import { AiSection } from './AiSection';
import { GeneralSection } from './GeneralSection';
import { LibrarySection } from './LibrarySection';
import { McpSection } from './McpSection';

const SECTION_ICONS: Record<SettingsSection, LucideIcon> = { library: FolderOpen, general: SlidersHorizontal, ai: Sparkles, mcp: Plug, about: Info };

/**
 * The settings screen (APP-4): a navigation of areas on the left, the cards of one area on the
 * right. Each area has an address (`#/settings/<area>`), so a dialog that needs a setting can
 * send the user to the card it means instead of to the top of a long page.
 */
export function SettingsPage({ section = SETTINGS_SECTIONS[0], scanning, onScanEnd }: { section?: SettingsSection; scanning: ScanState; onScanEnd: (rootId: string) => void }) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement | null>(null);
  // a new area starts at its top, not where the last one was scrolled to; in a narrow window
  // the navigation is a row that scrolls sideways, and the current area must be in view
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    scroller.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [section]);

  return (
    <div ref={scroller} className="h-full overflow-auto" data-testid="settings" data-section={section}>
      <div className="mx-auto grid max-w-[1160px] gap-x-8 gap-y-4 px-6 pb-10 pt-5 md:grid-cols-[200px_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-3 md:sticky md:top-5 md:self-start">
          <h1 className="text-2xl font-extrabold tracking-tight">{t('settings.title')}</h1>
          <nav aria-label={t('settings.sectionsNav')} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:grid md:overflow-visible" data-testid="settings-nav">
            {SETTINGS_SECTIONS.map((s) => {
              const Icon = SECTION_ICONS[s];
              return (
                <a key={s} href={routeHref({ page: 'settings', section: s })} aria-current={s === section ? 'page' : undefined} className={cn('inline-flex h-9 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-bold text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40', s === section && 'bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground')} data-testid={`settings-nav-${s}`}>
                  <Icon className="size-4 shrink-0" /><span>{t(`settings.sections.${s}`)}</span>
                </a>
              );
            })}
          </nav>
        </div>
        <div className="grid min-w-0 max-w-[920px] content-start gap-5" data-testid="settings-section">
          {section === 'library' && <LibrarySection scanning={scanning} onScanEnd={onScanEnd} />}
          {section === 'general' && <GeneralSection />}
          {section === 'ai' && <AiSection />}
          {section === 'mcp' && <McpSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
