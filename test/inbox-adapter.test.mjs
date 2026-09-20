import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dispatch, poll } from '../adapter/bin/firstmate-extension.mjs';

const bindingOf = config =>
  createHash('sha256').update(JSON.stringify({ ...config, poll_ms: undefined })).digest('hex');
const hexKey = value => createHash('sha256').update(value).digest('hex');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-wake-test-')));
  const cleanup = [];
  t.after(() => {
    for (const action of cleanup.reverse()) action();
    // The host installs immutable package directories in this isolated home.
    const writable = directory => {
      if (!fs.lstatSync(directory).isDirectory()) return;
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory)) writable(path.join(directory, entry));
    };
    writable(temp);
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const config = { schema: 'firstmate.whatsapp-inbox-config.v1', source_id: 'test-whatsapp',
    whatsapp_state: path.join(temp, 'delegate/whatsapp'), fm_home: path.join(temp, 'home'),
    fm_state: path.join(temp, 'home/state'), extension_root: root, poll_ms: 0 };
  for (const directory of [config.whatsapp_state, config.fm_home, config.fm_state,
    path.join(config.whatsapp_state, 'handoffs'), path.join(config.fm_state, 'inbox'),
    path.join(config.fm_state, 'procevent-inbox')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const configFile = path.join(temp, 'config.json');
  json(configFile, config);
  const request = (char = '1') => ({ schema: 'firstmate.extension-request.v1', request_id: `sha256:${char.repeat(64)}`,
    extension_id: 'org.firstmate-whatsapp.inbox', extension_version: '1.0.0', host_protocol: 1,
    package_digest: `sha256:${'a'.repeat(64)}`, capability: 'process-event-adapter', capability_version: 1,
    adapter: 'whatsapp-inbox', operation: 'source.poll', input: { source_id: config.source_id, config_ref: configFile } });
  const note = (char = 'a', phase = 'saved') => {
    const key = char.repeat(64), id = `1789863544-${char}`;
    const body = `[firstmate-whatsapp-message:${key}]\nprivate request content`;
    const file = path.join(config.fm_state, 'inbox', `${id}.note`);
    fs.writeFileSync(file, `created: test\n--\n${body}\n`, { mode: 0o600 });
    json(path.join(config.whatsapp_state, 'handoffs', `${key}.json`), { id, body, phase });
    return { key, id, file };
  };
  const capture = (output, seq = 1) => {
    const base = path.join(config.fm_state, 'procevent-inbox', `${config.source_id}.${seq}`);
    fs.writeFileSync(`${base}.result`, output, { mode: 0o600 });
    fs.writeFileSync(`${base}.adapter`, 'whatsapp-inbox\n', { mode: 0o600 });
  };
  return { temp, config, configFile, json, request, note, capture, cleanup,
    cursorPath: () => path.join(config.whatsapp_state, 'wake-adapter', `${config.source_id}.json`),
    receiptPath: key => path.join(config.whatsapp_state, 'handoffs', `${key}.json`) };
}

test('pre-capture retries preserve the exact result even when more notes arrive', async t => {
  const f = fixture(t); const first = f.note();
  const result = await poll(f.request());
  f.note('b');
  assert.deepEqual(await poll(f.request()), result);
  assert.equal(JSON.parse(result.output).notes[0].message_key, first.key);
  assert.ok(!result.output.includes('private request content'));
  const cursor = JSON.parse(fs.readFileSync(path.join(f.config.whatsapp_state, 'wake-adapter/test-whatsapp.json')));
  assert.deepEqual(cursor.seen, []);
});

test('next captured sequence advances once and discovers the next saved note', async t => {
  const f = fixture(t); f.note();
  const first = await poll(f.request()); f.capture(first.output);
  f.note('b');
  const second = await poll(f.request('2'));
  assert.equal(JSON.parse(second.output).notes.length, 1);
  assert.equal(JSON.parse(second.output).notes[0].message_key, 'b'.repeat(64));
  f.capture(second.output, 2);
  assert.equal((await poll(f.request('3'))).status, 'no-result');
});

test('replacement registration before capture replays the pending event', async t => {
  const f = fixture(t); f.note();
  const first = await poll(f.request());
  assert.deepEqual(await poll(f.request('2')), first);
  f.capture(first.output);
  assert.equal((await poll(f.request('3'))).status, 'no-result');
});

test('no-result is rescanned under the same request identity', async t => {
  const f = fixture(t);
  assert.equal((await poll(f.request())).status, 'no-result');
  f.note();
  assert.equal((await poll(f.request())).status, 'result');
});

test('handled notes are skipped even when the saved receipt is stale', async t => {
  const f = fixture(t); const saved = f.note(); f.note('b', 'handled');
  fs.mkdirSync(path.join(f.config.fm_state, 'inbox/handled'), { mode: 0o700 });
  fs.renameSync(saved.file, path.join(f.config.fm_state, 'inbox/handled', `${saved.id}.note`));
  assert.equal((await poll(f.request())).status, 'no-result');
});

test('modified inbox bodies and nonprivate configuration fail closed', async t => {
  const f = fixture(t); const saved = f.note();
  fs.appendFileSync(saved.file, 'changed');
  await assert.rejects(poll(f.request()), /does not match/);
  fs.chmodSync(f.configFile, 0o644);
  await assert.rejects(poll(f.request()), /unsafe private file/);
});

test('configuration identity, shape, and private-path violations fail closed', async t => {
  const f = fixture(t);
  const rewrite = mutate => {
    const config = { ...f.config };
    mutate(config);
    fs.writeFileSync(f.configFile, JSON.stringify(config), { mode: 0o600 });
  };
  await assert.rejects(poll({ ...f.request(), input: undefined }), /invalid source identity/);
  await assert.rejects(poll({ ...f.request(), input: { source_id: f.config.source_id, config_ref: 'relative.json' } }),
    /absolute private path/);
  const link = path.join(f.temp, 'config-link.json');
  fs.symlinkSync(f.configFile, link);
  await assert.rejects(poll({ ...f.request(), input: { source_id: f.config.source_id, config_ref: link } }),
    /unsafe private file/);
  await assert.rejects(poll({ ...f.request(), input: { source_id: 'other-source', config_ref: f.configFile } }),
    /configuration identity mismatch/);
  const broken = async (mutate, pattern) => {
    rewrite(mutate);
    await assert.rejects(poll(f.request()), pattern);
    fs.writeFileSync(f.configFile, JSON.stringify(f.config), { mode: 0o600 });
  };
  await broken(config => { config.schema = 'firstmate.whatsapp-inbox-config.v2'; }, /identity mismatch/);
  await broken(config => { config.unexpected = true; }, /identity mismatch/);
  await broken(config => { config.poll_ms = 45000; }, /poll duration/);
  await broken(config => { config.poll_ms = -1; }, /poll duration/);
  await broken(config => { config.poll_ms = 'brief'; }, /poll duration/);
  await broken(config => { config.fm_state = 'relative/state'; }, /canonical absolute paths/);
  const aliased = path.join(f.temp, 'aliased');
  fs.mkdirSync(aliased, { mode: 0o700 });
  fs.symlinkSync(f.config.whatsapp_state, path.join(aliased, 'whatsapp'));
  await broken(config => { config.whatsapp_state = path.join(aliased, 'whatsapp'); }, /canonical absolute paths/);
  fs.writeFileSync(f.configFile, 'null', { mode: 0o600 });
  await assert.rejects(poll(f.request()), /configuration identity mismatch/);
});

test('a changed binding migrates the cursor and rescans undelivered notes', async t => {
  const f = fixture(t); const saved = f.note();
  const first = await poll(f.request());
  assert.equal(JSON.parse(first.output).notes[0].message_key, saved.key);
  fs.mkdirSync(path.join(f.temp, 'elsewhere'), { mode: 0o700 });
  fs.writeFileSync(f.configFile, JSON.stringify({ ...f.config, extension_root: path.join(f.temp, 'elsewhere') }),
    { mode: 0o600 });
  const second = await poll(f.request('2'));
  assert.equal(JSON.parse(second.output).notes[0].message_key, saved.key);
  assert.equal(JSON.parse(second.output).request_id, f.request('2').request_id);
  assert.match(JSON.parse(second.output).reply_skill, /elsewhere/);
  const cursor = JSON.parse(fs.readFileSync(f.cursorPath()));
  assert.equal(cursor.binding, bindingOf(JSON.parse(fs.readFileSync(f.configFile))));
  assert.deepEqual(cursor.seen, []);
  assert.deepEqual(cursor.pending.keys, [saved.key]);
  assert.deepEqual(await poll(f.request('2')), second);
});

test('poll_ms tuning keeps the cursor binding stable', async t => {
  const f = fixture(t); f.note();
  const first = await poll(f.request());
  fs.writeFileSync(f.configFile, JSON.stringify({ ...f.config, poll_ms: 30000 }), { mode: 0o600 });
  assert.deepEqual(await poll(f.request()), first);
  const cursor = JSON.parse(fs.readFileSync(f.cursorPath()));
  assert.equal(cursor.binding, bindingOf(f.config));
  assert.deepEqual(cursor.seen, []);
});

test('a corrupt cursor heals and rescans, while malformed cursors fail closed', async t => {
  const f = fixture(t); const saved = f.note();
  await poll(f.request());
  fs.writeFileSync(f.cursorPath(), '{"schema":"firstmate.whatsapp-inbox', { mode: 0o600 });
  const healed = await poll(f.request('2'));
  assert.equal(JSON.parse(healed.output).notes[0].message_key, saved.key);
  const cursor = JSON.parse(fs.readFileSync(f.cursorPath()));
  assert.equal(cursor.binding, bindingOf(f.config));
  const writeCursor = value => fs.writeFileSync(f.cursorPath(), JSON.stringify({
    schema: 'firstmate.whatsapp-inbox-cursor.v1', binding: bindingOf(f.config), ...value }), { mode: 0o600 });
  writeCursor({ seen: ['not-a-message-key'], pending: null });
  await assert.rejects(poll(f.request('3')), /cursor configuration changed or cursor invalid/);
  writeCursor({ seen: [], pending: { request_id: `sha256:${'0'.repeat(64)}`, keys: [], output: 'x' } });
  await assert.rejects(poll(f.request('3')), /cursor configuration changed or cursor invalid/);
  writeCursor({ seen: [], pending: { request_id: 'not-a-request', keys: [saved.key], output: 'x' } });
  await assert.rejects(poll(f.request('3')), /cursor configuration changed or cursor invalid/);
  fs.writeFileSync(f.cursorPath(), JSON.stringify({
    schema: 'firstmate.whatsapp-inbox-cursor.v2', binding: bindingOf(f.config), seen: [], pending: null }), { mode: 0o600 });
  await assert.rejects(poll(f.request('3')), /cursor configuration changed or cursor invalid/);
  writeCursor({ seen: Array.from({ length: 20001 }, (_, i) => hexKey(String(i))), pending: null });
  await assert.rejects(poll(f.request('3')), /cursor configuration changed or cursor invalid/);
});

test('an in-flight capture without its adapter marker replays instead of failing', async t => {
  const f = fixture(t); f.note();
  const first = await poll(f.request());
  const base = path.join(f.config.fm_state, 'procevent-inbox', `${f.config.source_id}.1`);
  fs.writeFileSync(`${base}.result`, first.output, { mode: 0o600 });
  assert.deepEqual(await poll(f.request('2')), first);
  fs.writeFileSync(`${base}.adapter`, 'whatsapp-inbox\n', { mode: 0o600 });
  assert.equal((await poll(f.request('3'))).status, 'no-result');
});

test('the same request identity replays even after the result was captured', async t => {
  const f = fixture(t); const saved = f.note();
  const first = await poll(f.request());
  f.capture(first.output);
  assert.deepEqual(await poll(f.request()), first);
  const cursor = JSON.parse(fs.readFileSync(f.cursorPath()));
  assert.deepEqual(cursor.seen, []);
  assert.deepEqual(cursor.pending.keys, [saved.key]);
});

test('empty polls write nothing and stay no-results', async t => {
  const f = fixture(t);
  assert.equal((await poll(f.request())).status, 'no-result');
  assert.equal(fs.existsSync(f.cursorPath()), false);
  assert.equal((await poll(f.request('2'))).status, 'no-result');
  assert.equal(fs.existsSync(f.cursorPath()), false);
});

test('malformed private receipts fail closed or skip without wedging', async t => {
  const f = fixture(t); const saved = f.note();
  const receipt = JSON.parse(fs.readFileSync(f.receiptPath(saved.key)));
  receipt.binding = { home: path.join(f.temp, 'other-home'), state: path.join(f.temp, 'other-state') };
  fs.writeFileSync(f.receiptPath(saved.key), JSON.stringify(receipt), { mode: 0o600 });
  await assert.rejects(poll(f.request()), /another Firstmate home/);
  fs.writeFileSync(f.receiptPath(saved.key), 'null', { mode: 0o600 });
  assert.equal((await poll(f.request())).status, 'no-result');
});

test('a delivered cursor file refuses relaxed private modes', async t => {
  const f = fixture(t); f.note();
  await poll(f.request());
  fs.chmodSync(f.cursorPath(), 0o644);
  await assert.rejects(poll(f.request('2')), /unsafe private file/);
});

test('advanced suppression entries are pruned once their notes are handled', async t => {
  const f = fixture(t); const saved = f.note();
  const first = await poll(f.request());
  f.capture(first.output);
  const secondNote = f.note('b');
  const second = await poll(f.request('2'));
  assert.deepEqual(JSON.parse(second.output).notes.map(note => note.message_key), [secondNote.key]);
  let cursor = JSON.parse(fs.readFileSync(f.cursorPath()));
  assert.deepEqual(cursor.seen, [saved.key]);
  assert.deepEqual(cursor.pending.keys, [secondNote.key]);
  f.capture(second.output, 2);
  fs.mkdirSync(path.join(f.config.fm_state, 'inbox/handled'), { mode: 0o700 });
  fs.renameSync(saved.file, path.join(f.config.fm_state, 'inbox/handled', `${saved.id}.note`));
  const handled = JSON.parse(fs.readFileSync(f.receiptPath(secondNote.key)));
  handled.phase = 'handled';
  fs.writeFileSync(f.receiptPath(secondNote.key), JSON.stringify(handled), { mode: 0o600 });
  assert.equal((await poll(f.request('3'))).status, 'no-result');
  cursor = JSON.parse(fs.readFileSync(f.cursorPath()));
  assert.deepEqual(cursor.seen, []);
  assert.equal(cursor.pending, null);
});

test('handshake and verdicts conform and keep request handling with Firstmate', async t => {
  const f = fixture(t), request = f.request();
  const handshake = await dispatch('handshake', { ...request, schema: 'firstmate.extension-handshake-request.v1',
    host_protocols: [1], capability: { name: 'process-event-adapter', versions: [1], adapter_names: ['whatsapp-inbox'] } });
  assert.equal(handshake.host_protocol, 1);
  await assert.rejects(dispatch('invoke', { ...request, extension_version: '0.0.1' }), /invalid request identity/);
  for (const operation of ['result.terminal', 'result.silent']) {
    assert.deepEqual((await dispatch('invoke', { ...request, operation })).result, { value: false });
  }
  assert.deepEqual((await dispatch('invoke', { ...request, operation: 'result.classify' })).result,
    { classification: 'whatsapp-inbox' });
});

test('unchanged Firstmate binds, captures, classifies and acknowledges the external source', {
  skip: !process.env.FM_TEST_CODE_ROOT && 'set FM_TEST_CODE_ROOT for installed-host integration', timeout: 90000
}, t => {
  const f = fixture(t); const saved = f.note();
  const code = process.env.FM_TEST_CODE_ROOT;
  const stage = path.join(f.temp, 'package');
  fs.cpSync(path.join(root, 'adapter'), stage, { recursive: true });
  fs.chmodSync(stage, 0o755);
  fs.chmodSync(path.join(stage, 'bin'), 0o755);
  fs.chmodSync(path.join(stage, 'firstmate-extension.json'), 0o644);
  fs.chmodSync(path.join(stage, 'bin/firstmate-extension.mjs'), 0o755);
  const env = { ...process.env, FM_HOME: f.config.fm_home, FM_ROOT_OVERRIDE: code,
    FM_STATE_OVERRIDE: f.config.fm_state, FM_CODE_ROOT: code };
  const run = (script, args, success = true) => {
    const result = spawnSync(path.join(code, 'bin', script), args, { env, encoding: 'utf8', timeout: 30000 });
    if (success) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
    return result;
  };
  run('fm-extension.sh', ['bind', stage, '--adapter', 'whatsapp-inbox', '--trust-same-user-code', '--consent', 'task-metadata', '--timeout-ms', '45000']);
  const registered = run('fm-procevent.sh', ['register-extension', 'whatsapp-inbox', f.config.source_id, '--config-ref', f.configFile]);
  const token = /--if-owner ([A-Za-z0-9._:-]+)/.exec(registered.stdout)?.[1];
  assert.ok(token, registered.stdout);
  f.cleanup.push(() => run('fm-procevent.sh', ['retire', f.config.source_id, '--if-owner', token], false));
  // Only test code invokes this bounded zero-wait fixture synchronously.
  run('fm-procevent.sh', ['start', f.config.source_id]);
  const resultFile = path.join(f.config.fm_state, 'procevent-inbox', `${f.config.source_id}.1.result`);
  assert.equal(JSON.parse(fs.readFileSync(resultFile)).notes[0].message_key, saved.key);
  assert.equal(fs.statSync(resultFile.replace(/\.result$/, '.adapter')).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(f.config.fm_state, '.wake-queue'), 'utf8'), /procevent:test-whatsapp:1/);
  assert.equal(run('fm-procevent.sh', ['classify', resultFile]).stdout.trim(), 'whatsapp-inbox');
  run('fm-procevent.sh', ['handled', f.config.source_id, '1']);
  run('fm-procevent.sh', ['start', f.config.source_id]);
  assert.ok(!fs.existsSync(path.join(f.config.fm_state, 'procevent-inbox', `${f.config.source_id}.2.result`)));
});
