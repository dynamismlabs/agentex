#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const claude = process.env.MOCK_SPEED_PROVIDER === 'claude';
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const log = value => { if (process.env.MOCK_SPEED_LOG) appendFileSync(process.env.MOCK_SPEED_LOG, JSON.stringify(value) + '\n'); };
const valueOf = flag => args[args.lastIndexOf(flag) + 1];
const tierArg = args.find(arg => arg.startsWith('service_tier='));
const tier = tierArg ? JSON.parse(tierArg.slice(13)) : 'default';
let turnCount = 0;
if (args.includes('--version')) { console.log(process.env.MOCK_SPEED_VERSION || (claude ? '2.1.305 (Claude Code)' : 'codex-cli 0.163.0')); process.exit(); }
if (args.includes('--help')) { console.log('--bare\n  --effort <level> (low, medium, high)'); process.exit(); }
if (args.includes('features')) { console.log(`fast_mode stable ${process.env.MOCK_SPEED_DISABLED !== '1'}\nultrafast_mode stable true`); process.exit(); }
const tiers = process.env.MOCK_SPEED_TIERS === 'missing' ? undefined : JSON.parse(process.env.MOCK_SPEED_TIERS || '[{"id":"priority","name":"Fast"},{"id":"ultrafast","name":"Ultrafast"}]');
const model = { id: 'gpt-test', model: 'gpt-test', isDefault: true, serviceTiers: tiers };
if (args.includes('models')) { log({ args }); write({ models: [{ slug: 'gpt-test', display_name: 'Test', visibility: 'list', service_tiers: tiers }] }); process.exit(); }
if (claude && args.includes('-p') && valueOf('-p') === '') { console.error('Input must be provided'); process.exit(1); }
let settings;
if (claude && args.includes('--settings')) settings = JSON.parse(readFileSync(valueOf('--settings'), 'utf8'));
log({ args, settings, pid: process.pid, cwd: process.cwd() });
const emitClaude = () => {
  if (process.env.MOCK_SPEED_EXIT === '1') process.exit(1);
  if (process.env.MOCK_SPEED_HANG === '1') return;
  const effective = process.env.MOCK_SPEED_SEQUENCE?.split(',')[turnCount++] ?? process.env.MOCK_SPEED_EFFECTIVE;
  write({ type: 'system', subtype: 'init', session_id: 'speed-claude', model: 'claude-opus-5-5' });
  if (process.env.MOCK_SPEED_NOTICE) write({ type: 'system', subtype: 'notification', session_id: 'speed-claude', message: process.env.MOCK_SPEED_NOTICE });
  const usage = { input_tokens: 1, output_tokens: 1, ...(effective ? { speed: effective } : {}) };
  write({ type: 'assistant', session_id: 'speed-claude', message: { content: [{ type: 'text', text: 'Done' }], usage } });
  write({ type: 'result', subtype: 'success', session_id: 'speed-claude', result: 'Done', is_error: false, usage });
};
if (claude && !args.includes('--input-format')) { process.stdin.resume(); process.stdin.on('end', emitClaude); }
else if (!claude && args.includes('exec')) {
  process.stdin.resume(); process.stdin.on('end', () => {
    write({ type: 'thread.started', thread_id: 'speed-codex' });
    write({ type: 'item.completed', item: { id: 'item', type: 'agent_message', text: 'Done' } });
    write({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  });
} else {
  createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line); log(msg);
    if (claude) {
      if (msg.type === 'control_request') write({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success', response: {} } });
      else if (msg.type === 'user') emitClaude();
      return;
    }
    const p = msg.params || {};
    if (process.env.MOCK_SPEED_IGNORE_RPC === msg.method) return;
    let result = {};
    if (msg.method === 'config/read') result = { config: { model: 'gpt-test', features: { fast_mode: process.env.MOCK_SPEED_DISABLED !== '1' } } };
    if (msg.method === 'model/list') result = { data: [model], nextCursor: null };
    if (msg.method === 'thread/start' || msg.method === 'thread/resume') result = {
      thread: { id: p.threadId || 'speed-codex' }, model: p.model || 'gpt-test',
      cwd: process.env.MOCK_SPEED_WRONG_CWD || p.cwd || process.env.MOCK_SPEED_SAVED_CWD || process.cwd(),
      serviceTier: process.env.MOCK_SPEED_SELECTED || p.serviceTier || (msg.method === 'thread/resume' ? 'ultrafast' : tier),
    };
    if (msg.method === 'thread/resume' && process.env.MOCK_SPEED_RESUME_ERROR) { write({ id: msg.id, error: { code: -32600, message: process.env.MOCK_SPEED_RESUME_ERROR } }); return; }
    if (msg.method === 'turn/start') result = { turn: { id: 'turn-speed' } };
    write({ id: msg.id, result });
    if (msg.method === 'thread/resume' && process.env.MOCK_SPEED_USAGE === '1') {
      write({ method: 'thread/tokenUsage/updated', params: { threadId: p.threadId, turnId: 'previous-turn', tokenUsage: { total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 70 }, last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 70 } } } });
    }
    if (msg.method === 'turn/start') setTimeout(() => {
      if (process.env.MOCK_SPEED_EXIT === '1') process.exit(1);
      if (process.env.MOCK_SPEED_HANG === '1') return;
      write({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: 'turn-speed' } } });
      if (process.env.MOCK_SPEED_USAGE === '1') {
        const old = p.threadId === 'saved-speed' ? 10 : 0;
        for (const [input, output, cached] of [[10, 2, 7], [10, 2, 7], [25, 5, 15]]) {
          write({ method: 'thread/tokenUsage/updated', params: { threadId: p.threadId, turnId: 'turn-speed', tokenUsage: { total: { inputTokens: old * 10 + input, outputTokens: old * 2 + output, cachedInputTokens: old * 7 + cached }, last: { inputTokens: input === 10 ? 10 : 15, outputTokens: input === 10 ? 2 : 3, cachedInputTokens: input === 10 ? 7 : 8 } } } });
        }
        write({ method: 'thread/tokenUsage/updated', params: { threadId: 'child-thread', turnId: 'child-turn', tokenUsage: { total: { inputTokens: 999, outputTokens: 999 }, last: { inputTokens: 999, outputTokens: 999 } } } });
      }
      write({ method: 'item/completed', params: { threadId: p.threadId, turnId: 'turn-speed', item: { id: 'item-speed', type: 'agentMessage', text: 'Done' } } });
      write({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: 'turn-speed', status: 'completed' } } });
    }, 10);
  });
}
