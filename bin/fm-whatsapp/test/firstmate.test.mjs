import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, sha256, delegateState, readJson, writeJson, verifyHomeBinding, epoch } from '../core.mjs';
import { FirstmateAdapter, execute } from '../firstmate.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const key = sha256('own-account\nmessage-id');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wa-adapter-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'firstmate'); fs.mkdirSync(home);
  const state = path.join(base, 'delegate');
  const store = new Store(home, state);
  const codeRoot = process.env.FM_TEST_CODE_ROOT || path.join(base, 'code');
  const options = { home, codeRoot, state: path.join(home, 'state'), store, extensionRoot: root };
  return { base, home, state, store, options };
}
function saveNote(f, body, id = '1000-abcdef', handled = false) {
  const directory = path.join(f.home, 'state/inbox', ...(handled ? ['handled'] : []));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.note`), `id=${id}\nat=2026-01-01\nsource=text\n--\n${body}\n`);
}

test('delegate state defaults outside Firstmate and binds canonical home across all invocations', t => {
  const f = fixture(t);
  const xdg = path.join(f.base, 'xdg');
  const derived = delegateState(f.home, { XDG_STATE_HOME: xdg });
  assert.equal(derived, path.join(xdg, 'firstmate-whatsapp', sha256(fs.realpathSync(f.home)).slice(0, 16)));
  const link = path.join(f.base, 'alias'); fs.symlinkSync(f.home, link);
  assert.equal(delegateState(link, { XDG_STATE_HOME: xdg }), derived);
  assert.equal(delegateState(f.home, { FM_DELEGATE_STATE: f.state }), f.state);
  assert.throws(() => delegateState(f.home, { FM_DELEGATE_STATE: 'relative' }), /absolute/);
  const other = path.join(f.base, 'another-home'); fs.mkdirSync(other);
  assert.throws(() => new Store(other, f.state), /another Firstmate home/);
  assert.throws(() => verifyHomeBinding(f.state, other), /another Firstmate home/);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('existing inbox note - receives exact envelope; repeats and handled recovery never requeue', async t => {
  const f = fixture(t); const calls = [];
  const adapter = new FirstmateAdapter({ ...f.options, run: async (file, args, options) => {
    calls.push({ file, args, options }); saveNote(f, options.input); return 'queued 1000-abcdef\n';
  } });
  const text = '$(touch /tmp/NEVER)\nA quoted reply\n';
  await adapter.note(key, text); await adapter.note(key, text);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].args, ['note', '-']);
  assert.equal(calls[0].file, path.join(f.options.codeRoot, 'bin/fm-inbox.sh'));
  assert.ok(calls[0].options.input.includes(text)); assert.match(calls[0].options.input, /skills\/whatsapp-delegate\/SKILL.md/);
  assert.equal(calls[0].options.env.FM_DELEGATE_STATE, f.state);
  fs.mkdirSync(path.join(f.home, 'state/inbox/handled'));
  fs.renameSync(path.join(f.home, 'state/inbox/1000-abcdef.note'), path.join(f.home, 'state/inbox/handled/1000-abcdef.note'));
  fs.unlinkSync(f.store.file(`handoffs/${key}.json`));
  await adapter.note(key, text); assert.equal(calls.length, 1);
  assert.equal(readJson(f.store.file(`handoffs/${key}.json`)).phase, 'handled');
});

test('saved-but-unannounced recovery only re-rings through the existing wake owner', async t => {
  const f = fixture(t); const calls = [];
  const adapter = new FirstmateAdapter({ ...f.options, run: async (file, args, options) => {
    calls.push({ file, args, options });
    if (file.endsWith('fm-inbox.sh')) { saveNote(f, options.input); throw new Error('wake failed after save'); }
    return '';
  } });
  await adapter.note(key, 'exact text');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].file, '/bin/bash'); assert.equal(calls[1].args[0], '-c');
  assert.equal(calls[1].args.at(-1), '1000-abcdef');
  assert.ok(!calls[1].args[1].includes(f.home)); // Caller values are argv, never interpolated code.
  assert.equal(readJson(f.store.file(`handoffs/${key}.json`)).announced, true);
  await adapter.note(key, 'exact text'); assert.equal(calls.length, 2);
});

test('crash before receipt recovers exact saved body; reused identity refuses differing content', async t => {
  const f = fixture(t); let rings = 0;
  const adapter = new FirstmateAdapter({ ...f.options, run: async () => { rings++; return ''; } });
  saveNote(f, adapter.envelope(key, 'original'));
  await adapter.note(key, 'original'); assert.equal(rings, 1);
  await assert.rejects(adapter.note(key, 'different'), /identity changed/);
  assert.equal(rings, 1);
});

test('ambiguous unsaved publication remains inspectable without retrying a second note', async t => {
  const f = fixture(t); let calls = 0;
  const adapter = new FirstmateAdapter({ ...f.options, run: async () => { calls++; throw new Error('interrupted'); } });
  await assert.rejects(adapter.note(key, 'hello'), /could not be proved/);
  await assert.rejects(adapter.note(key, 'hello'), /uncertain/);
  assert.equal(calls, 1); assert.equal(readJson(f.store.file(`handoffs/${key}.json`)).phase, 'uncertain');
  saveNote(f, adapter.envelope(key, 'hello'));
  const recovered = new FirstmateAdapter({ ...f.options, run: async () => '' });
  await recovered.note(key, 'hello'); assert.equal(readJson(f.store.file(`handoffs/${key}.json`)).phase, 'saved');
});

test('enable requires fresh connection; disable changes extension state only', t => {
  const f = fixture(t);
  const cli = path.join(root, 'bin/fm-whatsapp/cli.mjs');
  const env = { ...process.env, FM_HOME: f.home, FM_DELEGATE_STATE: f.state,
    FM_CODE_ROOT: f.options.codeRoot, FM_STATE_OVERRIDE: path.join(f.home, 'state') };
  let result = spawnSync(process.execPath, [cli, 'enable'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(readJson(f.store.file('enabled.json')), null);
  writeJson(f.store.file('health.json'), { connected: true, updated_epoch: epoch(), account: 'secret-account' });
  result = spawnSync(process.execPath, [cli, 'enable'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(readJson(f.store.file('enabled.json')), { enabled: true });
  result = spawnSync(process.execPath, [cli, 'disable'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(readJson(f.store.file('enabled.json')), { enabled: false });
  assert.deepEqual(fs.readdirSync(f.home), []); assert.ok(!result.stdout.includes('secret-account'));
});

test('explicit progress is durable, transition-checked, and reply is the only final completion API', async t => {
  const f = fixture(t), route = { account: '15555550123@s.whatsapp.net', recipient: '15555550123@s.whatsapp.net' };
  writeJson(f.store.file('identity.json'), { account: route.account, pairedAt: 1 });
  const adapter = new FirstmateAdapter({ ...f.options, run: async () => '' });
  adapter.requests.receive(key, { route, text: 'bounded request' });
  writeJson(f.store.file(`handoffs/${key}.json`), { id: 'note-1', phase: 'saved', route,
    binding: { home: fs.realpathSync(f.home), codeRoot: path.resolve(f.options.codeRoot), state: path.resolve(f.options.state) } });
  assert.equal(adapter.progress(key, 'working', 'Running recorded checks.').state, 'working');
  assert.throws(() => adapter.progress(key, 'received'), /use reply/);
  assert.equal(adapter.progress(key, 'picked-up', 'Owner explicitly resumed it.').state, 'picked-up');
  adapter.reply(key, 'Checks passed.');
  assert.equal(adapter.requests.get(key).state, 'completed');
  assert.throws(() => adapter.progress(key, 'waiting'), /invalid request transition/);
  assert.equal(f.store.records('outbox').length, 3);
});

test('maintenance only re-rings an existing stale note with a strict bound and records handled evidence', async t => {
  const f = fixture(t), calls = [], route = { account: '15555550123@s.whatsapp.net', recipient: '15555550123@s.whatsapp.net' };
  writeJson(f.store.file('identity.json'), { account: route.account, pairedAt: 1 });
  const adapter = new FirstmateAdapter({ ...f.options, run: async (file, args) => { calls.push({ file, args }); return ''; } });
  adapter.requests.receive(key, { route, text: 'do not duplicate' });
  const body = adapter.envelope(key, 'do not duplicate'); saveNote(f, body, 'note-1');
  writeJson(f.store.file(`handoffs/${key}.json`), { id: 'note-1', body, phase: 'saved', route, created: 1,
    binding: { home: fs.realpathSync(f.home), codeRoot: path.resolve(f.options.codeRoot), state: path.resolve(f.options.state) },
    maintenance: { rings: 0, last: 0 } });
  const foreignKey = 'f'.repeat(64);
  writeJson(f.store.file(`handoffs/${foreignKey}.json`), { id: 'telegram-note', body: 'foreign', phase: 'saved',
    route: { account: route.account, recipient: 'telegram-recipient' }, created: 1, maintenance: { rings: 0, last: 0 } });
  await adapter.maintain({ now: 1000, staleAfter: 10, maxRings: 1 });
  assert.equal(calls.length, 1); assert.equal(calls[0].file, '/bin/bash');
  assert.equal(readJson(f.store.file(`handoffs/${foreignKey}.json`)).maintenance.rings, 0);
  const report = await adapter.maintain({ now: 2000, staleAfter: 10, maxRings: 1 });
  assert.equal(calls.length, 1); assert.equal(report[0].evidence, 'controller has not acknowledged; watcher beacon is unavailable');
  assert.match(report[0].dedupeId, /^maintenance:/);
  adapter.notifyMaintenance(report[0]); adapter.notifyMaintenance(report[0]);
  assert.equal(f.store.records('outbox').length, 1);
  fs.mkdirSync(path.join(f.home, 'state/inbox/handled'));
  fs.renameSync(path.join(f.home, 'state/inbox/note-1.note'), path.join(f.home, 'state/inbox/handled/note-1.note'));
  await adapter.maintain({ now: 3000, staleAfter: 10, maxRings: 1 });
  assert.equal(adapter.requests.get(key).state, 'waiting'); // Inbox handling is not evidence that stalled work resumed.
});

test('read-only decision helper works without AFK or extension enablement', t => {
  const f = fixture(t), code = path.join(f.base, 'decision-code'), bin = path.join(code, 'bin');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(f.options.state, { recursive: true });
  fs.writeFileSync(path.join(f.options.state, 'worker.meta'), 'kind=worker\n');
  fs.writeFileSync(path.join(f.options.state, 'worker.status'), 'opaque fixture\n');
  fs.writeFileSync(path.join(bin, 'fm-afk-contract.sh'), "status_open_decisions() { printf 'gate\\tneeds-decision\\tChoose safely\\n'; }\n");
  const result = spawnSync(path.join(root, 'bin/fm-whatsapp-decisions.sh'), ['--json'], { encoding: 'utf8',
    env: { ...process.env, FM_HOME: f.home, FM_CODE_ROOT: code, FM_STATE_OVERRIDE: f.options.state } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).decisions, [{ task: 'worker', key: 'gate', text: 'Choose safely' }]);
});

test('decision summary uses AFK-independent recorded decision reader', async t => {
  const f = fixture(t), route = { account: '15555550123@s.whatsapp.net', recipient: '15555550123@s.whatsapp.net' };
  writeJson(f.store.file('identity.json'), { account: route.account, pairedAt: 1 });
  const calls = [];
  const adapter = new FirstmateAdapter({ ...f.options, run: async file => { calls.push(file);
    return JSON.stringify({ schema: 'fm-whatsapp-decisions.v1', decisions: [{ task: 'build', key: 'gate', text: 'Choose safely' }] });
  } });
  assert.match(await adapter.summary('decisions'), /build\/gate/);
  assert.ok(calls[0].endsWith('fm-whatsapp-decisions.sh'));
  assert.ok(!calls[0].endsWith('fm-whatsapp-events.sh'));
});

test('watcher diagnosis uses beacon evidence and otherwise reports unknown', t => {
  const f = fixture(t), adapter = new FirstmateAdapter({ ...f.options, run: async () => '' });
  assert.equal(adapter.watcherEvidence(1000, 300).code, 'watcher-unknown');
  const beat = path.join(f.options.state, '.last-watcher-beat'); fs.mkdirSync(f.options.state, { recursive: true });
  fs.writeFileSync(beat, ''); fs.utimesSync(beat, 100, 100);
  assert.equal(adapter.watcherEvidence(1000, 300).code, 'watcher-stale');
  fs.utimesSync(beat, 900, 900);
  assert.equal(adapter.watcherEvidence(1000, 300).code, 'unacknowledged');
});

test('request summaries preserve query and complete content across route-bound pages', t => {
  const f = fixture(t), route = { account: '15555550123@s.whatsapp.net', recipient: '15555550123@s.whatsapp.net', provenance: 'whatsapp' };
  writeJson(f.store.file('identity.json'), { account: route.account, pairedAt: 1 });
  const adapter = new FirstmateAdapter({ ...f.options, run: async () => '' });
  const marker = 'FINAL-END-MARKER';
  for (let i = 0; i < 6; i++) adapter.requests.receive(sha256(`request-${i}`), { route, text: `request ${i} ${'x'.repeat(900)}` });
  const done = sha256('request-0'); adapter.requests.transition(done, 'working', 'checking');
  adapter.requests.transition(done, 'completed', `${'z'.repeat(3400 - marker.length)}${marker}`);
  let page = adapter.requests.summarize('pending', route), combined = page;
  assert.ok(page.length <= 3500); assert.ok(!page.includes('lifecycle state: completed'));
  while (page.includes('Send more')) { page = adapter.requests.summarize('more', route); assert.ok(page.length <= 3500); combined += page; }
  assert.ok(!combined.includes(marker)); // The pending cursor never resets to all records.
  page = adapter.requests.summarize('last result', route); combined = page;
  while (page.includes('Send more')) { page = adapter.requests.summarize('more', route); combined += page; }
  assert.ok(combined.includes(marker));
  const other = { ...route, credentialFingerprint: 'other-credential' };
  assert.match(adapter.requests.summarize('more', other), /No additional/);
});

test('existing real Firstmate inbox integration in an isolated home', { skip: !process.env.FM_TEST_CODE_ROOT }, async t => {
  const f = fixture(t); const calls = [];
  const adapter = new FirstmateAdapter({ ...f.options, run: async (...args) => { calls.push(args[0]); return execute(...args); } });
  await adapter.note(key, 'A real isolated inbox note, not a live captain message.');
  await adapter.note(key, 'A real isolated inbox note, not a live captain message.');
  assert.equal(calls.filter(file => file.endsWith('fm-inbox.sh')).length, 1);
  const notes = fs.readdirSync(path.join(f.home, 'state/inbox')).filter(file => file.endsWith('.note'));
  assert.equal(notes.length, 1);
  const output = await adapter.status(); assert.match(output, /history, not current state/);
  const id = notes[0].slice(0, -5);
  await execute(path.join(f.options.codeRoot, 'bin/fm-inbox.sh'), ['drain', '--ack', id], { env: adapter.env });
  fs.unlinkSync(f.store.file(`handoffs/${key}.json`));
  await adapter.note(key, 'A real isolated inbox note, not a live captain message.');
  assert.equal(readJson(f.store.file(`handoffs/${key}.json`)).phase, 'handled');
});

test('recipient configuration requires an idle bridge and empty queues; never changes Firstmate', t => {
  const f = fixture(t);
  const cli = path.join(root, 'bin/fm-whatsapp/cli.mjs');
  const run = value => spawnSync(process.execPath, [cli, 'recipient', value], { encoding: 'utf8',
    env: { ...process.env, FM_HOME: f.home, FM_DELEGATE_STATE: f.state } });
  assert.equal(run('+15555550999').status, 0);
  assert.deepEqual(readJson(f.store.file('recipient.json')), { account: '15555550999@s.whatsapp.net' });
  assert.equal(run('not-a-phone').status, 1);
  const unlock = f.store.lock();
  assert.equal(run('self').status, 1); unlock();
  f.store.enqueue('pending message', { kind: 'reply', session: '' });
  assert.equal(run('self').status, 1);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('request-bound reply queues outside AFK, repeats safely, and cannot target another route or home', async t => {
  const f = fixture(t);
  const route = { account: '15555550123@s.whatsapp.net', recipient: '15555550999@s.whatsapp.net' };
  writeJson(f.store.file('identity.json'), { account: route.account, pairedAt: 1000 });
  writeJson(f.store.file('recipient.json'), { account: route.recipient });
  writeJson(f.store.file(`pending/${key}.json`), { operation: 'note', route });
  const adapter = new FirstmateAdapter({ ...f.options, run: async (_file, _args, options) => {
    saveNote(f, options.input); return 'queued 1000-abcdef\n';
  } });
  await adapter.note(key, 'Please answer');
  f.store.markIncoming(key, epoch(), { operation: 'note', route });
  fs.unlinkSync(f.store.file(`pending/${key}.json`));
  const receipt = readJson(f.store.file(`handoffs/${key}.json`));
  assert.deepEqual(receipt.route, route);
  assert.match(receipt.body, /"arguments":\["reply","[a-f0-9]{64}"\]/);
  const cli = path.join(root, 'bin/fm-whatsapp/cli.mjs');
  const env = { ...process.env, FM_HOME: f.home, FM_DELEGATE_STATE: f.state,
    FM_CODE_ROOT: f.options.codeRoot, FM_STATE_OVERRIDE: f.options.state };
  const respond = (args = ['reply', key], extraEnv = {}) => spawnSync(process.execPath, [cli, ...args],
    { env: { ...env, ...extraEnv }, input: 'The result is ready.\n', encoding: 'utf8' });
  assert.equal(respond().status, 0);
  assert.equal(respond().status, 0);
  assert.equal(f.store.records('outbox').length, 1);
  f.store.pruneIncoming(epoch() + 86401);
  assert.equal(f.store.incoming(key), null);
  assert.equal(respond().status, 0); // Durable handoff permits the result of long work.
  const job = readJson(f.store.file(`outbox/${f.store.records('outbox')[0]}`));
  assert.equal(job.kind, 'reply'); assert.equal(job.session, ''); assert.equal(job.requestKey, key);
  assert.deepEqual(job.route, route);
  assert.equal(respond(['reply', '../escape']).status, 1);
  assert.equal(respond(['reply', 'a'.repeat(64)]).status, 1);
  assert.equal(respond(['reply', key], { FM_STATE_OVERRIDE: path.join(f.home, 'different-state') }).status, 1);
  assert.equal(respond(['reply', key], { FM_CODE_ROOT: path.join(f.base, 'different-code') }).status, 1);
  writeJson(f.store.file('recipient.json'), { account: '15555550888@s.whatsapp.net' });
  assert.equal(respond().status, 1);
  writeJson(f.store.file('recipient.json'), { account: route.recipient });
  receipt.phase = 'uncertain'; writeJson(f.store.file(`handoffs/${key}.json`), receipt);
  assert.equal(respond().status, 1);
  assert.equal(f.store.records('outbox').length, 1);
  assert.equal(readJson(f.store.file('enabled.json')), null);
  assert.ok(!fs.existsSync(path.join(f.home, 'state/afk-contract.md')));
});
