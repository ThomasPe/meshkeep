import { describe, expect, it } from 'vitest';
import { parseRoute, routeHref, SETTINGS_SECTIONS } from '@/lib/router';

describe('router', () => {
  it('round-trips project ids with special characters', () => {
    const id = 'r1:Projects/Gridfinity/Rugged Box v2 (ü)';
    expect(parseRoute(routeHref({ page: 'project', id }))).toEqual({ page: 'project', id });
  });
  it('defaults to the library', () => {
    expect(parseRoute('')).toEqual({ page: 'library' });
    expect(parseRoute('#/nonsense')).toEqual({ page: 'library' });
    expect(parseRoute('#/settings')).toEqual({ page: 'settings' });
  });
  it('addresses the areas of the settings screen', () => {
    for (const section of SETTINGS_SECTIONS) expect(parseRoute(routeHref({ page: 'settings', section }))).toEqual({ page: 'settings', section });
    expect(routeHref({ page: 'settings' })).toBe('#/settings');
    expect(routeHref({ page: 'settings', section: 'mcp' })).toBe('#/settings/mcp');
    // an area that does not exist opens the settings screen with its default area
    expect(parseRoute('#/settings/nonsense')).toEqual({ page: 'settings' });
    expect(parseRoute('#/settingsx')).toEqual({ page: 'library' });
  });
});
