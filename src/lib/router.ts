import { useEffect, useState } from 'react';

/** The areas of the settings screen, in the order its navigation shows them. The first one is the default. */
export const SETTINGS_SECTIONS = ['library', 'general', 'ai', 'mcp', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route = { page: 'welcome' } | { page: 'library' } | { page: 'project'; id: string } | { page: 'settings'; section?: SettingsSection };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h.startsWith('project/')) return { page: 'project', id: decodeURIComponent(h.slice('project/'.length)) };
  if (h === 'settings' || h.startsWith('settings/')) {
    // an unknown area (an old link, a typo) opens the default one instead of leaving the screen
    const section = SETTINGS_SECTIONS.find((x) => x === h.slice('settings/'.length));
    return section ? { page: 'settings', section } : { page: 'settings' };
  }
  if (h === 'welcome') return { page: 'welcome' };
  return { page: 'library' };
}

export function routeHref(r: Route): string {
  switch (r.page) {
    case 'project': return `#/project/${encodeURIComponent(r.id)}`;
    case 'settings': return r.section ? `#/settings/${r.section}` : '#/settings';
    case 'welcome': return '#/welcome';
    default: return '#/library';
  }
}

export function navigate(r: Route) {
  location.hash = routeHref(r);
}

/**
 * A project got a new id (its folder was renamed or moved): the details page showing it
 * follows, without leaving the dead address in the history. Any other page stays.
 */
export function followProject(oldId: string, newId: string) {
  const r = parseRoute(location.hash);
  if (oldId !== newId && r.page === 'project' && r.id === oldId) location.replace(routeHref({ page: 'project', id: newId }));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}
