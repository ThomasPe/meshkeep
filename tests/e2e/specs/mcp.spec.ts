import { browser, $, $$, expect } from '@wdio/globals';

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// The MCP server (ADR-0004) of the real app over its real socket, as an agent sees it:
// resources (#100), the app's AI suggestion behind its own switch (#101, mock provider),
// progress as an event stream (#102), and the journal of what the agent changed showing
// up in the window (#103).
describe('Meshkeep MCP server (real app, real socket)', () => {
  const dataDir = () => process.env.MESHKEEP_E2E_DATA_DIR!;
  const fixture = () => process.env.MESHKEEP_E2E_FIXTURE!;
  const PORT = 47391;
  const url = `http://127.0.0.1:${PORT}/mcp`;
  let token = '';
  let nextId = 1;

  // One connection per request, as the stdio bridge does it: a connection kept alive from
  // before the server was stopped would wait on the old instance (ADR-0004, consequences).
  const send = (body: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
      const req = http.request(url, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', Connection: 'close', 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  const post = (body: unknown, headers: Record<string, string> = {}) => send(JSON.stringify(body), { Authorization: `Bearer ${token}`, ...headers });
  const rpc = async (method: string, params: unknown = {}) => {
    const r = await post({ jsonrpc: '2.0', id: nextId++, method, params });
    return JSON.parse(r.text) as { result?: unknown; error?: { code: number; message: string } };
  };
  const tool = async (name: string, args: unknown = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return r.result as { isError: boolean; structuredContent: Record<string, unknown>; content: Array<{ text: string }> };
  };
  const switchOn = async (testid: string) => {
    const s = await $(`[data-testid="${testid}"]`);
    if ((await s.getAttribute('data-state')) !== 'checked') await s.click();
    await browser.waitUntil(async () => (await s.getAttribute('data-state')) === 'checked', { timeout: 10000, timeoutMsg: `${testid} did not turn on` });
  };
  const switchOff = async (testid: string) => {
    const s = await $(`[data-testid="${testid}"]`);
    if ((await s.getAttribute('data-state')) === 'checked') await s.click();
    await browser.waitUntil(async () => (await s.getAttribute('data-state')) !== 'checked', { timeout: 10000, timeoutMsg: `${testid} did not turn off` });
  };

  afterEach(async function () {
    fs.mkdirSync('logs', { recursive: true });
    const name = (this.currentTest?.title || 'test').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    try { await browser.saveScreenshot(`logs/${name}.png`); } catch { /* window may be gone */ }
  });

  it('serves an agent: resources, progress as a stream, the AI suggestion behind its switch, and lists what it changed', async () => {
    await $('[data-testid="app"]').waitForDisplayed({ timeout: 30000 });
    await browser.url(await browser.getUrl().then((u) => u.split('#')[0] + '#/settings/mcp'));
    await $('[data-testid="settings"]').waitForDisplayed({ timeout: 20000 });

    // a port of our own, then the server; the token comes from the card
    await $('[data-testid="mcp-port"]').setValue(String(PORT));
    await $('[data-testid="mcp-port-save"]').click();
    await browser.waitUntil(async () => ((await browser.tauri.execute(({ core }) => core.invoke('get_mcp_settings'))) as { port: number }).port === PORT, { timeout: 10000, timeoutMsg: 'the port was not saved' });
    await switchOn('mcp-toggle');
    await browser.waitUntil(async () => (await $('[data-testid="mcp-state"]').getText()).includes(`127.0.0.1:${PORT}`), { timeout: 15000, timeoutMsg: 'the MCP server did not start on its port' });
    await $('[data-testid="mcp-token-show"]').click();
    token = await $('[data-testid="mcp-token"]').getValue();
    expect(token).toMatch(/^mk_[0-9a-f]{32,}$/);
    expect((await send('{}')).status).toBe(401);

    // #100: projects are resources
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    expect((init.result as { capabilities: { resources: unknown } }).capabilities.resources).toEqual({ subscribe: false, listChanged: false });
    const listed = (await rpc('resources/list')).result as { resources: Array<{ uri: string; name: string }> };
    expect(listed.resources).toHaveLength(6);
    const plates = listed.resources.find((r) => r.name === 'Gridfinity/Baseplates')!;
    expect(plates.uri).toMatch(/^meshkeep:\/\/project\/[^/]+$/);
    const read = (await rpc('resources/read', { uri: plates.uri })).result as { contents: Array<{ mimeType: string; text: string }> };
    const project = JSON.parse(read.contents[0].text) as { id: string; files: Array<{ rel_path: string; uri?: string }> };
    const readme = project.files.find((f) => f.rel_path === 'README.md')!;
    const text = (await rpc('resources/read', { uri: readme.uri })).result as { contents: Array<{ mimeType: string; text: string }> };
    expect(text.contents[0].mimeType).toBe('text/markdown');
    expect(text.contents[0].text).toBe(fs.readFileSync(path.join(fixture(), 'Gridfinity/Baseplates/README.md'), 'utf8'));

    // #102: a tool call with a progress token is answered as an event stream, the result last
    const streamed = await post(
      { jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 'scan_root', arguments: { root_id: project.id.split(':')[0] }, _meta: { progressToken: 'e2e' } } },
      { Accept: 'application/json, text/event-stream' },
    );
    expect(streamed.type).toBe('text/event-stream');
    const events = streamed.text.split('\n\n').filter((e) => e.trim()).map((e) => JSON.parse(e.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as { id?: number; method?: string; params?: { progressToken: string } });
    expect(events.at(-1)!.id).toBe(900);
    for (const e of events.slice(0, -1)) {
      expect(e.method).toBe('notifications/progress');
      expect(e.params!.progressToken).toBe('e2e');
    }
    // without the Accept header the same call is plain JSON
    const plain = await post({ jsonrpc: '2.0', id: 901, method: 'tools/call', params: { name: 'library_stats', arguments: {}, _meta: { progressToken: 'e2e' } } });
    expect(plain.type).toBe('application/json');

    // #103: writes are off, so nothing changes and nothing is recorded
    const sidecar = path.join(fixture(), 'Gridfinity/Baseplates/project.yaml');
    const refused = await tool('update_metadata', { project_id: project.id, creator: 'E2E Agent' });
    expect(refused.isError).toBe(true);
    expect(fs.existsSync(sidecar)).toBe(false);
    await $('[data-testid="mcp-audit-empty"]').waitForDisplayed({ timeout: 10000 });

    await switchOn('mcp-writes');
    try {
      const written = await tool('update_metadata', { project_id: project.id, creator: 'E2E Agent', add_tags: ['from-mcp'] });
      expect(written.isError).toBe(false);
      expect(fs.readFileSync(sidecar, 'utf8')).toContain('E2E Agent');
      // the window lists it: which tool, which project, and what was asked
      await browser.waitUntil(async () => (await $$('[data-testid="mcp-audit-entry"]')).length === 1, { timeout: 15000, timeoutMsg: 'the change did not appear in the journal' });
      const entry = await $('[data-testid="mcp-audit-entry"]');
      expect(await entry.getAttribute('data-tool')).toBe('update_metadata');
      expect(await entry.$('[data-testid="mcp-audit-project"]').getText()).toBe('Baseplates');
      await entry.$('[data-testid="mcp-audit-details"]').click();
      expect(await entry.$('[data-testid="mcp-audit-args"]').getText()).toContain('"creator": "E2E Agent"');
      // the journal is app data, never library content
      expect(fs.readFileSync(path.join(dataDir(), 'mcp-audit.jsonl'), 'utf8')).toContain('"tool":"update_metadata"');
      expect(fs.readdirSync(path.join(fixture(), 'Gridfinity/Baseplates')).sort()).toEqual(['README.md', 'baseplate_2x2.stl', 'project.yaml']);

      // #101: the AI suggestion needs its own switch, then the stored key; it writes nothing
      const off = await tool('suggest_metadata', { project_id: project.id });
      expect(off.isError).toBe(true);
      expect(off.content[0].text).toContain('AI suggestions for agents are off');
      await switchOn('mcp-ai');
      // the key lives in another area of the settings
      await $('[data-testid="settings-nav-ai"]').click();
      await $('[data-testid="ai-key-status"]').waitForDisplayed({ timeout: 10000 });
      if ((await $('[data-testid="ai-key-status"]').getAttribute('data-state')) !== 'stored') {
        const noKey = await tool('suggest_metadata', { project_id: project.id });
        expect(noKey.isError).toBe(true);
        expect(noKey.content[0].text).toContain('API key');
        await $('[data-testid="ai-key"]').setValue('sk-ant-e2e-mcp-key');
        await $('[data-testid="ai-key-save"]').click();
        await browser.waitUntil(async () => (await $('[data-testid="ai-key-status"]').getAttribute('data-state')) === 'stored', { timeout: 10000 });
      }
      await $('[data-testid="settings-nav-mcp"]').click();
      await $('[data-testid="mcp-audit-entry"]').waitForDisplayed({ timeout: 10000 });
      const yamlBefore = fs.readFileSync(sidecar, 'utf8');
      const suggestion = await tool('suggest_metadata', { project_id: project.id });
      expect(suggestion.isError).toBe(false);
      expect(suggestion.structuredContent.creator).toBe('Mock Creator');
      expect(suggestion.structuredContent.model).toBe('mock');
      expect(fs.readFileSync(sidecar, 'utf8')).toBe(yamlBefore);
      expect(await $$('[data-testid="mcp-audit-entry"]')).toHaveLength(1);

      // clearing the history removes the list and nothing else
      await $('[data-testid="mcp-audit-clear"]').click();
      await $('[data-testid="mcp-audit-clear-confirm"]').click();
      await $('[data-testid="mcp-audit-empty"]').waitForDisplayed({ timeout: 10000 });
      expect(fs.existsSync(path.join(dataDir(), 'mcp-audit.jsonl'))).toBe(false);
      expect(fs.readFileSync(sidecar, 'utf8')).toBe(yamlBefore);
    } finally {
      // leave the fixture and the settings as they were: the other specs share this app
      fs.rmSync(sidecar, { force: true });
      await tool('scan_root', { root_id: project.id.split(':')[0] });
      await $('[data-testid="settings-nav-mcp"]').click();
      await switchOff('mcp-ai');
      await switchOff('mcp-writes');
      await switchOff('mcp-toggle');
    }
    await browser.waitUntil(async () => (await $('[data-testid="mcp-state"]').getAttribute('data-state')) === 'off', { timeout: 10000 });
    const titles = (await browser.tauri.execute(({ core }) => core.invoke('list_projects', { query: {} })) as Array<{ title: string; has_sidecar: boolean }>);
    expect(titles.find((p) => p.title === 'Baseplates')!.has_sidecar).toBe(false);
  });
});
