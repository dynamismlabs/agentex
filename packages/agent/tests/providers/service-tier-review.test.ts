import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getProvider } from '../../src/index.js';
import { listClaudeModels } from '../../src/providers/claude/discovery.js';
import { clearModelCache, withModelCache } from '../../src/utils/model-cache.js';

const command = path.resolve(import.meta.dirname, '../fixtures/mock-service-tier.mjs');
let dir: string;
let log: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'agentex-speed-review-')); log = path.join(dir, 'wire.jsonl'); clearModelCache(); });
afterEach(async () => { clearModelCache(); await rm(dir, { recursive: true, force: true }); });
const env = (provider: string, extra: Record<string, string> = {}) => ({ MOCK_SPEED_PROVIDER: provider, MOCK_SPEED_LOG: log, ...extra });
const messages = async (): Promise<any[]> => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

describe('speed integration review regressions', () => {
  it.each([false, true])('combines explicit speed with process-scoped skills and exec permissions; resume=%s', async resume => {
    const skillDir = path.join(dir, 'test-skill'); await mkdir(skillDir);
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: test-skill\ndescription: Test skill\n---\n');
    const result = await getProvider('codex').execute({ cwd: dir, prompt: 'hello', env: env('codex'),
      ...(resume ? { sessionParams: { sessionId: 'saved-speed', cwd: dir } } : {}),
      config: { command, serviceTier: 'fast', skillDirs: [skillDir] } });
    expect(result.status).toBe('completed');
    expect(result.serviceTier?.selected).toBe('priority');
    const wire = await messages();
    const skillsIndex = wire.findIndex(row => row.method === 'skills/extraRoots/set');
    const threadIndex = wire.findIndex(row => row.method === (resume ? 'thread/resume' : 'thread/start'));
    expect(skillsIndex).toBeGreaterThan(-1); expect(threadIndex).toBeGreaterThan(skillsIndex);
    expect(wire[threadIndex].params.approvalPolicy).toBe('never');
    await expect(access(wire[skillsIndex].params.extraRoots[0])).rejects.toThrow();
    await expect(access(path.join(dir, '.agents'))).rejects.toThrow();
  });
  it('preserves the execute cross-directory resume guard', async () => {
    const saved = path.join(dir, 'old'); await mkdir(saved);
    const result = await getProvider('codex').execute({ cwd: dir, prompt: 'hello', sessionParams: { sessionId: 'saved-speed', cwd: saved },
      env: env('codex', { MOCK_SPEED_SAVED_CWD: saved }), config: { command, serviceTier: 'default' } });
    expect(result.status).toBe('completed');
    expect((await messages()).some(row => row.method === 'thread/resume')).toBe(false);
    expect(result.clearSession).toBe(true);
    expect(result.sessionParams?.cwd).toBe(dir);
  });
  it('explicitly selects and verifies cwd when resuming a typed session', async () => {
    const session = await getProvider('codex').createSession!({ cwd: dir, sessionParams: { sessionId: 'saved-speed', cwd: '/old' },
      env: env('codex', { MOCK_SPEED_SAVED_CWD: '/old' }), config: { command, serviceTier: 'default' } });
    try { expect((await messages()).find(row => row.method === 'thread/resume').params.cwd).toBe(dir); }
    finally { await session.close(); }
    let unexpected: typeof session | undefined;
    try {
      await expect(getProvider('codex').createSession!({ cwd: dir, sessionParams: { sessionId: 'saved-speed', cwd: dir },
        env: env('codex', { MOCK_SPEED_WRONG_CWD: '/wrong' }), config: { command, serviceTier: 'default' } }).then(value => { unexpected = value; return value; })).rejects.toThrow(/working directory/i);
    } finally { await unexpected?.close(); }
  });
  for (const method of ['initialize', 'thread/start', 'thread/resume', 'model/list']) {
    for (const kind of ['timeout', 'aborted']) it(`closes a process stuck in ${method} on ${kind}`, async () => {
      let pid: number | undefined;
      const controller = new AbortController();
      let cancel: ReturnType<typeof setTimeout> | undefined;
      const execution = getProvider('codex').execute({ cwd: dir, prompt: 'hello', env: env('codex', { MOCK_SPEED_IGNORE_RPC: method }),
        ...(method === 'thread/resume' ? { sessionParams: { sessionId: 'saved-speed', cwd: dir } } : {}),
        signal: controller.signal, onStart: value => { pid = value; if (kind === 'aborted') cancel = setTimeout(() => controller.abort(), 100); },
        config: { command, serviceTier: method === 'model/list' ? 'fast' : 'default', timeoutSec: kind === 'timeout' ? 0.3 : 10, graceSec: 0.1 } });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([execution, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Initialization remained pending')), 1500); })]);
        expect(result.status).toBe(kind);
        expect(pid).toBeTypeOf('number');
        expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        clearTimeout(deadline); clearTimeout(cancel);
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        controller.abort();
        await execution.catch(() => {});
      }
    });
  }
  it.each([false, true])('retains native usage and cached tokens with custom CODEX_HOME; resume=%s', async resume => {
    const home = path.join(dir, 'codex'); await mkdir(home);
    const result = await getProvider('codex').execute({ cwd: dir, prompt: 'hello', env: env('codex', { CODEX_HOME: home, MOCK_SPEED_USAGE: '1' }),
      ...(resume ? { sessionParams: { sessionId: 'saved-speed', cwd: dir } } : {}), config: { command, serviceTier: 'default' } });
    expect(result.usage).toEqual({ 'gpt-test': { inputTokens: 25, outputTokens: 5, cachedInputTokens: 15 } });
  });
  it.each(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL'])('marks %s Fast unavailable and rejects it before inference', async route => {
    const context = { cwd: dir, env: env('claude', { [route]: '1' }), config: { command, model: 'opus', serviceTier: 'fast' } };
    const models = await listClaudeModels(context);
    expect(models.find(model => model.id === 'opus')?.serviceTiers?.find(tier => tier.id === 'fast')).toMatchObject({ availability: 'unavailable' });
    await expect(getProvider('claude').execute({ ...context, prompt: 'hello' })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await messages()).some(row => row.settings)).toBe(false);
  });
  it('uses effective endpoint routing and checks settings-supplied routing', async () => {
    const config = { command, model: 'opus', serviceTier: 'fast', endpoint: { baseUrl: 'http://localhost:9999', apiKey: 'test-only' } };
    const context = { cwd: dir, env: env('claude', { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CODE_USE_ANTHROPIC_AWS: '1', ANTHROPIC_BEDROCK_MANTLE_BASE_URL: 'http://localhost:1' }), config };
    expect((await listClaudeModels(context)).find(model => model.id === 'opus')?.serviceTiers?.find(tier => tier.id === 'fast')?.availability).toBe('unknown');
    expect((await getProvider('claude').execute({ ...context, prompt: 'hello' })).status).toBe('completed');
    await expect(getProvider('claude').execute({ ...context, prompt: 'hello', config: { ...config, extraArgs: ['--settings', '{"env":{"CLAUDE_CODE_USE_VERTEX":"1"}}'] } })).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('accepts opus[1m] and validates its resolved alias', async () => {
    const context = { cwd: dir, prompt: 'hello', env: env('claude'), config: { command, model: 'opus[1m]', serviceTier: 'fast' } };
    expect((await getProvider('claude').execute(context)).status).toBe('completed');
    await expect(getProvider('claude').execute({ ...context, env: env('claude', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-5' }) })).rejects.toMatchObject({ code: 'unsupported_model' });
    expect((await getProvider('claude').execute({ ...context, config: { ...context.config, endpoint: { modelMap: { opus: 'claude-opus-5-5[1m]' } } } })).status).toBe('completed');
  });
  it.each(['claude', 'codex'])('invalidates cached discovery when %s credentials change in place', async provider => {
    const authFile = path.join(dir, provider === 'codex' ? 'auth.json' : '.credentials.json');
    const identity = { cwd: dir, env: { HOME: dir, [provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: dir } };
    let loads = 0;
    const query = () => withModelCache(provider, identity, 60_000, async () => ++loads);
    expect(await query()).toBe(1); expect(await query()).toBe(1);
    await writeFile(authFile, 'account-A'); expect(await query()).toBe(2);
    await writeFile(authFile, 'account-BB'); expect(await query()).toBe(3);
    // Logout returns to the still-fresh anonymous identity, never account B.
    await rm(authFile); expect(await query()).toBe(1);
  });
});
