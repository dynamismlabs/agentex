/** Real CLI protocol smoke against a local fake API. No paid inference.
 * Run: pnpm exec tsx scripts/smoke-service-tiers.ts
 * Requires Codex 0.163+ and Claude Code 2.1.205+ on this machine. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getProvider } from '../src/index.js';
import { findBinary } from '../src/utils/binary.js';

const dir = await mkdtemp(join(tmpdir(), 'agentex-speed-native-'));
const requests: Array<{ path: string; body: Record<string, any> }> = [];
let sequence = 0;
const server = createServer(async (req, res) => {
  let input = '';
  for await (const chunk of req) input += chunk;
  let body: Record<string, any>;
  try { body = JSON.parse(input || '{}'); } catch { res.writeHead(400).end(); return; }
  const url = req.url ?? '';
  requests.push({ path: url, body });
  if (url.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return; }
  res.setHeader('content-type', 'text/event-stream');
  const send = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  if (url.includes('/responses')) {
    const id = `resp_speed_${++sequence}`;
    const item = { id: `msg_${sequence}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'SPEED_OK', annotations: [] }] };
    send('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', { response: { id, object: 'response', status: 'completed', model: body.model, output: [item], service_tier: body.service_tier ?? 'default', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 7 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  } else if (url.includes('/messages')) {
    const speed = body.speed === 'fast' ? 'fast' : 'standard';
    send('message_start', { message: { id: `msg_speed_${++sequence}`, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'SPEED_OK' } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2, speed } });
    send('message_stop', {});
  } else { res.end('{}'); return; }
  res.end();
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
try {
  // A disposable repository permits both native exec and isolated worktrees.
  const exec = promisify(execFile);
  await exec('git', ['init', '-b', 'main', dir]);
  await exec('git', ['-c', 'user.name=Agent Ex Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '--allow-empty', '-m', 'Temporary smoke fixture'], { cwd: dir });
  const codex = await findBinary('codex');
  const catalogResult = await promisify(execFile)(codex.bin, [...codex.prefixArgs, 'debug', 'models', '--bundled'], { maxBuffer: 8 * 1024 * 1024 });
  const catalog = JSON.parse(catalogResult.stdout);
  const chosen = catalog.models.find((model: any) => model.slug === 'gpt-6.1-sol') ?? catalog.models.find((model: any) => model.visibility === 'list');
  assert(chosen, 'Codex has no bundled model to test');
  chosen.service_tiers = [{ id: 'priority', name: 'Fast', description: 'Local test' }, { id: 'ultrafast', name: 'Ultrafast', description: 'Local test' }];
  const catalogPath = join(dir, 'models.json');
  await writeFile(catalogPath, JSON.stringify({ ...catalog, models: [chosen] }));
  const codexHome = join(dir, 'codex'); await mkdir(codexHome);
  const skillDir = join(dir, 'smoke-skill'); await mkdir(skillDir);
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: smoke-skill\ndescription: Local protocol smoke skill\n---\nReply SPEED_OK.\n');
  const codexConfig = { model: chosen.slug, endpoint: { baseUrl, apiKey: 'local-test-only' }, timeoutSec: 20,
    extraArgs: ['-c', `model_catalog_json=${JSON.stringify(catalogPath)}`, '-c', 'features.apps=false', '-c', 'features.hooks=false', '-c', 'model_providers.custom.supports_websockets=false'] };
  const expectedUsage = { [chosen.slug]: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 7 } };
  const legacy = await getProvider('codex').execute({ prompt: 'Reply SPEED_OK', cwd: dir, env: { CODEX_HOME: codexHome }, config: codexConfig });
  assert.equal(legacy.status, 'completed', legacy.errorMessage ?? undefined);
  assert.deepEqual(legacy.usage, expectedUsage);
  console.log('PASS real Codex omitted tier: native exec usage baseline');
  let params: Record<string, unknown> | null = null;
  for (const tier of ['fast', 'default', 'ultrafast']) {
    const before = requests.length;
    const result = await getProvider('codex').execute({ prompt: 'Reply SPEED_OK', cwd: dir, env: { CODEX_HOME: codexHome }, config: { ...codexConfig, serviceTier: tier, skillDirs: [skillDir] }, sessionParams: params });
    assert.equal(result.status, 'completed', result.errorMessage ?? undefined);
    assert.deepEqual(result.usage, expectedUsage, 'Each turn must report its own input, output, and cached tokens');
    const inference = requests.slice(before).filter(request => request.path.includes('/responses'));
    assert(inference.length > 0, 'Codex made no request to the local API');
    for (const request of inference) assert.equal(request.body.service_tier, tier === 'default' ? undefined : tier === 'fast' ? 'priority' : tier);
    if (params) assert.equal(result.sessionParams?.sessionId, params.sessionId, 'Resume must preserve thread identity');
    params = result.sessionParams;
    console.log(`PASS real Codex ${tier} with scoped skills: request service_tier, thread identity, and per-turn usage`);
  }
  for (const worktree of [false, true]) {
    const changedCwd = join(dir, worktree ? 'isolated' : 'other');
    if (!worktree) await mkdir(changedCwd);
    let wire = '';
    const result = await getProvider('codex').execute({ prompt: 'Reply SPEED_OK', cwd: worktree ? dir : changedCwd,
      env: { CODEX_HOME: codexHome }, sessionParams: params, onOutput: (stream, chunk) => { if (stream === 'stdout') wire += chunk; },
      config: { ...codexConfig, serviceTier: 'default', ...(worktree ? { workspace: { strategy: 'worktree' as const, targetDir: changedCwd } } : {}) } });
    try {
      assert.equal(result.status, 'completed', result.errorMessage ?? undefined);
      assert.equal(result.clearSession, true);
      assert.notEqual(result.sessionParams?.sessionId, params?.sessionId);
      assert.equal(await realpath(result.sessionParams?.cwd as string), await realpath(changedCwd));
      const selectedCwd = wire.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(row => row.result?.cwd)?.result.cwd;
      assert.equal(await realpath(selectedCwd), await realpath(changedCwd), 'Native thread must select the prepared directory');
      assert.deepEqual(result.usage, expectedUsage);
      console.log(`PASS real Codex ${worktree ? 'worktree' : 'changed cwd'}: fresh thread, native cwd, and usage`);
    } finally { await result.workspace?.cleanup({ deleteBranch: true }); }
  }
  const resumed = await getProvider('codex').createSession!({ cwd: join(dir, 'other'), env: { CODEX_HOME: codexHome }, sessionParams: params,
    config: { ...codexConfig, serviceTier: 'default' } });
  try {
    assert.equal(resumed.sessionId, params?.sessionId);
    for (let i = 0; i < 2; i++) {
      const result = await (await resumed.send('Reply SPEED_OK')).result;
      assert.equal(result.status, 'completed', result.errorMessage ?? undefined);
      assert.deepEqual(result.usage, expectedUsage);
    }
    console.log('PASS real Codex direct session resume: cwd override and repeated-turn usage');
  } finally { await resumed.close(); }
  const claudeHome = join(dir, 'claude'); await mkdir(claudeHome);
  for (const transport of ['execute', 'session']) {
    let saved: Record<string, unknown> | null = null;
    for (const tier of ['fast', 'default']) {
      const before = requests.length;
      const context = { cwd: dir, sessionParams: saved,
        env: { CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1' },
        config: { model: 'opus[1m]', serviceTier: tier, endpoint: { baseUrl: baseUrl.replace(/\/v1$/, ''), apiKey: 'local-test-only', modelMap: { opus: 'claude-opus-5-5' } }, timeoutSec: 20,
          extraArgs: ['--bare', '--setting-sources', '', '--strict-mcp-config', '--tools', ''] } };
      if (transport === 'execute') {
        const result = await getProvider('claude').execute({ ...context, prompt: 'Reply SPEED_OK' });
        assert.equal(result.status, 'completed', result.errorMessage ?? undefined);
        assert.equal(result.serviceTier?.effective, tier === 'fast' ? 'fast' : 'default');
        if (saved) assert.equal(result.sessionParams?.sessionId, saved.sessionId);
        assert(result.sessionParams?.sessionId, 'Claude must return a resumable session id');
        saved = result.sessionParams;
      } else {
        const session = await getProvider('claude').createSession!(context);
        try {
          const result = await (await session.send('Reply SPEED_OK')).result;
          assert.equal(result.status, 'completed', result.errorMessage ?? undefined);
          assert.equal(result.serviceTier?.effective, tier === 'fast' ? 'fast' : 'default');
          if (saved) assert.equal(session.sessionId, saved.sessionId);
          assert(session.sessionId, 'Claude must return a resumable session id');
          saved = { sessionId: session.sessionId };
        } finally { await session.close(); }
      }
      const inference = requests.slice(before).filter(request => request.path.includes('/messages') && !request.path.includes('count_tokens'));
      assert(inference.length > 0, 'Claude made no request to the local API');
      for (const request of inference) assert.equal(request.body.speed ?? 'standard', tier === 'fast' ? 'fast' : 'standard');
      console.log(`PASS real Claude ${transport} ${tier}: request speed, usage.speed, and thread identity`);
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
