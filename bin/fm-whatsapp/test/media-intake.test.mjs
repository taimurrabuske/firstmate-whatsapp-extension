import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, Bridge, writeJson, readJson, sha256 } from '../core.mjs';
import { MediaIntake, sweepStaleTemporaries } from '../media-intake.mjs';

function fixture(t, { self = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-intake-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new Store(home, path.join(home, 'private'));
  const user = { id: '15555550123:1@s.whatsapp.net' };
  const peer = self ? null : { account: '15555550999@s.whatsapp.net', aliases: ['15555550999@s.whatsapp.net'] };
  if (!self) writeJson(store.file('recipient.json'), { account: peer.account });
  const bridge = new Bridge({ store, peer, clock: () => 1000,
    events: async () => ({ schema: 'fm-whatsapp-events.v1', afk: false, session: '', events: [] }),
    inbox: async () => {}, status: async () => '', send: async () => true });
  bridge.connect(user);
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('image')]);
  const account = bridge.identity.account;
  const candidate = (id, { remoteJid = peer?.account ?? account, fromMe = self } = {}) => ({
    key: { id, remoteJid, fromMe }, messageTimestamp: 1005,
    message: { imageMessage: { mimetype: 'image/png', fileLength: png.length } } });
  const options = (overrides = {}) => ({ store, bridge, clock: () => 1005,
    encode: message => Buffer.from(JSON.stringify(message)), decode: bytes => JSON.parse(bytes.toString()),
    download: async () => { throw new Error('must not download'); }, ...overrides });
  return { home, store, bridge, peer, png, candidate, options, account };
}

test('own outbound media echoes are never journaled as inbound intake while siblings still stage', t => {
  const f = fixture(t, { self: true });
  writeJson(f.store.file(`sent/${sha256('echo')}.json`), { remoteId: 'ECHO1', kind: 'reply' });
  const intake = new MediaIntake(f.options());
  intake.stage({ type: 'notify', messages: [f.candidate('ECHO1'), f.candidate('FRESH2')] });
  assert.equal(f.store.records('media-pending').length, 1);
  const [name] = f.store.records('media-pending');
  const job = readJson(f.store.file(`media-pending/${name}`));
  assert.equal(JSON.parse(Buffer.from(job.encoded, 'base64').toString()).key.id, 'FRESH2');
});

test('a staged locator whose send receipt appears before processing is dropped without downloading', async t => {
  const f = fixture(t, { self: true });
  let downloads = 0;
  const intake = new MediaIntake(f.options({ download: async () => { downloads++; return f.png; } }));
  intake.stage({ type: 'notify', messages: [f.candidate('ECHO3')] });
  assert.equal(f.store.records('media-pending').length, 1);
  writeJson(f.store.file(`sent/${sha256('late-echo')}.json`), { remoteId: 'ECHO3', kind: 'reply' });
  await intake.processOne();
  assert.equal(downloads, 0); assert.equal(f.store.records('media-pending').length, 0);
});

test('an oversized media envelope is refused without losing its batch siblings', t => {
  const f = fixture(t);
  const encode = message => message.key.id === 'HUGE1' ? Buffer.alloc(131073, 1) : Buffer.from(JSON.stringify(message));
  const intake = new MediaIntake(f.options({ encode }));
  intake.stage({ type: 'notify', messages: [f.candidate('HUGE1'), f.candidate('OK2')] });
  assert.equal(f.store.records('media-pending').length, 1);
  const [name] = f.store.records('media-pending');
  const job = readJson(f.store.file(`media-pending/${name}`));
  assert.equal(JSON.parse(Buffer.from(job.encoded, 'base64').toString()).key.id, 'OK2');
  assert.match(f.bridge.problem, /envelope/);
});

test('media intake still refuses to grow past its capacity bound', t => {
  const f = fixture(t);
  fs.mkdirSync(f.store.file('media-pending'), { recursive: true, mode: 0o700 });
  for (let index = 0; index < 100; index++) {
    fs.writeFileSync(f.store.file(`media-pending/${sha256(`slot-${index}`)}.json`), '{}\n', { mode: 0o600 });
  }
  const intake = new MediaIntake(f.options());
  assert.throws(() => intake.stage({ type: 'notify', messages: [f.candidate('OVER1')] }), /intake full/);
  assert.equal(f.store.records('media-pending').length, 100);
});

test('duplicate media inside one batch stages exactly one durable locator', t => {
  const f = fixture(t);
  const intake = new MediaIntake(f.options());
  const message = f.candidate('SAME1');
  intake.stage({ type: 'notify', messages: [message, message] });
  intake.stage({ type: 'notify', messages: [message] });
  assert.equal(f.store.records('media-pending').length, 1);
});

test('stale private temporaries from interrupted work are swept on intake construction', t => {
  const f = fixture(t);
  const old = Date.now() / 1000 - 7200;
  for (const directory of ['attachments/incoming', 'attachments/outgoing', 'voice-tmp']) {
    fs.mkdirSync(f.store.file(directory), { recursive: true, mode: 0o700 });
  }
  const staleDownload = f.store.file('attachments/incoming/.stale.tmp');
  fs.writeFileSync(staleDownload, 'partial download', { mode: 0o600 }); fs.utimesSync(staleDownload, old, old);
  const freshDownload = f.store.file('attachments/incoming/.fresh.tmp');
  fs.writeFileSync(freshDownload, 'in flight', { mode: 0o600 });
  const stagedCopy = f.store.file('attachments/outgoing/.old.tmp');
  fs.writeFileSync(stagedCopy, 'old copy', { mode: 0o600 }); fs.utimesSync(stagedCopy, old, old);
  const attachment = f.store.file('attachments/incoming/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  fs.writeFileSync(attachment, f.png, { mode: 0o600 }); fs.utimesSync(attachment, old, old);
  const transcript = f.store.file('attachments/incoming/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.transcript.txt');
  fs.writeFileSync(transcript, 'kept transcript', { mode: 0o600 }); fs.utimesSync(transcript, old, old);
  const staleWork = f.store.file('voice-tmp/00000000-0000-4000-8000-000000000001');
  fs.mkdirSync(staleWork, { mode: 0o700 });
  fs.writeFileSync(path.join(staleWork, 'audio.wav'), 'RIFF', { mode: 0o600 });
  fs.utimesSync(staleWork, old, old);
  const freshWork = f.store.file('voice-tmp/00000000-0000-4000-8000-000000000002');
  fs.mkdirSync(freshWork, { mode: 0o700 });
  new MediaIntake(f.options({ clock: () => Math.floor(Date.now() / 1000) }));
  assert.equal(fs.existsSync(staleDownload), false);
  assert.equal(fs.existsSync(stagedCopy), false);
  assert.equal(fs.existsSync(staleWork), false);
  assert.equal(fs.existsSync(freshDownload), true);
  assert.equal(fs.existsSync(attachment), true);
  assert.equal(fs.readFileSync(transcript, 'utf8'), 'kept transcript');
  assert.equal(fs.existsSync(freshWork), true);
  assert.deepEqual(sweepStaleTemporaries(f.store), []);
});

test('the sweep removes only expired hidden temporaries when called directly', t => {
  const f = fixture(t);
  fs.mkdirSync(f.store.file('attachments/incoming'), { recursive: true, mode: 0o700 });
  const now = 5000;
  const expired = f.store.file('attachments/incoming/.expired.tmp');
  fs.writeFileSync(expired, 'residue', { mode: 0o600 });
  const kept = f.store.file('attachments/incoming/.partial.tmp');
  fs.writeFileSync(kept, 'recent', { mode: 0o600 });
  const removed = sweepStaleTemporaries(f.store, { now, maxAgeSeconds: 3600 });
  assert.deepEqual(removed, []);
  const past = 100;
  fs.utimesSync(expired, past, past);
  assert.deepEqual(sweepStaleTemporaries(f.store, { now, maxAgeSeconds: 3600 }), [expired]);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.readFileSync(kept, 'utf8'), 'recent');
});
