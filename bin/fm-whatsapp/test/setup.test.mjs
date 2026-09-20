import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, epoch, writeJson } from '../core.mjs';
import { doctorReport } from '../cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'bin/fm-whatsapp/cli.mjs');
const wrapper = path.join(root, 'bin/fm-whatsapp.sh');
const identity = { account: '15555550123@s.whatsapp.net', pairedAt: 1000 };
const peerAccount = '15555550999@s.whatsapp.net';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-setup-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const codeRoot = path.join(base, 'firstmate');
  fs.mkdirSync(path.join(codeRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(codeRoot, 'bin/fm-afk-contract.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const state = path.join(base, 'delegate-state');
  const env = { FM_HOME: home, FM_CODE_ROOT: codeRoot, FM_DELEGATE_STATE: state,
    XDG_STATE_HOME: path.join(base, 'xdg') };
  const report = (overrides = {}) => doctorReport({ home, env: { ...env, ...(overrides.env ?? {}) },
    extensionRoot: root,
    // Dependency probes depend on the local machine, not the scenario under
    // test; lock liveness stays real so stale and live locks are exercised.
    transportReady: true, jqReady: true, ...(overrides.probes ?? {}) });
  return { base, home, codeRoot, state, env, report };
}

function paired(t) {
  const fx = fixture(t);
  const store = new Store(fx.home, fx.state);
  writeJson(store.file('identity.json'), identity);
  writeJson(store.file('recipient.json'), { account: peerAccount });
  writeJson(store.file('health.json'), { connected: true, updated_epoch: epoch(), account: peerAccount, problem: '', queued: 0, pending: 0, uncertain: 0 });
  writeJson(store.file('enabled.json'), { enabled: true });
  return { fx, store };
}

test('fresh unpaired installation reports ready with setup notes only', t => {
  const { report } = fixture(t);
  const result = report();
  assert.equal(result.ready, true);
  assert.ok(result.lines.every(line => !line.startsWith('problem:')));
  assert.ok(result.lines.some(line => line.includes('does not exist yet; pair creates it')));
  assert.ok(result.lines.every(line => !/not paired yet/.test(line))); // Nothing deeper exists to inspect.
});

test('paired healthy state passes every private-state, recipient and health check without leaking numbers', t => {
  const { fx } = paired(t);
  const result = fx.report();
  assert.equal(result.ready, true, result.lines.join('\n'));
  const text = result.lines.join('\n');
  assert.match(text, /linked device is paired/);
  assert.match(text, /a single second number is configured/);
  assert.match(text, /bridge health is fresh and reports connected/);
  assert.match(text, /bound to exactly this Firstmate home/);
  assert.match(text, /alerts are enabled/);
  assert.ok(!text.includes('15555550999')); assert.ok(!text.includes('15555550123'));
});

test('stale lock from an exited pid is a problem naming the manual removal path', t => {
  const { fx, store } = paired(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  fs.mkdirSync(store.file('run.lock'), { mode: 0o700 });
  writeJson(store.file('run.lock/owner.json'), { pid: exited.pid, token: 'gone' });
  const result = fx.report();
  assert.equal(result.ready, false);
  const line = result.lines.find(line => line.includes('run.lock'));
  assert.match(line, /stale run\.lock/);
  assert.ok(line.includes(String(exited.pid)));
  assert.match(line, /remove/);
});

test('live lock reports single-instance ownership as a note, never a failure', t => {
  const { fx, store } = paired(t);
  fs.mkdirSync(store.file('run.lock'), { mode: 0o700 });
  writeJson(store.file('run.lock/owner.json'), { pid: process.pid, token: 'self' });
  const result = fx.report();
  assert.equal(result.ready, true);
  assert.ok(result.lines.some(line => /holds this state/.test(line) && line.includes(String(process.pid))));
  assert.ok(result.lines.every(line => !line.startsWith('problem:')));
});

test('unreadable lock owner and non-directory lock require manual inspection', t => {
  const { fx, store } = paired(t);
  fs.mkdirSync(store.file('run.lock'), { mode: 0o700 });
  let result = fx.report();
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /run\.lock owner is unreadable/);
  fs.rmSync(store.file('run.lock'), { recursive: true });
  fs.writeFileSync(store.file('run.lock'), '');
  result = fx.report();
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /not a lock directory/);
});

test('binding mismatch and home-path errors preserve the single-home contract', t => {
  const { fx } = paired(t);
  const other = path.join(fx.base, 'other-home'); fs.mkdirSync(other);
  let result = doctorReport({ home: other, env: fx.env, extensionRoot: root,
    transportReady: true, jqReady: true });
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /another Firstmate home/);
  const absent = path.join(fx.base, 'absent-home');
  result = doctorReport({ home: absent, env: fx.env, extensionRoot: root,
    transportReady: true, jqReady: true });
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /does not exist/);
});

test('loose private-state modes are reported with exact remediation', t => {
  const { fx, store } = paired(t);
  fs.chmodSync(store.root, 0o750);
  let result = fx.report();
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /mode 750.*chmod 700/s);
  fs.chmodSync(store.root, 0o700);
  fs.chmodSync(store.file('auth'), 0o711);
  result = fx.report();
  assert.match(result.lines.join('\n'), /auth is mode 711/);
  fs.chmodSync(store.file('auth'), 0o700);
  fs.chmodSync(store.file('recipient.json'), 0o644);
  result = fx.report();
  assert.match(result.lines.join('\n'), /recipient\.json is mode 644/);
});

test('invalid recipient configuration fails before the bridge starts', t => {
  const { fx, store } = paired(t);
  writeJson(store.file('recipient.json'), { account: '999@g.us' });
  const result = fx.report();
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /recipient configuration is invalid/);
});

test('doctor reports the optional voice configuration without echoing its paths', t => {
  const { fx, store } = paired(t);
  let result = fx.report();
  assert.equal(result.ready, true);
  assert.match(result.lines.join('\n'), /voice transcription is not configured/);
  const bin = name => { const file = path.join(fx.base, name); fs.writeFileSync(file, '#!/bin/false\n', { mode: 0o700 }); return file; };
  writeJson(store.file('voice.json'), { schema: 'fm-whatsapp-voice.v1', ffmpeg: bin('ffmpeg'), whisper: bin('whisper-cli'), model: bin('model'), language: 'en' });
  result = fx.report();
  assert.equal(result.ready, true, result.lines.join('\n'));
  assert.match(result.lines.join('\n'), /voice transcription configuration validates/);
  writeJson(store.file('voice.json'), { schema: 'fm-whatsapp-voice.v1', ffmpeg: 'relative', whisper: bin('whisper-cli'), model: bin('model') });
  result = fx.report();
  assert.equal(result.ready, false);
  const line = result.lines.find(line => line.includes('voice.json is not a valid'));
  assert.ok(line);
  assert.ok(!line.includes('relative'));
  fs.chmodSync(store.file('voice.json'), 0o644);
  result = fx.report();
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /voice\.json is mode 644/);
});

test('missing runtime dependencies and Firstmate scripts are blocking findings with fixes', t => {
  const { report, base } = fixture(t);
  let result = report({ probes: { nodeMajor: 18 } });
  assert.match(result.lines.join('\n'), /Node >= 20 is required/);
  assert.equal(result.ready, false);
  result = report({ probes: { transportReady: false } });
  assert.match(result.lines.join('\n'), /npm ci --prefix/);
  result = report({ probes: { jqReady: false } });
  assert.match(result.lines.join('\n'), /jq is missing/);
  const emptyCode = path.join(base, 'empty-code'); fs.mkdirSync(emptyCode);
  result = report({ env: { FM_CODE_ROOT: emptyCode } });
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /FM_CODE_ROOT/);
});

test('relative delegate state cannot pass diagnostics', t => {
  const { report } = fixture(t);
  const result = report({ env: { FM_DELEGATE_STATE: 'relative/state' } });
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /cannot be resolved/);
});

test('doctor CLI exits nonzero on problems and never prints phone numbers', t => {
  const { fx, store } = paired(t);
  fs.mkdirSync(store.file('run.lock'), { mode: 0o700 });
  writeJson(store.file('run.lock/owner.json'), { pid: 2147483000, token: 'x' });
  const result = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8', env: { ...process.env, ...fx.env } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fm-whatsapp installation check/);
  assert.match(result.stdout, /problem: .*run\.lock/s);
  assert.ok(!result.stdout.includes('15555550999')); assert.ok(!result.stdout.includes('15555550123'));
});

test('doctor CLI on a fresh home prints a bounded report and exits ready when checks pass', t => {
  const { env } = fixture(t);
  const result = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8', env: { ...process.env, ...env } });
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines[0].includes('fm-whatsapp installation check'));
  assert.ok(lines.slice(2, -1).every(line => /^(ok|note|problem): /.test(line)), lines.join('\n'));
  assert.equal(result.status, result.stdout.includes('problem:') ? 1 : 0);
});

// A PATH shim keeping only dirname (needed for SCRIPT_DIR) so the wrapper's
// dependency checks run without the real /usr/bin node or jq.
function shadowBin({ fakeNode = false } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-path-'));
  fs.symlinkSync('/usr/bin/dirname', path.join(temporary, 'dirname'));
  if (fakeNode) {
    fs.writeFileSync(path.join(temporary, 'node'), '#!/bin/sh\ncase "$1" in --version) echo v19.9.0 ;; esac\n', { mode: 0o755 });
  }
  return { temporary, env: { ...process.env, PATH: temporary } };
}

test('wrapper refuses a missing or too-old Node before touching the CLI', t => {
  const missing = shadowBin();
  let result = spawnSync('/bin/bash', [wrapper, 'help'], { encoding: 'utf8', env: missing.env });
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /Node 20 or newer is required/);
  const old = shadowBin({ fakeNode: true });
  result = spawnSync('/bin/bash', [wrapper, 'help'], { encoding: 'utf8', env: old.env });
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /Node 20 or newer is required.*19/s);
  for (const dir of [missing.temporary, old.temporary]) fs.rmSync(dir, { recursive: true, force: true });
});

test('wrapper refuses an incomplete checkout and passes a complete one through to the CLI', t => {
  const fx = fixture(t);
  const partial = path.join(fx.base, 'partial');
  fs.mkdirSync(partial, { recursive: true });
  fs.copyFileSync(wrapper, path.join(partial, 'fm-whatsapp.sh'));
  let result = spawnSync('/bin/bash', [path.join(partial, 'fm-whatsapp.sh'), 'status'], { encoding: 'utf8', env: { ...process.env, ...fx.env } });
  assert.equal(result.status, 1); assert.match(result.stderr, /installation incomplete/);
  result = spawnSync('/bin/bash', [wrapper, 'status'], { encoding: 'utf8', env: { ...process.env, ...fx.env } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { connected: false, fresh: false, updated_epoch: null,
    queued: 0, pending: 0, uncertain: 0, problem: 'bridge is not running or health is stale' });
});

test('projection scripts name jq clearly when it is absent', t => {
  const fx = fixture(t);
  // The guards run before any external command, so an empty PATH is safe here.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-nojq-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const env = { ...process.env, PATH: bare, FM_HOME: fx.home, FM_CODE_ROOT: fx.codeRoot,
    FM_DELEGATE_STATE: fx.state, FM_STATE_OVERRIDE: fx.state };
  let result = spawnSync('/bin/bash', [path.join(root, 'bin/fm-whatsapp-events.sh'), '--json'], { encoding: 'utf8', env });
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /jq is required to project Firstmate status events/);
  result = spawnSync('/bin/bash', [path.join(root, 'bin/fm-whatsapp-decisions.sh'), '--json'], { encoding: 'utf8', env });
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /jq is required to read recorded decisions/);
});
