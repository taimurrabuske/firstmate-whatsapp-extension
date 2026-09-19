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
