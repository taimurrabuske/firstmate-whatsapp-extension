import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Store, Bridge, writeJson, readJson, sha256 } from '../core.mjs';
import { NotificationPolicy } from '../notifications.mjs';
import { MediaIntake } from '../media-intake.mjs';
import { FirstmateAdapter } from '../firstmate.mjs';
import { outboundContent } from '../media.mjs';
import { loadVoiceConfig, transcribeVoice, VOICE_CONFIG_SCHEMA } from '../voice.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-seams-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new Store(home, path.join(home, 'private'));
  const user = { id: '15555550123:1@s.whatsapp.net' };
  const peer = { account: '15555550999@s.whatsapp.net', aliases: ['15555550999@s.whatsapp.net'] };
  writeJson(store.file('recipient.json'), { account: peer.account });
  return { home, store, user, peer };
}

test('digest decisions expire independently while a queued completion survives refresh and quiet hours', async t => {
  const f = fixture(t), policy = new NotificationPolicy(f.store.root), sent = [];
  let now = 1000;
  const snapshot = { schema: 'fm-whatsapp-events.v1', afk: true, session: 's', events: [] };
  const bridge = new Bridge({ store: f.store, peer: f.peer, clock: () => now, notificationPolicy: policy,
    events: async () => snapshot, inbox: async () => {}, status: async () => '',
    send: async (_jid, text) => { sent.push(text); return true; } });
  bridge.connect(f.user);
  policy.command('digest 1'); policy.command('alerts decisions urgent off');
  await bridge.refresh();
  snapshot.events = [
    { id: 'done', kind: 'completion', task: 'a', project: 'p', text: 'Result ready' },
    { id: 'choice', kind: 'decision', key: 'k', task: 'b', project: 'p', text: 'Select a value' }
  ];
  await bridge.refresh(); now += 61; await bridge.refresh();
  assert.equal(f.store.records('outbox').length, 2);
  const decision = f.store.records('outbox').map(x => readJson(f.store.file(`outbox/${x}`))).find(x => x.event?.kind === 'decision');
  assert.equal(decision.event.key, 'k');
  policy.command('quiet 00:00-00:00 UTC');
  snapshot.events = snapshot.events.filter(x => x.kind !== 'decision');
  await bridge.refresh(); await bridge.flush();
  assert.equal(f.store.records('outbox').length, 1); assert.equal(sent.length, 0);
  policy.command('quiet off'); await bridge.flush();
  assert.equal(sent.length, 1); assert.match(sent[0], /Result ready/);
  assert.ok(!sent[0].includes('Select a value'));
});

test('media intake survives restart, rejects other numbers before download, and hands off once', async t => {
  const f = fixture(t), notes = []; let downloads = 0;
  const bridge = new Bridge({ store: f.store, peer: f.peer, clock: () => 1010,
    events: async () => ({ schema: 'fm-whatsapp-events.v1', afk: false, session: '', events: [] }),
    inbox: async (_key, text) => notes.push(text), status: async () => '', send: async () => true });
  bridge.connect(f.user);
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('image')]);
  const candidate = remoteJid => ({ key: { id: 'MEDIA', remoteJid, fromMe: false }, messageTimestamp: 1011,
    message: { imageMessage: { mimetype: 'image/png', fileLength: png.length } } });
  const options = { store: f.store, bridge, clock: () => 1015, encode: x => Buffer.from(JSON.stringify(x)),
    decode: x => JSON.parse(x.toString()), download: async () => { downloads++; return png; } };
  new MediaIntake(options).stage({ type: 'notify', messages: [candidate('15555550777@s.whatsapp.net'), candidate(f.peer.account)] });
  assert.equal(downloads, 0); assert.equal(f.store.records('media-pending').length, 1);
  await new MediaIntake(options).processOne(); await bridge.processPending();
  assert.equal(downloads, 1); assert.equal(notes.length, 1); assert.match(notes[0], /Local attachment:/);
  const replay = new MediaIntake(options);
  replay.stage({ type: 'notify', messages: [candidate(f.peer.account)] }); await replay.processOne();
  assert.equal(downloads, 1); assert.equal(f.store.records('media-pending').length, 0);
});

function voiceFixture(t, f) {
  const bin = name => { const file = path.join(f.home, name); fs.writeFileSync(file, '#!/bin/false\n', { mode: 0o700 }); return file; };
  const config = { schema: VOICE_CONFIG_SCHEMA, ffmpeg: bin('ffmpeg'), whisper: bin('whisper-cli'),
    model: path.join(f.home, 'model.bin'), language: 'en' };
  fs.writeFileSync(config.model, 'fake model', { mode: 0o600 });
  writeJson(f.store.file('voice.json'), config);
  const loaded = loadVoiceConfig(f.store);
  assert.equal(loaded.available, true);
  return loaded;
}
function voiceMessage(f, id, seconds = 30, caption) {
  return { key: { id, remoteJid: f.peer.account, fromMe: false }, messageTimestamp: 1011,
    message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 13, seconds, ptt: true, ...(caption ? { caption } : {}) } } };
}
function voiceIntake(f, bridge, run) {
  return { store: f.store, bridge, clock: () => 1015, encode: x => Buffer.from(JSON.stringify(x)),
    decode: x => JSON.parse(x.toString()), download: async () => Buffer.from('OggSvoicenote'),
    transcribe: file => transcribeVoice(file, { store: f.store, run }) };
}

test('a transcribed voice note carries the authenticated instruction end to end without any caption', async t => {
  const f = fixture(t), notes = [];
  const config = voiceFixture(t, f);
  const transcriptText = 'Pause the build lane, then summarize the failing test.';
  const run = async (file, args) => {
    if (file === config.ffmpeg) fs.writeFileSync(args.at(-1), 'RIFFwav');
    else fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.txt`, `${transcriptText}\n`);
    return { stdout: '', stderr: '' };
  };
  const bridge = new Bridge({ store: f.store, peer: f.peer, clock: () => 1010,
    events: async () => ({ schema: 'fm-whatsapp-events.v1', afk: false, session: '', events: [] }),
    inbox: async (_key, text) => notes.push(text), status: async () => '', send: async () => true });
  bridge.connect(f.user);
  const options = voiceIntake(f, bridge, run);
  new MediaIntake(options).stage({ type: 'notify',
    messages: [voiceMessage(f, 'VOICE1', 30, 'caption text is never a command')] });
  await new MediaIntake(options).processOne(); await bridge.processPending();
  assert.equal(notes.length, 1);
  const note = notes[0];
  assert.match(note, /Authenticated instruction \(local whisper\.cpp transcript of this voice note/);
  assert.match(note, /Pause the build lane, then summarize the failing test\./);
  assert.ok(!note.includes('caption text is never a command'));
  assert.ok(note.length <= 3500);
  const transcriptFile = /Full private transcript \(read completely\): (.+)$/m.exec(note)?.[1];
  assert.equal(fs.readFileSync(transcriptFile, 'utf8'), transcriptText);
  assert.equal(fs.statSync(transcriptFile).mode & 0o777, 0o600);
  assert.equal(f.store.records('media-pending').length, 0);
  // Redelivery of the same voice note is deduplicated; the transcript is delivered once.
  new MediaIntake(options).stage({ type: 'notify', messages: [voiceMessage(f, 'VOICE1', 30)] });
  await new MediaIntake(options).processOne(); await bridge.processPending();
  assert.equal(notes.length, 1);
});

test('failed voice transcription delivers an explicit non-command result and keeps the note private', async t => {
  const f = fixture(t), notes = [];
  const config = voiceFixture(t, f);
  const run = async (file, args) => {
    if (file === config.ffmpeg) { fs.writeFileSync(args.at(-1), 'RIFFwav'); return { stdout: '', stderr: '' }; }
    throw new Error('secret whisper stderr');
  };
  const bridge = new Bridge({ store: f.store, peer: f.peer, clock: () => 1010,
    events: async () => ({ schema: 'fm-whatsapp-events.v1', afk: false, session: '', events: [] }),
    inbox: async (_key, text) => notes.push(text), status: async () => '', send: async () => true });
  bridge.connect(f.user);
  const options = voiceIntake(f, bridge, run);
  new MediaIntake(options).stage({ type: 'notify', messages: [voiceMessage(f, 'VOICE2')] });
  await new MediaIntake(options).processOne(); await bridge.processPending();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Voice transcription failed locally/);
  assert.ok(!notes[0].includes('Authenticated instruction'));
  assert.ok(!notes[0].includes('.transcript.txt'));
  assert.ok(!notes[0].includes('secret'));
  // The original bounded private voice attachment remains available for inspection.
  const kept = fs.readdirSync(f.store.file('attachments/incoming')).filter(n => !n.endsWith('.json'));
  assert.equal(kept.length, 1); assert.ok(fs.statSync(f.store.file(`attachments/incoming/${kept[0]}`)).size > 0);
  assert.equal(f.store.records('media-pending').length, 0);
});

test('maintenance reuses the captured process-event wake and never re-rings explicitly working requests', async t => {
  const f = fixture(t), calls = [], key = sha256('request');
  writeJson(f.store.file('identity.json'), { account: '15555550123@s.whatsapp.net' });
  const state = path.join(f.home, 'state');
  fs.mkdirSync(path.join(state, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(state, 'procevent-inbox'));
  const adapter = new FirstmateAdapter({ home: f.home, codeRoot: f.home, state, store: f.store,
    extensionRoot: f.home, run: async (_file, args) => { calls.push(args); return ''; } });
  const body = adapter.envelope(key, 'run checks');
  const note = path.join(state, 'inbox/note-1.note');
  fs.writeFileSync(note, `id=note-1\n--\n${body}\n`);
  writeJson(path.join(state, 'procevent-inbox/whatsapp-inbox-main.7.result'), {
    schema: 'firstmate.whatsapp-inbox-event.v1', fm_state: state, notes: [{ inbox_id: 'note-1', inbox_path: note }] });
  writeJson(f.store.file(`handoffs/${key}.json`), { phase: 'saved', id: 'note-1', route: f.store.currentRoute(),
    body, created: 1, binding: { home: f.home, state, codeRoot: f.home } });
  adapter.requests.receive(key, { route: f.store.currentRoute(), text: 'run checks' });
  await adapter.maintain({ now: 1000, staleAfter: 10 });
  assert.equal(calls.length, 1); assert.equal(calls[0].at(-2), 'procevent:whatsapp-inbox-main:7');
  adapter.progress(key, 'working', 'Checking results');
  await adapter.maintain({ now: 2000, staleAfter: 10 }); assert.equal(calls.length, 1);
  adapter.reply(key, 'Checks complete'); assert.equal(adapter.requests.get(key).state, 'completed');
});

test('reply-file CLI stages a request-bound immutable report and the bridge delivers its media payload', async t => {
  const f = fixture(t), key = sha256('report-request'), sends = [];
  const state = path.join(f.home, 'state');
  const bridge = new Bridge({ store: f.store, peer: f.peer, clock: () => 1000,
    events: async () => ({ schema: 'fm-whatsapp-events.v1', afk: false, session: '', events: [] }),
    inbox: async () => {}, status: async () => '', send: async (jid, text, _id, job) => {
      sends.push({ jid, payload: outboundContent({ ...job, text }, f.store) }); return true;
    } });
  bridge.connect(f.user);
  fs.mkdirSync(f.store.file('handoffs'), { mode: 0o700 });
  writeJson(f.store.file(`handoffs/${key}.json`), { phase: 'saved', id: 'report-note', route: f.store.currentRoute(),
    binding: { home: f.home, codeRoot: f.home, state } });
  const source = path.join(f.home, 'report.pdf'); fs.writeFileSync(source, '%PDF-1.7\noriginal');
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'reply-file', key, source], {
    input: 'Requested report', encoding: 'utf8', env: { ...process.env, FM_HOME: f.home,
      FM_CODE_ROOT: f.home, FM_STATE_OVERRIDE: state, FM_DELEGATE_STATE: path.dirname(f.store.root) } });
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(source, 'source changed after queueing');
  await bridge.flush();
  assert.equal(sends.length, 1); assert.equal(sends[0].jid, f.peer.account);
  assert.equal(fs.readFileSync(sends[0].payload.document.url, 'utf8'), '%PDF-1.7\noriginal');
  assert.equal(sends[0].payload.caption, '[Firstmate] Requested report');
  assert.equal(f.store.records('sent').length, 1);
});
