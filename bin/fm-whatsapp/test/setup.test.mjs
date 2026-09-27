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
    transportReady: true, jqReady: true, ...(overrides.probes ?? {}),
    ...(overrides.now != null ? { now: overrides.now } : {}) });
  return { base, home, codeRoot, state, env, report };
}

function paired(t) {
  const fx = fixture(t);
  const store = new Store(fx.home, fx.state);
  writeJson(store.file('identity.json'), identity);
  writeJson(store.file('recipient.json'), { account: peerAccount });
  writeJson(store.file('health.json'), { connected: true, updated_epoch: epoch(), account: peerAccount, problem: '', queued: 0, pending: 0, uncertain: 0 });
  writeJson(store.file('enabled.json'), { enabled: true });
  // A healthy paired state has a live owner: doctor treats fresh connected
  // health without a live lock as a single-instance contradiction.
  fs.mkdirSync(store.file('run.lock'), { mode: 0o700 });
  writeJson(store.file('run.lock/owner.json'), { pid: process.pid, token: 'fixture', started: epoch(),
    home: fs.realpathSync(fx.home), delegateState: store.root });
  return { fx, store };
}
const hexKey = value => value.toString(16).padStart(64, '0');

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

test('stale lock from an exited pid is a note that the next run reclaims it', t => {
  const { fx, store } = paired(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  fs.rmSync(store.file('run.lock'), { recursive: true });
  fs.mkdirSync(store.file('run.lock'), { mode: 0o700 });
  writeJson(store.file('run.lock/owner.json'), { pid: exited.pid, token: 'gone' });
  const result = fx.report();
  const line = result.lines.find(line => line.includes('run.lock'));
  assert.match(line, /^note: stale run\.lock/);
  assert.ok(line.includes(String(exited.pid)));
  assert.match(line, /reclaims/);
  assert.ok(!result.lines.some(row => row.startsWith('problem: stale run.lock')));
});

test('stale lock age from recorded ownership bounds how long the state was held', t => {
  const { fx, store } = paired(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  writeJson(store.file('run.lock/owner.json'), { pid: exited.pid, token: 'gone', started: epoch() - 120 });
  const line = fx.report().lines.find(line => line.includes('stale run.lock'));
  assert.match(line, /lock age 12[01]s/);
  assert.ok(line.includes(store.file('run.lock')));
});

test('live lock reports single-instance ownership as a note, never a failure', t => {
  const { fx } = paired(t);
  const result = fx.report();
  assert.equal(result.ready, true);
  assert.ok(result.lines.some(line => /holds this state/.test(line) && line.includes(String(process.pid))));
  assert.ok(result.lines.every(line => !line.startsWith('problem:')));
});

test('a lock recorded for another home or state directory is a service-manager binding mismatch', t => {
  const { fx, store } = paired(t);
  writeJson(store.file('run.lock/owner.json'), { pid: process.pid, token: 'x', started: epoch(),
    home: path.join(fx.base, 'other-home'), delegateState: path.join(fx.base, 'elsewhere') });
  const result = fx.report();
  assert.equal(result.ready, false);
  const text = result.lines.join('\n');
  assert.match(text, /recorded for another Firstmate home/);
  assert.match(text, /another private state directory/);
  assert.match(text, /never remove|align FM_HOME/);
});

test('fresh connected health without a live lock is a single-instance contradiction', t => {
  const { fx, store } = paired(t);
  fs.rmSync(store.file('run.lock'), { recursive: true });
  const result = fx.report();
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /no live run\.lock owner exists/);
});

test('a live lock with stale health stays a note, and a stopped bridge gets exact start guidance', t => {
  const { fx, store } = paired(t);
  writeJson(store.file('health.json'), { connected: false, updated_epoch: epoch() - 999, account: identity.account, problem: '', queued: 0, pending: 0, uncertain: 0 });
  let result = fx.report();
  assert.equal(result.ready, true);
  assert.match(result.lines.join('\n'), /may still be starting or reconnecting/);
  fs.rmSync(store.file('run.lock'), { recursive: true });
  result = fx.report();
  assert.equal(result.ready, true);
  assert.match(result.lines.join('\n'), /start it once under your process manager/);
});

test('unreadable lock owner and non-directory lock require manual inspection', t => {
  const { fx, store } = paired(t);
  fs.rmSync(store.file('run.lock'), { recursive: true });
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

test('queue backlogs and uncertain handoffs are counted without exposing message content', t => {
  const { fx, store } = paired(t);
  writeJson(store.file(`outbox/${hexKey(1)}.json`), { text: 'PRIVATE BODY' });
  writeJson(store.file(`outbox/${hexKey(2)}.json`), {});
  writeJson(store.file(`pending/${hexKey(3)}.json`), { uncertain: true });
  fs.mkdirSync(store.file('handoffs'), { mode: 0o700 });
  writeJson(store.file(`handoffs/${hexKey(3)}.json`), { phase: 'uncertain' });
  let result = fx.report();
  assert.equal(result.ready, false);
  const text = result.lines.join('\n');
  assert.match(text, /outbound queue holds 2 message\(s\)/);
  assert.match(text, /1 accepted request\(s\) could not be proved delivered/);
  assert.match(text, /never delete a receipt or republish automatically/);
  assert.match(text, /1 handoff receipt\(s\) record an uncertain publication/);
  assert.ok(!text.includes('PRIVATE BODY'));
  // A mid-publication receipt left by an interrupted bridge is its own finding.
  writeJson(store.file(`handoffs/${hexKey(4)}.json`), { phase: 'calling' });
  assert.match(fx.report().lines.join('\n'), /left mid-publication by an interrupted bridge/);
  // A clean pending job is only a note: the bridge retries it automatically.
  fs.rmSync(store.file(`pending/${hexKey(3)}.json`));
  fs.rmSync(store.file(`handoffs/${hexKey(3)}.json`));
  fs.rmSync(store.file(`handoffs/${hexKey(4)}.json`));
  writeJson(store.file(`pending/${hexKey(5)}.json`), { uncertain: false });
  result = fx.report();
  assert.equal(result.ready, true);
  assert.match(result.lines.join('\n'), /1 accepted request\(s\) await processing/);
});

test('a full outbound queue is a problem that still forbids manual deletion', t => {
  const { fx, store } = paired(t);
  for (let i = 0; i < 100; i++) writeJson(store.file(`outbox/${hexKey(i + 16)}.json`), {});
  const result = fx.report();
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /outbound queue is full \(100 messages\)/);
  assert.match(result.lines.join('\n'), /do not delete queued files manually/);
});

test('inbox adapter configuration and watcher beacon liveness are reported read-only', t => {
  const { fx, store } = paired(t);
  let text = fx.report().lines.join('\n');
  assert.match(text, /inbox wake adapter is not configured/);
  const configFile = path.join(fx.state, 'inbox-adapter.json');
  fs.writeFileSync(configFile, JSON.stringify({ schema: 'firstmate.whatsapp-inbox-config.v1',
    whatsapp_state: path.join(fx.base, 'elsewhere'), fm_home: fs.realpathSync(fx.home), extension_root: root }), { mode: 0o600 });
  text = fx.report().lines.join('\n');
  assert.match(text, /does not match this installation/);
  assert.match(text, /whatsapp_state/);
  fs.writeFileSync(configFile, JSON.stringify({ schema: 'firstmate.whatsapp-inbox-config.v1',
    whatsapp_state: store.root, fm_home: fs.realpathSync(fx.home), fm_state: path.join(fx.base, 'fmstate'),
    extension_root: root, poll_ms: 30000 }), { mode: 0o600 });
  let result = fx.report();
  assert.equal(result.ready, true);
  assert.match(result.lines.join('\n'), /inbox adapter configuration matches this home and private state/);
  assert.match(result.lines.join('\n'), /no controller watcher beacon found/);
  // Beacon freshness is evaluated against the injected clock; stale stays a note.
  const fmState = path.join(fx.base, 'fmstate'); fs.mkdirSync(fmState, { recursive: true });
  fs.writeFileSync(path.join(fmState, '.last-watcher-beat'), '');
  const beacon = overrides => fx.report({ env: { FM_STATE_OVERRIDE: fmState }, ...overrides });
  let beaconResult = beacon({ now: epoch() + 10 });
  assert.equal(beaconResult.ready, true);
  assert.match(beaconResult.lines.join('\n'), /beacon is fresh \(1\ds old\)/);
  beaconResult = beacon({ now: epoch() + 400 });
  assert.equal(beaconResult.ready, true);
  assert.match(beaconResult.lines.join('\n'), /beacon is 40\ds old/);
  // An operator-selected configuration path is honored.
  const selected = path.join(fx.base, 'selected-config.json');
  fs.writeFileSync(selected, 'not json', { mode: 0o600 });
  result = fx.report({ env: { WHATSAPP_ADAPTER_CONFIG: selected } });
  assert.equal(result.ready, false);
  assert.match(result.lines.join('\n'), /unreadable or has an unrecognized schema/);
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
    queued: 0, pending: 0, uncertain: 0, lock: 'absent', problem: 'bridge is not running or health is stale' });
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
