import { browser, $, $$, expect } from '@wdio/globals';

import fs from 'node:fs';
import path from 'node:path';

// AI assistance (ADR-0003, Epic 9) against the real app in test mode with MESHKEEP_AI_MOCK=ok:
// no call without a key, the key never lands in settings.json, every provider has its own
// key, and an applied suggestion is written through the normal sidecar save.
describe('Meshkeep AI assistance (mock provider)', () => {
  const dataDir = () => process.env.MESHKEEP_E2E_DATA_DIR!;
  const fixture = () => process.env.MESHKEEP_E2E_FIXTURE!;
  const KEY = 'sk-ant-e2e-secret-key-value';

  afterEach(async function () {
    fs.mkdirSync('logs', { recursive: true });
    const name = (this.currentTest?.title || 'test').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    try { await browser.saveScreenshot(`logs/${name}.png`); } catch { /* window may be gone */ }
  });

  it('refuses to call the provider without a key and keeps the key out of settings.json', async () => {
    await $('[data-testid="app"]').waitForDisplayed({ timeout: 30000 });
    await browser.url(await browser.getUrl().then((u) => u.split('#')[0] + '#/settings'));
    await $('[data-testid="settings"]').waitForDisplayed({ timeout: 20000 });
    await expect($('[data-testid="ai-key-status"]')).toHaveAttribute('data-state', 'missing');
    // the engine gate: a suggestion without a key fails before any provider is touched
    const gated = await browser.tauri.execute(({ core }) => core.invoke('suggest_metadata', { projectId: 'nope' }).then(() => 'ok', (e: { code: string }) => e.code));
    expect(gated).toBe('ai_disabled');
    // endpoint and model persist in settings.json
    await $('[data-testid="ai-model"]').setValue('e2e-model');
    await $('[data-testid="ai-save"]').click();
    const settingsFile = path.join(dataDir(), 'settings.json');
    await browser.waitUntil(() => fs.existsSync(settingsFile) && fs.readFileSync(settingsFile, 'utf8').includes('e2e-model'), { timeout: 10000, timeoutMsg: 'ai settings were not written' });
    // the key is stored (in memory in test mode), never written to settings.json
    await $('[data-testid="ai-key"]').setValue(KEY);
    await $('[data-testid="ai-key-save"]').click();
    await browser.waitUntil(async () => (await $('[data-testid="ai-key-status"]').getAttribute('data-state')) === 'stored', { timeout: 10000 });
    expect(await $('[data-testid="ai-key"]').getValue()).toBe('');
    await $('[data-testid="ai-test"]').click();
    await browser.waitUntil(async () => (await $('[data-testid="ai-test-status"]').getAttribute('data-state')) === 'ok', { timeout: 15000, timeoutMsg: 'connection test did not succeed' });
    const text = fs.readFileSync(settingsFile, 'utf8');
    expect(text).toContain('e2e-model');
    expect(text).not.toContain(KEY);
    expect(text.toLowerCase()).not.toContain('sk-ant');

    // every provider has its own key: with OpenAI or Gemini configured, the key stored for
    // Anthropic is not theirs, so no request is made until they get one
    type View = { provider: string; model: string; hasKey: boolean; defaultBaseUrl: string };
    const configure = (settings: { provider: string; base_url: string | null; model: string }) =>
      browser.tauri.execute(({ core }, s) => core.invoke('set_ai_settings', { settings: s }), settings) as Promise<View>;
    const testAi = () => browser.tauri.execute(({ core }) => core.invoke('test_ai').then(() => 'ok', (e: { code: string }) => e.code));
    const openai = await configure({ provider: 'openai', base_url: null, model: '' });
    expect(openai).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', hasKey: false, defaultBaseUrl: 'https://api.openai.com' });
    expect(await testAi()).toBe('ai_disabled');
    expect(fs.readFileSync(settingsFile, 'utf8')).toContain('"provider": "openai"');
    expect(await browser.tauri.execute(({ core }) => core.invoke('set_ai_key', { key: 'sk-openai-e2e-key' }))).toBe(true);
    expect(await testAi()).toBe('ok');
    const gemini = await configure({ provider: 'gemini', base_url: null, model: '' });
    expect(gemini).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash-lite', hasKey: false });
    expect(await testAi()).toBe('ai_disabled');
    // removing the OpenAI key leaves the first one where it was
    await configure({ provider: 'openai', base_url: null, model: '' });
    expect(await browser.tauri.execute(({ core }) => core.invoke('set_ai_key', { key: null }))).toBe(false);
    const back = await configure({ provider: 'anthropic', base_url: null, model: 'e2e-model' });
    expect(back).toMatchObject({ provider: 'anthropic', model: 'e2e-model', hasKey: true });
    expect(await testAi()).toBe('ok');
    const after = fs.readFileSync(settingsFile, 'utf8');
    expect(after).not.toContain(KEY);
    expect(after).not.toContain('sk-openai');
  });

  it('applies a suggestion through the sidecar save and writes project.yaml', async () => {
    await browser.url(await browser.getUrl().then((u) => u.split('#')[0] + '#/library'));
    await $('[data-testid="library"]').waitForDisplayed({ timeout: 20000 });
    await $('[data-testid="search"]').setValue('Vase');
    const card = await $('[data-testid="project-card"][data-id$="Decor/Vase"]');
    await card.waitForDisplayed({ timeout: 15000 });
    await card.click();
    await expect($('[data-testid="inspector-title"]')).toHaveText('Vase');
    await $('[data-testid="inspector-suggest"]').click();
    await $('[data-testid="suggest-dialog"]').waitForDisplayed({ timeout: 10000 });
    await browser.waitUntil(async () => (await $$('[data-testid="suggest-field"]')).length >= 2, { timeout: 15000, timeoutMsg: 'no suggestion fields appeared' });
    expect(await $('[data-testid="suggest-meta"]').getText()).toContain('Model: mock');
    await $('[data-testid="suggest-apply"]').click();
    const sidecar = path.join(fixture(), 'Decor/Vase/project.yaml');
    await browser.waitUntil(() => fs.existsSync(sidecar), { timeout: 10000, timeoutMsg: 'project.yaml was not written' });
    const yaml = fs.readFileSync(sidecar, 'utf8');
    expect(yaml).toContain('Mock Creator');
    expect(yaml).toContain('- mock');
    await browser.waitUntil(async () => (await $('[data-testid="inspector"]').getText()).includes('project.yaml in sync'), { timeout: 15000 });
    // the answer is a cache entry in app data, never library content
    expect(fs.readdirSync(path.join(dataDir(), 'ai-cache')).filter((f) => f.endsWith('.json')).length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(fixture(), 'Decor/Vase/ai-cache'))).toBe(false);
    // leave the fixture as it was, and tell the app: every spec file shares this app instance,
    // so its index and caches must see the sidecar go before the next spec touches the project
    fs.unlinkSync(sidecar);
    await $('[data-testid="rescan"]').click();
    await browser.waitUntil(async () => (await $('[data-testid="inspector"]').getText()).includes('no project.yaml yet'), { timeout: 15000, timeoutMsg: 'the rescan did not drop the removed sidecar' });
    await $('[data-testid="search"]').clearValue();
    await browser.waitUntil(async () => (await $('[data-testid="search"]').getValue()) === '', { timeout: 5000 });
  });
});
