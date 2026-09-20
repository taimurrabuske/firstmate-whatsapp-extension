// Local acceptance matrix for the documented phone round trip. Every test is
// deterministic and offline: temporary Firstmate homes, fake transports, fake
// helpers at the process boundary, and a fake clock. No real phone, network,
// credentials, or Firstmate installation is used and Firstmate's sources stay
// unchanged. Covered rows:
//   1. authenticated text request -> journal -> note -> receipt -> final reply
//   2. duplicate and conflicting terminal replies
//   3. route, account, and configuration binding
//   4. media bounds (8 MiB image, 15 MiB document)
//   5. voice bounds (exactly 1,800 seconds) and offline transcription seams
//   6. notification preferences, digests, and quiet hours from the phone
//   7. offline outbound retry with a stable remote identity
//   8. unproved note publication retained, then recovered without duplication
//   9. captured whatsapp-inbox adapter results and handled-note pruning
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { poll } from '../adapter/bin/firstmate-extension.mjs';
import { Bridge, Store, readJson, writeJson, sha256 } from '../bin/fm-whatsapp/core.mjs';
import { FirstmateAdapter } from '../bin/fm-whatsapp/firstmate.mjs';
import { NotificationPolicy } from '../bin/fm-whatsapp/notifications.mjs';
import { MediaIntake } from '../bin/fm-whatsapp/media-intake.mjs';
import { authenticateMediaMetadata } from '../bin/fm-whatsapp/media.mjs';

const root = fs.realpathSync(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function stack(t, { peerAccount = null, start = 2000 } = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-acceptance-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fmHome = path.join(temp, 'home'), fmState = path.join(fmHome, 'state');
  fs.mkdirSync(fmState, { recursive: true, mode: 0o700 });
  const delegate = path.join(temp, 'delegate');
  const store = new Store(fmHome, delegate);
  const account = '15555550123@s.whatsapp.net';
  const peer = peerAccount ? { account: peerAccount, aliases: [peerAccount] } : null;
  if (peerAccount) writeJson(store.file('recipient.json'), { account: peerAccount });
  let now = start;
  const snapshot = { schema: 'fm-whatsapp-events.v1', afk: false, session: '', events: [] };
  const policy = new NotificationPolicy({ stateDir: store.root });
  const harness = { failSend: false, noteMode: 'save' }; // noteMode: save | silent
  const notes = [], wakes = [], sent = [];
  // Fake Firstmate process boundary: note publication writes a real private
  // inbox note and returns its id, exactly like bin/fm-inbox.sh.
  const run = async (file, args, options = {}) => {
    if (file === '/bin/bash') { wakes.push({ key: args.at(-2), text: args.at(-1) }); return ''; }
    if (file.endsWith('fm-inbox.sh')) {
      if (args[0] === 'note') {
        if (harness.noteMode === 'silent') return '';
        const id = `1789863544-${notes.length + 1}`;
        fs.mkdirSync(path.join(fmState, 'inbox'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(fmState, 'inbox', `${id}.note`),
          `id=${id}\nat=fixture\nsource=text\n--\n${options.input}\n`, { mode: 0o600 });
        notes.push({ id, body: options.input });
        return `queued ${id}\n`;
      }
      return 'Recorded fleet status: fixture summary.\n';
    }
    return '';
  };
  const adapter = new FirstmateAdapter({ home: fmHome, codeRoot: fmHome, state: fmState, store, extensionRoot: root, run });
  const bridge = new Bridge({ store, peer, clock: () => now, events: async () => snapshot,
    inbox: (key, text) => adapter.note(key, text), status: () => adapter.status(),
    summary: command => adapter.summary(command), notificationPolicy: policy,
    localCommand: text => policy.command(text), fallbackRoute: () => undefined,
    send: async (jid, text, remoteId, job) => {
      if (harness.failSend) return false;
      sent.push({ jid, text, remoteId, kind: job.kind, requestKey: job.requestKey ?? null });
      return true;
    } });
  bridge.connect({ id: '15555550123:1@s.whatsapp.net' });
  return {
    temp, fmHome, fmState, delegate, store, bridge, adapter, policy, snapshot, account, peer,
    harness, notes, wakes, sent,
    now: () => now, advance: seconds => { now += seconds; },
    message: (id, text, at = now + 1) => ({ key: { id, remoteJid: peer ? peer.account : account, fromMe: !peer },
      messageTimestamp: at, message: { conversation: text } }),
    receive: async (...messages) => bridge.receive({ type: 'notify', messages }),
    process: () => bridge.processPending(),
    refresh: () => bridge.refresh(),
    drain: async () => {
      for (let i = 0; i < 30 && store.records('outbox').length; i++) { now += 3; await bridge.flush(); }
    },
    requestKey: id => sha256(`${account}\n${peer ? `${peer.account}\n` : ''}${id}`),
    outbox: () => store.records('outbox').map(name => readJson(store.file(`outbox/${name}`))),
    health: () => readJson(store.file('health.json'))
  };
}

test('acceptance: an authenticated text request is received, receipted, worked, and completed by the only final reply', async t => {
  const h = stack(t);
  await h.receive(h.message('REQ-1', 'Please check the failing simulation'));
  const key = h.requestKey('REQ-1');
  const record = h.adapter.requests.get(key);
  assert.equal(record.state, 'received');
  assert.equal(record.requestText, 'Please check the failing simulation');
  assert.deepEqual(record.route, { account: h.account, recipient: h.account });
  assert.equal(record.history.length, 1);
  // Exactly one inbox note carries the documented envelope and reply binding.
  assert.equal(h.notes.length, 1);
  const body = h.notes[0].body;
  assert.ok(body.includes(`[firstmate-whatsapp-message:${key}]`));
  assert.match(body, /skills\/whatsapp-delegate\/SKILL.md/);
  assert.ok(body.includes(`"arguments":["reply","${key}"]`));
  assert.match(body, /Please check the failing simulation/);
  assert.deepEqual(h.wakes, []); // a helper that returns the queued id announces the note itself
  assert.equal(fs.existsSync(h.store.file(`pending/${key}.json`)), false);
  assert.ok(h.store.incoming(key));
  // The immediate "saved" receipt reaches the phone without any AFK session.
  await h.drain();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].jid, h.account);
  assert.match(h.sent[0].text, /received and saved for Firstmate/);
  assert.ok(h.sent[0].text.startsWith('[Firstmate] '));
  // Redelivery of the same message is a duplicate, never a second request.
  await h.receive(h.message('REQ-1', 'Please check the failing simulation'));
  assert.equal(h.notes.length, 1);
  assert.equal(h.adapter.requests.get(key).history.length, 1);
  assert.equal(h.store.records('outbox').length, 0);
  // The controller acknowledges progress, then records the only final result.
  h.adapter.progress(key, 'picked-up');
  h.adapter.progress(key, 'working', 'Reading the failing check.');
  await h.drain();
  assert.equal(h.sent.filter(x => /Request .*(picked-up|working)/.test(x.text)).length, 2);
  h.adapter.reply(key, 'The simulation finished; the result meets the stated target.');
  await h.drain();
  const finals = h.sent.filter(x => x.text.includes('The simulation finished'));
  assert.equal(finals.length, 1);
  assert.equal(finals[0].requestKey, key);
  assert.deepEqual(h.adapter.requests.get(key).history.map(x => x.state),
    ['received', 'picked-up', 'working', 'completed']);
  // The documented phone shortcut reads the recorded lifecycle, not live state.
  await h.receive(h.message('REQ-S', 'last result'));
  await h.drain();
  assert.ok(h.sent.some(x => x.text.includes('lifecycle state: completed') &&
    x.text.includes('The simulation finished')));
});

test('acceptance: duplicate final replies deduplicate while conflicting or failed outcomes are refused', async t => {
  const h = stack(t);
  await h.receive(h.message('DUP-1', 'Summarize the incident'));
  const key = h.requestKey('DUP-1');
  await h.drain();
  h.adapter.reply(key, 'Incident resolved; the root cause was a stale lock.');
  h.adapter.reply(key, 'Incident resolved; the root cause was a stale lock.'); // exact replay
  assert.equal(h.outbox().length, 1);
  assert.equal(h.adapter.requests.get(key).state, 'completed');
  assert.throws(() => h.adapter.reply(key, 'Incident resolved differently.'), /already completed/);
  assert.throws(() => h.adapter.progress(key, 'working'), /invalid request transition/);
  assert.throws(() => h.adapter.progress(key, 'failed'), /invalid request transition/);
  assert.equal(h.outbox().length, 1);
  assert.equal(h.adapter.requests.get(key).history.at(-1).text,
    'Incident resolved; the root cause was a stale lock.');
  await h.drain();
  // A failed request can never be completed afterwards.
  await h.receive(h.message('DUP-2', 'Ship the follow-up'));
  const failed = h.requestKey('DUP-2');
  await h.drain();
  h.adapter.progress(failed, 'working', 'Shipping.');
  h.adapter.progress(failed, 'failed', 'The transport refused the payload.');
  assert.throws(() => h.adapter.reply(failed, 'Shipped after all.'), /failed request cannot be completed/);
  assert.equal(h.adapter.requests.get(failed).state, 'failed');
  assert.match(await h.adapter.summary('blocked'), /The transport refused the payload/);
});

test('acceptance: requests and replies stay bound to the authenticated account, recipient, and configuration', async t => {
  const h = stack(t, { peerAccount: '15555550999@s.whatsapp.net' });
  await h.receive(h.message('BIND-1', 'Prepare tomorrow agenda'));
  const key = h.requestKey('BIND-1');
  assert.deepEqual(h.adapter.requests.get(key).route,
    { account: h.account, recipient: '15555550999@s.whatsapp.net' });
  await h.drain();
  assert.equal(h.sent[0].jid, '15555550999@s.whatsapp.net');
  h.adapter.reply(key, 'Agenda prepared.');
  await h.drain();
  assert.equal(h.sent.at(-1).jid, '15555550999@s.whatsapp.net');
  // A queued result is held for inspection, never redirected, while the chat changes.
  await h.receive(h.message('BIND-2', 'Also draft the message'));
  const key2 = h.requestKey('BIND-2');
  await h.drain();
  h.adapter.reply(key2, 'Draft ready for review.');
  // A recipient change only takes effect for the next bridge run; simulate that
  // restarted bridge and prove the queued result is held, never redirected.
  writeJson(h.store.file('recipient.json'), { account: '15555550888@s.whatsapp.net' });
  h.bridge.peer = { account: '15555550888@s.whatsapp.net', aliases: ['15555550888@s.whatsapp.net'] };
  assert.throws(() => h.adapter.reply(key2, 'Another answer.'), /published authenticated request on the current route/);
  assert.throws(() => h.adapter.progress(key2, 'waiting', 'Still going.'), /published authenticated request/);
  await h.drain();
  assert.ok(!h.sent.some(x => x.text === '[Firstmate] Draft ready for review.'));
  assert.match(h.health().problem, /reply route changed/);
  assert.equal(h.outbox().length, 1);
  writeJson(h.store.file('recipient.json'), { account: '15555550999@s.whatsapp.net' });
  h.bridge.peer = { account: '15555550999@s.whatsapp.net', aliases: ['15555550999@s.whatsapp.net'] };
  await h.drain();
  assert.ok(h.sent.some(x => x.text === '[Firstmate] Draft ready for review.'));
  // Unknown identities and foreign configurations are refused without queueing.
  assert.throws(() => h.adapter.reply('f'.repeat(64), 'Stolen answer.'), /published authenticated request/);
  const foreign = new FirstmateAdapter({ home: h.fmHome, codeRoot: h.fmHome,
    state: path.join(h.temp, 'elsewhere-state'), store: h.store, extensionRoot: root, run: async () => '' });
  assert.throws(() => foreign.reply(key, 'Stolen answer.'), /another Firstmate configuration/);
  assert.equal(h.outbox().length, 0);
  // The paired account itself can never silently change on this private state.
  assert.throws(() => h.bridge.connect({ id: '15555550777:1@s.whatsapp.net' }), /paired account changed/);
});

test('acceptance: media passes the exact 8 MiB image and 15 MiB document bounds before any download', async t => {
  const h = stack(t);
  const meta = message => authenticateMediaMetadata(message, h.bridge.identity, h.now() + 1, h.bridge.pairedAt, null);
  const image = bytes => ({ key: { id: 'IMG-EDGE', remoteJid: h.account, fromMe: true },
    messageTimestamp: h.now() + 1, message: { imageMessage: { mimetype: 'image/png', fileLength: bytes } } });
  const document = bytes => ({ key: { id: 'DOC-EDGE', remoteJid: h.account, fromMe: true },
    messageTimestamp: h.now() + 1,
    message: { documentMessage: { mimetype: 'application/pdf', fileName: 'report.pdf', fileLength: bytes } } });
  assert.ok(meta(image(8 * 1024 * 1024)));
  assert.equal(meta(image(8 * 1024 * 1024 + 1)), null);
  assert.ok(meta(document(15 * 1024 * 1024)));
  assert.equal(meta(document(15 * 1024 * 1024 + 1)), null);
  // A full-size image is journaled, staged, downloaded once, and handed to Firstmate.
  let downloads = 0;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8 * 1024 * 1024 - 8)]);
  const intake = new MediaIntake({ store: h.store, bridge: h.bridge, clock: () => h.now(),
    encode: value => Buffer.from(JSON.stringify(value)), decode: bytes => JSON.parse(bytes.toString()),
    download: async () => { downloads++; return png; }, transcribe: async () => ({ available: false }) });
  const edge = image(8 * 1024 * 1024); edge.key.id = 'BIG-IMG';
  const refused = image(8 * 1024 * 1024 + 1); refused.key.id = 'TOO-BIG';
  intake.stage({ type: 'notify', messages: [refused, edge] });
  assert.equal(h.store.records('media-pending').length, 1);
  assert.equal(downloads, 0);
  await intake.processOne();
  await h.process();
  assert.equal(downloads, 1);
  const record = h.adapter.requests.get(h.requestKey('BIG-IMG'));
  assert.equal(record.state, 'received');
  assert.match(record.requestText, /WhatsApp image received/);
  assert.match(record.requestText, /Local attachment: /);
  assert.match(record.requestText, /bytes: 8388608/);
  assert.match(h.notes[0].body, /Local attachment: /);
  assert.equal(h.adapter.requests.get(h.requestKey('TOO-BIG')), null);
  await intake.processOne();
  assert.equal(downloads, 1); // replay never downloads or publishes twice
  await h.drain();
  assert.match(h.sent.at(-1).text, /received and saved/);
});

test('acceptance: voice notes accept exactly 1,800 seconds and hand off with or without offline transcription', async t => {
  const h = stack(t);
  const meta = message => authenticateMediaMetadata(message, h.bridge.identity, h.now() + 1, h.bridge.pairedAt, null);
  const voice = (seconds, bytes = 4096, id = 'VOICE-EDGE') => ({ key: { id, remoteJid: h.account, fromMe: true },
    messageTimestamp: h.now() + 1,
    message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds, fileLength: bytes } } });
  assert.ok(meta(voice(1800)));
  assert.equal(meta(voice(1801)), null);
  assert.equal(meta(voice(1800, 10 * 1024 * 1024 + 1)), null); // 10 MiB voice bound
  assert.equal(meta({ ...voice(1800),
    message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: false, seconds: 1800, fileLength: 4096 } } }), null);
  // The boundary note downloads and is transcribed by the injected local runtime only.
  const transcripts = [];
  const intake = new MediaIntake({ store: h.store, bridge: h.bridge, clock: () => h.now(),
    encode: value => Buffer.from(JSON.stringify(value)), decode: bytes => JSON.parse(bytes.toString()),
    download: async () => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(4092)]),
    transcribe: async (file, metadata) => {
      transcripts.push({ file, seconds: metadata.duration });
      return { available: true, text: 'Run the failing check first.' };
    } });
  intake.stage({ type: 'notify', messages: [voice(1800, 4096, 'LONG-VOICE')] });
  await intake.processOne();
  await h.process();
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].seconds, 1800);
  assert.match(transcripts[0].file, /attachments\/incoming/);
  const record = h.adapter.requests.get(h.requestKey('LONG-VOICE'));
  assert.match(record.requestText, /voice note received/);
  assert.match(record.requestText, /Run the failing check first\./);
  await h.drain();
  // Without a configured runtime the note still hands off with the attachment path.
  const plain = new MediaIntake({ store: h.store, bridge: h.bridge, clock: () => h.now(),
    encode: value => Buffer.from(JSON.stringify(value)), decode: bytes => JSON.parse(bytes.toString()),
    download: async () => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(4092)]) });
  plain.stage({ type: 'notify', messages: [voice(60, 4096, 'NO-ASR')] });
  await plain.processOne();
  await h.process();
  assert.match(h.adapter.requests.get(h.requestKey('NO-ASR')).requestText, /Voice transcription is unavailable/);
  assert.match(h.adapter.requests.get(h.requestKey('NO-ASR')).requestText, /Local attachment: /);
});

test('acceptance: phone-set preferences steer immediate alerts, digests, subscriptions, and quiet hours', async t => {
  const h = stack(t, { start: 5000 });
  Object.assign(h.snapshot, { afk: true, session: 'away-9' });
  h.snapshot.events = [{ id: 'old:1', kind: 'completion', task: 'old', project: 'work',
    text: 'Historical outcome from before away.' }];
  await h.receive(h.message('PREF-1', 'alerts progress on'));
  await h.receive(h.message('PREF-2', 'digest 15'));
  await h.receive(h.message('PREF-3', 'unsubscribe project background'));
  await h.drain();
  assert.match(h.sent.at(-1).text, /digest 15m/);
  const prefs = h.policy.preferences();
  assert.equal(prefs.kinds.progress, true);
  assert.equal(prefs.digestMinutes, 15);
  assert.deepEqual(prefs.projects, { background: false });
  await h.refresh(); await h.drain();
  assert.ok(!h.sent.some(x => x.text.includes('Historical outcome'))); // entry baseline stays silent
  // New events: the open decision arrives immediately despite the digest timer;
  // completion and progress wait for the digest window; the unsubscribed project never alerts.
  h.snapshot.events = [
    { id: 'report:done:1', kind: 'completion', task: 'report', project: 'work', text: 'Quarterly report finished.' },
    { id: 'report:working:2', kind: 'progress', task: 'report', project: 'work', text: 'Quarterly report: checks running.' },
    { id: 'cleanup:done:3', kind: 'completion', task: 'cleanup', project: 'background', text: 'Background cleanup finished.' },
    { id: 'deploy:decision:gate', kind: 'decision', task: 'deploy', project: 'work', key: 'gate',
      text: 'Deploy needs a decision: pick the region.' }
  ];
  h.advance(1);
  await h.refresh(); await h.drain();
  assert.equal(h.sent.filter(x => x.text.includes('Deploy needs a decision')).length, 1);
  assert.ok(!h.sent.some(x => x.text.includes('Quarterly report finished')));
  assert.ok(!h.sent.some(x => x.text.includes('Background cleanup finished')));
  h.advance(900);
  await h.refresh(); await h.drain();
  const digest = h.sent.map(x => x.text).find(x => x.includes('Firstmate digest'));
  assert.match(digest, /Quarterly report finished\./);
  assert.match(digest, /checks running\./);
  assert.ok(!digest.includes('Background cleanup finished'));
  assert.ok(!digest.includes('Deploy needs a decision'));
  // Quiet hours hold newly captured alerts; they release after the window closes.
  await h.receive(h.message('PREF-4', 'quiet 00:00-00:00 UTC'));
  await h.drain();
  h.snapshot.events = [...h.snapshot.events,
    { id: 'restore:failed:4', kind: 'failure', task: 'restore', project: 'work', text: 'Restore job failed.' }];
  h.advance(60);
  await h.refresh(); await h.drain();
  assert.ok(!h.sent.some(x => x.text.includes('Restore job failed')));
  await h.receive(h.message('PREF-5', 'quiet off'));
  await h.drain();
  h.advance(900);
  await h.refresh(); await h.drain();
  const released = h.sent.map(x => x.text).find(x => x.includes('Restore job failed'));
  assert.match(released, /Firstmate digest/);
  assert.match(h.policy.describe(h.policy.preferences()), /quiet off/);
});

test('acceptance: an offline send retries with backoff and one stable remote identity', async t => {
  const h = stack(t);
  h.harness.failSend = true;
  await h.receive(h.message('OFF-1', 'Draft the outage note'));
  const key = h.requestKey('OFF-1');
  assert.equal(h.notes.length, 1); // the Firstmate handoff succeeded; only the phone receipt is pending
  const remoteId = h.outbox()[0].remoteId;
  await h.bridge.flush();
  let job = h.outbox()[0];
  assert.equal(job.attempts, 1);
  assert.ok(job.next >= h.now());
  assert.equal(job.remoteId, remoteId);
  assert.match(h.health().problem, /delivery failed or uncertain/);
  assert.equal(h.store.records('sent').length, 0);
  h.harness.failSend = false;
  h.advance(3);
  await h.bridge.flush();
  assert.equal(h.outbox().length, 0);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].remoteId, remoteId); // same remote message identity across the retry
  assert.match(h.sent[0].text, /received and saved/);
  assert.equal(h.store.records('sent').length, 1);
  const sentReceipt = readJson(h.store.file(`sent/${h.store.records('sent')[0]}`));
  assert.ok(!('requestKey' in sentReceipt)); // a receipt is not a result: no request binding
  assert.equal(h.adapter.requests.get(key).state, 'received'); // receipt delivery is not completion
  // Enqueue dedupe: an identical job is never queued twice.
  h.store.enqueue('Draft the outage note', { kind: 'reply', session: '', id: 'duplicate-check' });
  const retried = h.store.enqueue('Draft the outage note', { kind: 'reply', session: '', id: 'duplicate-check' });
  assert.equal(retried, sha256('reply\n\nduplicate-check'));
  assert.equal(h.outbox().filter(x => x.eventId === 'duplicate-check').length, 1);
});

test('acceptance: an unproved note publication stays inspectable and recovers without a second publication', async t => {
  const h = stack(t);
  h.harness.noteMode = 'silent';
  await h.receive(h.message('UNC-1', 'Restart the failed worker'));
  const key = h.requestKey('UNC-1');
  assert.equal(h.notes.length, 0);
  assert.equal(readJson(h.store.file(`pending/${key}.json`)).uncertain, true);
  assert.equal(readJson(h.store.file(`handoffs/${key}.json`)).phase, 'uncertain');
  assert.equal(h.adapter.requests.get(key).state, 'received');
  assert.match(h.health().problem, /note publication uncertain/);
  assert.equal(h.sent.length, 0);
  // The interrupted helper actually saved its note before dying; recovery adopts
  // the exact saved envelope instead of publishing anything new.
  const receipt = readJson(h.store.file(`handoffs/${key}.json`));
  const id = '1789863544-recovered';
  fs.mkdirSync(path.join(h.fmState, 'inbox'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(h.fmState, 'inbox', `${id}.note`),
    `id=${id}\nat=fixture\nsource=text\n--\n${receipt.body}\n`, { mode: 0o600 });
  h.harness.noteMode = 'save';
  h.advance(3);
  await h.process();
  assert.deepEqual(h.notes, []);
  assert.equal(readJson(h.store.file(`handoffs/${key}.json`)).phase, 'saved');
  assert.deepEqual(h.wakes.at(-1).key, `inbox:${id}`);
  await h.drain();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /received and saved/);
  assert.equal(readJson(h.store.file(`pending/${key}.json`)), null);
});

test('acceptance: the captured inbox-adapter result carries exact request identity and stops after handling', async t => {
  const h = stack(t);
  await h.receive(h.message('ADAPT-1', 'Please verify the deployment'));
  const key = h.requestKey('ADAPT-1');
  const config = { schema: 'firstmate.whatsapp-inbox-config.v1', source_id: 'whatsapp-inbox-main',
    whatsapp_state: h.store.root, fm_home: h.fmHome, fm_state: h.fmState, extension_root: root, poll_ms: 0 };
  const configFile = path.join(h.temp, 'adapter-config.json');
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const request = seq => ({ schema: 'firstmate.extension-request.v1',
    request_id: `sha256:${String(seq).padStart(64, '0')}`,
    extension_id: 'org.firstmate.whatsapp.inbox', extension_version: '1.0.0', host_protocol: 1,
    package_digest: `sha256:${'a'.repeat(64)}`, capability: 'process-event-adapter', capability_version: 1,
    adapter: 'whatsapp-inbox', operation: 'source.poll',
    input: { source_id: config.source_id, config_ref: configFile } });
  const first = await poll(request(1));
  assert.equal(first.status, 'result');
  const event = JSON.parse(first.output);
  assert.equal(event.schema, 'firstmate.whatsapp-inbox-event.v1');
  assert.equal(event.request_id, request(1).request_id);
  assert.deepEqual(event.notes.map(note => note.message_key), [key]);
  assert.equal(event.notes[0].inbox_id, h.notes[0].id);
  assert.equal(event.reply_skill, path.join(root, 'skills/whatsapp-delegate/SKILL.md'));
  assert.equal(event.fm_home, h.fmHome);
  assert.equal(event.delegate_state, h.delegate);
  assert.ok(!first.output.includes('Please verify the deployment')); // wakes carry identity, never phone text
  let cursor = JSON.parse(fs.readFileSync(path.join(h.store.root, 'wake-adapter/whatsapp-inbox-main.json')));
  assert.deepEqual(cursor.pending.keys, [key]);
  // The host captures the exact bytes; the next sequence finds nothing new.
  const captures = path.join(h.fmState, 'procevent-inbox');
  fs.mkdirSync(captures, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(captures, 'whatsapp-inbox-main.1.result'), first.output, { mode: 0o600 });
  fs.writeFileSync(path.join(captures, 'whatsapp-inbox-main.1.adapter'), 'whatsapp-inbox\n', { mode: 0o600 });
  assert.equal((await poll(request(2))).status, 'no-result');
  // The controller drains the note; maintenance records the handled evidence.
  const note = path.join(h.fmState, 'inbox', `${h.notes[0].id}.note`);
  fs.mkdirSync(path.join(h.fmState, 'inbox', 'handled'), { mode: 0o700 });
  fs.renameSync(note, path.join(h.fmState, 'inbox', 'handled', path.basename(note)));
  assert.deepEqual(await h.adapter.maintain({ now: h.now(), staleAfter: 300 }), []);
  assert.equal(readJson(h.store.file(`handoffs/${key}.json`)).phase, 'handled');
  assert.equal(h.adapter.requests.get(key).state, 'picked-up');
  assert.equal((await poll(request(3))).status, 'no-result');
  // A later capture supersedes the pending wake and prunes the handled key,
  // while the still-live request stays suppressed until its own capture.
  await h.receive(h.message('ADAPT-2', 'Please also rotate the keys'));
  const key2 = h.requestKey('ADAPT-2');
  const second = await poll(request(4));
  assert.deepEqual(JSON.parse(second.output).notes.map(note => note.message_key), [key2]);
  fs.writeFileSync(path.join(captures, 'whatsapp-inbox-main.4.result'), second.output, { mode: 0o600 });
  fs.writeFileSync(path.join(captures, 'whatsapp-inbox-main.4.adapter'), 'whatsapp-inbox\n', { mode: 0o600 });
  assert.equal((await poll(request(5))).status, 'no-result');
  cursor = JSON.parse(fs.readFileSync(path.join(h.store.root, 'wake-adapter/whatsapp-inbox-main.json')));
  assert.deepEqual(cursor.seen, [key2]); // the handled receipt is pruned, the live request retained
  assert.equal(cursor.pending, null);
});
