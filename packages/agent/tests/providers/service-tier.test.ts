import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getProvider, ServiceTierConfigurationError } from '../../src/index.js';
import { parseCodexModelCatalog, listCodexModels } from '../../src/providers/codex/discovery.js';
import { listClaudeModels } from '../../src/providers/claude/discovery.js';
import { parseClaudeStreamEvent } from '../../src/providers/claude/parse.js';
import { parseCodexStreamEvent } from '../../src/providers/codex/parse.js';
import { claudeFastModel } from '../../src/providers/claude/service-tier.js';
import { clearModelCache } from '../../src/utils/model-cache.js';
import type { ProviderConfig, StreamEvent } from '../../src/types.js';

const command = path.resolve(import.meta.dirname, '../fixtures/mock-service-tier.mjs');
let dir: string;
let log: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'agentex-speed-test-')); log = path.join(dir, 'wire.jsonl'); clearModelCache(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); clearModelCache(); });
const env = (provider: string, extra: Record<string, string> = {}) => ({ MOCK_SPEED_PROVIDER: provider, MOCK_SPEED_LOG: log, ...extra });
async function messages(): Promise<any[]> { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }

for (const provider of ['codex', 'claude']) describe(`${provider} first-class service tiers`, () => {
  for (const tier of provider === 'codex' ? ['fast', 'priority', 'ultrafast', 'default'] : ['fast', 'default']) {
    it(`passes ${tier} to exec without claiming observed processing speed`, async () => {
      const result = await getProvider(provider).execute({ cwd: dir, prompt: 'hello', env: env(provider), config: { command, model: provider === 'codex' ? 'gpt-test' : 'opus', serviceTier: tier } });
      expect(result.status).toBe('completed');
      expect(result.serviceTier).toMatchObject({ requested: tier, effective: null });
      const launches = await messages();
      const run = launches.find(m => m.args && (provider === 'codex' ? m.args.includes('app-server') : m.args.includes('--print')));
      if (provider === 'codex') {
        expect(run.args).toContain(`service_tier="${tier === 'fast' ? 'priority' : tier}"`);
        expect(run.args.indexOf('-c')).toBeLessThan(run.args.indexOf('app-server'));
        expect(launches.find(m => m.method === 'turn/start').params.serviceTier).toBe(tier === 'fast' ? 'priority' : tier);
      } else {
        expect(run.settings.fastMode).toBe(tier === 'fast');
        const settingsPath = run.args[run.args.indexOf('--settings') + 1];
        await expect(stat(settingsPath)).rejects.toThrow();
      }
    });
    for (const resume of [false, true]) it(`${resume ? 'resumes' : 'starts'} and sends with ${tier}`, async () => {
      const events: StreamEvent[] = [];
      const session = await getProvider(provider).createSession!({ cwd: dir, env: env(provider),
        config: { command, model: provider === 'codex' ? 'gpt-test' : 'opus', serviceTier: tier },
        ...(resume ? { sessionParams: { sessionId: 'saved-speed', cwd: dir } } : {}), onEvent: event => { events.push(event); } });
      try {
        const turn = await (await session.send('hello')).result;
        expect(turn.status).toBe('completed');
        expect(turn.serviceTier?.requested).toBe(tier);
        expect(session.serviceTier?.effective).toBeNull();
        const launches = await messages();
        if (provider === 'codex') {
          const expected = tier === 'fast' ? 'priority' : tier;
          const start = launches.find(m => m.method === (resume ? 'thread/resume' : 'thread/start'));
          expect(start.params.serviceTier).toBe(expected);
          expect(launches.find(m => m.method === 'turn/start').params.serviceTier).toBe(expected);
          expect(session.serviceTier?.selected).toBe(expected);
          if (resume) expect(launches.filter(m => m.method === 'thread/start')).toHaveLength(0);
          expect(events.some(e => e.type === 'service_tier')).toBe(true);
        } else {
          const start = launches.find(m => m.settings);
          expect(start.settings.fastMode).toBe(tier === 'fast');
          if (resume) expect(start.args).toContain('--resume');
          expect((await stat(start.args[start.args.indexOf('--settings') + 1])).mode & 0o777).toBe(0o600);
        }
      } finally { await session.close(); }
      if (provider === 'claude') {
        const start = (await messages()).find(m => m.settings);
        await expect(stat(start.args[start.args.indexOf('--settings') + 1])).rejects.toThrow();
      }
    });
  }
  it('leaves omitted tiers alone on old runtimes', async () => {
    const result = await getProvider(provider).execute({ cwd: dir, prompt: 'hello', env: env(provider, { MOCK_SPEED_VERSION: '0.1.0' }), config: { command } });
    expect(result.status).toBe('completed');
    expect(result.serviceTier).toBeUndefined();
    expect((await messages()).some(m => m.settings || m.args?.some((a: string) => a.startsWith('service_tier=')))).toBe(false);
  });
  it('preserves missing-binary execution errors with a tier', async () => {
    const result = await getProvider(provider).execute({ cwd: dir, prompt: 'hello', config: { command: path.join(dir, 'missing'), serviceTier: 'default' } });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'binary_not_found', exitCode: null });
  });
  it('honors a pre-aborted execution without starting a process', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await getProvider(provider).execute({ cwd: dir, prompt: 'hello', env: env(provider), signal: controller.signal, config: { command, serviceTier: 'default' } });
    expect(result).toMatchObject({ status: 'aborted', errorCode: 'aborted' });
    await expect(stat(log)).rejects.toThrow();
  });
  it('rejects unverified runtime versions before starting inference', async () => {
    await expect(getProvider(provider).execute({ cwd: dir, prompt: 'hello', env: env(provider, { MOCK_SPEED_VERSION: '0.1.0' }), config: { command, model: 'opus', serviceTier: 'fast' } })).rejects.toMatchObject({ code: 'unsupported_runtime' });
    await expect(stat(log)).rejects.toThrow();
  });
  it.each(['', 'fast\n', 'Fast', 'fast tier'])('rejects malformed id %j', async (serviceTier) => {
    await expect(getProvider(provider).execute({ cwd: dir, prompt: 'hello', env: env(provider), config: { command, serviceTier } })).rejects.toBeInstanceOf(ServiceTierConfigurationError);
  });
});

describe('Codex validation and discovery', () => {
  it('changes a saved tier through execute resume using the explicit protocol', async () => {
    const result = await getProvider('codex').execute({ cwd: dir, prompt: 'hello', env: env('codex'), sessionParams: { sessionId: 'saved', cwd: dir }, config: { command, serviceTier: 'default' } });
    expect(result.status).toBe('completed');
    expect(result.sessionDisplayId).toBe('saved');
    expect((await messages()).find(m => m.method === 'thread/resume').params.serviceTier).toBe('default');
    expect(result.serviceTier).toMatchObject({ requested: 'default', selected: 'default', effective: null });
  });
  it('does not replace a resumed thread after a provider policy error', async () => {
    const result = await getProvider('codex').execute({ cwd: dir, prompt: 'hello', env: env('codex', { MOCK_SPEED_RESUME_ERROR: 'Service tier is disabled by organization policy' }), sessionParams: { sessionId: 'saved', cwd: dir }, config: { command, serviceTier: 'default' } });
    expect(result.status).toBe('failed');
    expect((await messages()).some(m => m.method === 'thread/start' || m.method === 'turn/start')).toBe(false);
  });
  it('honors one-shot timeout, closes the process, and reports lifecycle', async () => {
    let pid: number | undefined;
    const result = await getProvider('codex').execute({ cwd: dir, prompt: 'hello', env: env('codex', { MOCK_SPEED_HANG: '1' }), onStart: value => { pid = value; }, config: { command, serviceTier: 'default', timeoutSec: 0.5, graceSec: 0.1 } });
    expect(result.status).toBe('timeout');
    expect(result.errorCode).toBe('timeout');
    expect(pid).toBeTypeOf('number');
    expect(() => process.kill(pid!, 0)).toThrow();
  });
  it('honors cancellation without starting inference when already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await getProvider('codex').execute({ cwd: dir, prompt: 'hello', env: env('codex'), signal: controller.signal, config: { command, serviceTier: 'default' } });
    expect(result.status).toBe('aborted');
    await expect(stat(log)).rejects.toThrow();
  });
  it.each([{ MOCK_SPEED_DISABLED: '1' }, { MOCK_SPEED_TIERS: '[]' }, { MOCK_SPEED_TIERS: 'missing' }])('rejects unavailable/unknown tier support: %j', async extra => {
    await expect(getProvider('codex').execute({ cwd: dir, prompt: 'hello', env: env('codex', extra), config: { command, model: 'gpt-test', serviceTier: 'fast' } })).rejects.toBeInstanceOf(ServiceTierConfigurationError);
    expect((await messages()).some(m => m.method === 'turn/start')).toBe(false);
  });
  it('never replaces a resumed thread after a tier selection mismatch', async () => {
    await expect(getProvider('codex').createSession!({ cwd: dir, env: env('codex', { MOCK_SPEED_SELECTED: 'default' }), sessionParams: { sessionId: 'saved', cwd: dir }, config: { command, serviceTier: 'fast' } })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await messages()).some(m => m.method === 'thread/start' || m.method === 'turn/start')).toBe(false);
  });
  it('validates the saved model on resume, preserving omission of model', async () => {
    const session = await getProvider('codex').createSession!({ cwd: dir, env: env('codex'), sessionParams: { sessionId: 'saved', cwd: dir }, config: { command, serviceTier: 'fast' } });
    await session.close();
    expect((await messages()).find(m => m.method === 'thread/resume').params.model).toBeUndefined();
  });
  it('rejects conflicting raw tier flags', async () => {
    await expect(getProvider('codex').execute({ cwd: dir, prompt: 'hello', env: env('codex'), config: { command, serviceTier: 'default', extraArgs: ['--config=service_tier="fast"'] } })).rejects.toMatchObject({ code: 'conflicting_settings' });
  });
  it('preserves future native tiers, defaults, and unknown availability', () => {
    const [model] = parseCodexModelCatalog(JSON.stringify({ models: [{ slug: 'x', display_name: 'X', visibility: 'list', default_service_tier: 'turbo', service_tiers: [{ id: 'turbo', name: 'Turbo', description: 'New' }, { id: 'turbo', name: 'Duplicate' }, null] }] }));
    expect(model?.defaultServiceTier).toBe('turbo');
    expect(model?.serviceTiers).toEqual([{ id: 'default', name: 'Standard', availability: 'available' }, expect.objectContaining({ id: 'turbo', name: 'Turbo', availability: 'unknown' })]);
  });
  it('normalizes Fast aliases consistently in discovery and selection', async () => {
    const [model] = parseCodexModelCatalog(JSON.stringify({ models: [{ slug: 'x', display_name: 'X', visibility: 'list', default_service_tier: 'fast', service_tiers: [{ id: 'fast', name: 'Fast' }] }] }));
    expect(model?.defaultServiceTier).toBe('priority');
    expect(model?.serviceTiers?.map(tier => tier.id)).toEqual(['default', 'priority']);
    const result = await getProvider('codex').execute({ cwd: dir, prompt: 'hello', env: env('codex', { MOCK_SPEED_TIERS: '[{"id":"fast","name":"Fast"}]' }), config: { command, serviceTier: 'fast' } });
    expect(result.status).toBe('completed');
  });
  it('aligns endpoint/profile discovery and separates cache entries', async () => {
    const config: ProviderConfig = { command, endpoint: { baseUrl: 'http://localhost:9999', apiKey: 'test-key' }, extraArgs: ['--profile', 'work'] };
    const options = { cwd: dir, env: env('codex'), config, cacheTtlMs: 60_000 };
    const first = await listCodexModels(options);
    expect(first[0]?.serviceTiers?.map(t => t.id)).toEqual(['default', 'priority', 'ultrafast']);
    await listCodexModels(options);
    await listCodexModels({ ...options, config: { ...config, extraArgs: ['--profile', 'other'] } });
    const queries = (await messages()).filter(m => m.args?.includes('models'));
    expect(queries).toHaveLength(2);
    expect(queries[0].args).toContain('work');
    expect(queries[0].args.some((arg: string) => arg.includes('http://localhost:9999'))).toBe(true);
    expect(queries[0].args.join(' ')).not.toContain('test-key');
  });
  it('marks disabled Fast as unavailable in model discovery', async () => {
    const models = await listCodexModels({ cwd: dir, config: { command }, env: env('codex', { MOCK_SPEED_DISABLED: '1' }) });
    expect(models[0]?.serviceTiers?.find(t => t.id === 'priority')?.availability).toBe('unavailable');
  });
});

describe('Claude settings and availability', () => {
  it('cleans up private settings after an unexpected process exit', async () => {
    const session = await getProvider('claude').createSession!({ cwd: dir, env: env('claude', { MOCK_SPEED_EXIT: '1' }), config: { command, model: 'opus', serviceTier: 'fast' } });
    await expect((await session.send('hello')).result).rejects.toThrow();
    await session.close();
    const start = (await messages()).find(m => m.settings);
    await expect(stat(start.args[start.args.indexOf('--settings') + 1])).rejects.toThrow();
  });
  it('freezes a turn speed before later frames change session state', async () => {
    const session = await getProvider('claude').createSession!({ cwd: dir, env: env('claude', { MOCK_SPEED_SEQUENCE: 'fast,standard' }), config: { command, model: 'opus', serviceTier: 'fast' } });
    try {
      const a = await session.send('first');
      const b = await session.send('second');
      const [first] = await Promise.all([a.result, b.result]);
      expect(first.serviceTier?.effective).toBe('fast');
      expect(session.serviceTier?.requested).toBe('fast');
    } finally { await session.close(); }
  });
  it.each(['sonnet', 'claude-opus-4-7', 'claude-opus-4-6', undefined])('rejects an incompatible or implicit model: %s', async model => {
    await expect(getProvider('claude').execute({ cwd: dir, prompt: 'hello', env: env('claude'), config: { command, model, serviceTier: 'fast' } })).rejects.toMatchObject({ code: 'unsupported_model' });
  });
  it.each(['opus', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-8-20260701[1m]'])('recognizes a documented Fast model: %s', model => expect(claudeFastModel(model)).toBe(true));
  it('does not offer Ultrafast', async () => {
    await expect(getProvider('claude').execute({ cwd: dir, prompt: 'hello', env: env('claude'), config: { command, model: 'opus', serviceTier: 'ultrafast' } })).rejects.toMatchObject({ code: 'invalid_tier' });
  });
  it.each([true, false])('preserves %s settings input privately', async file => {
    const settings = { env: { SECRET_TEST_TOKEN: 'keep-private' }, permissions: { deny: ['Bash(rm *)'] } };
    const input = file ? 'input.json' : JSON.stringify(settings);
    if (file) await writeFile(path.join(dir, input), JSON.stringify(settings));
    await getProvider('claude').execute({ cwd: dir, prompt: 'hello', env: env('claude'), config: { command, model: 'opus', serviceTier: 'fast', extraArgs: ['--settings', input, '--verbose'] } });
    const run = (await messages()).find(m => m.settings);
    expect(run.settings).toEqual({ ...settings, fastMode: true });
    expect(run.args.join(' ')).not.toContain('keep-private');
    if (file) expect(JSON.parse(await readFile(path.join(dir, input), 'utf8'))).toEqual(settings);
  });
  it.each([{ fastMode: false }, { fastModePerSessionOptIn: true }])('rejects conflicting settings %j', async settings => {
    await expect(getProvider('claude').execute({ cwd: dir, prompt: 'hello', env: env('claude'), config: { command, model: 'opus', serviceTier: 'fast', extraArgs: ['--settings', JSON.stringify(settings)] } })).rejects.toBeInstanceOf(ServiceTierConfigurationError);
  });
  it('honors disable env and endpoint model alias mapping', async () => {
    for (const extra of [{ CLAUDE_CODE_DISABLE_FAST_MODE: '1' }, { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-5' }]) {
      await expect(getProvider('claude').execute({ cwd: dir, prompt: 'hello', env: env('claude', extra), config: { command, model: 'opus', serviceTier: 'fast' } })).rejects.toBeInstanceOf(ServiceTierConfigurationError);
    }
  });
  it('discovers only Standard/Fast with account availability unknown', async () => {
    const models = await listClaudeModels({ cwd: dir, config: { command }, env: env('claude') });
    expect(models.find(m => m.id === 'opus')?.serviceTiers).toEqual([expect.objectContaining({ id: 'default' }), expect.objectContaining({ id: 'fast', availability: 'unknown' })]);
    expect(models.find(m => m.id === 'sonnet')?.serviceTiers).toHaveLength(1);
  });
  it('reports observed fallback speed independently of the request', async () => {
    const result = await getProvider('claude').execute({ cwd: dir, prompt: 'hello', env: env('claude', { MOCK_SPEED_EFFECTIVE: 'standard' }), config: { command, model: 'opus', serviceTier: 'fast' } });
    expect(result.serviceTier).toMatchObject({ requested: 'fast', selected: null, effective: 'default' });
  });
});

describe('speed observation parsing', () => {
  it('does not infer processing speed from Codex thread settings', () => {
    const events = parseCodexStreamEvent({ method: 'thread/settings/updated', params: { threadId: 't', threadSettings: { serviceTier: 'priority' } } });
    expect(events.find(e => e.type === 'service_tier')).toMatchObject({ update: { selected: 'priority' } });
  });
  it('preserves Claude fallback notices without guessing the billed speed', () => {
    const events = parseClaudeStreamEvent({ type: 'system', subtype: 'notification', message: 'Fast mode disabled · usage credits exhausted' });
    expect(events.find(e => e.type === 'service_tier')).toMatchObject({ update: { effective: null, reason: 'Fast mode disabled · usage credits exhausted' } });
  });
  it('reads actual Claude usage speed from streaming message_start', () => {
    const events = parseClaudeStreamEvent({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg', usage: { speed: 'fast' } } } });
    expect(events.find(e => e.type === 'service_tier')).toMatchObject({ update: { effective: 'fast' } });
  });
});
