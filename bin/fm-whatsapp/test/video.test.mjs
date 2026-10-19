import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, ownIdentity, writeJson, readJson } from '../core.mjs';
import { retainPrivateState } from '../retention.mjs';
import { MEDIA_LIMITS, authenticateMediaMetadata, authenticatedMediaMessage, inboundMediaText, stageInboundMedia } from '../media.mjs';
import { authenticatedTelegram, telegramConfig, TelegramDelegate } from '../telegram.mjs';
import { VIDEO_LIMITS, VIDEO_CONFIG_SCHEMA, parseFfmpegMediaInfo, frameTimestamps, describeVideoMedia, readVideoSidecar } from '../video.mjs';

const user = { id: '15555550123:2@s.whatsapp.net', lid: '12345:1@lid' };
const identity = ownIdentity(user);
const ftyp = Buffer.from([0, 0, 0, 0x20]); // box size, then the brand
const mp4 = Buffer.concat([ftyp, Buffer.from('ftypisom'), Buffer.alloc(64, 3)]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 9)]);
const mov = Buffer.concat([ftyp, Buffer.from('ftypqt  '), Buffer.alloc(32, 5)]);
const junk = Buffer.concat([Buffer.from('NOTVIDEO at all'), Buffer.alloc(32, 1)]);
const PROBE = { durationSeconds: 61, width: 1280, height: 720, hasAudio: true, codec: 'h264' };

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-video-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new Store(home, path.join(home, 'state'));
  writeJson(store.file('identity.json'), { ...identity, pairedAt: 1000 });
  const route = { account: identity.account, recipient: identity.account };
  writeJson(store.file('recipient.json'), { account: identity.account });
  return { home, store, route };
}
function whatsappVideo(body, key = {}) {
  return { key: { id: 'VID1', remoteJid: identity.account, fromMe: true, ...key }, messageTimestamp: 1001,
    message: { videoMessage: body } };
}
const hooks = ({ probe = async () => PROBE, frames = 3, transcribe = async () => ({ available: true, text: 'check the log' }) } = {}) => ({
  probe,
  extractFrames: async (input, targets, timestamps) => targets.slice(0, frames).map((target, index) => {
    fs.writeFileSync(target, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16, 1)]), { mode: 0o600 });
    return { path: target, at: timestamps[index] ?? 0, bytes: 19 };
  }),
  transcribe
});

test('ffmpeg banner facts are parsed into bounded media info', t => {
  const banner = ['Input #0, mov,mp4 from clip:', '  Duration: 00:01:01.50, start: 0.000000, bitrate: 1000 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (High) 1920x1080 [SAR 1:1]', '  Stream #0:1[0x2](und): Audio: aac 44100 Hz'].join('\n');
  const info = parseFfmpegMediaInfo(banner);
  assert.deepEqual([info.width, info.height, info.codec, info.hasAudio], [1920, 1080, 'h264', true]);
  assert.ok(Math.abs(info.durationSeconds - 61.5) < 0.001);
  const silent = parseFfmpegMediaInfo(banner.replace(/Audio:.*/g, ''));
  assert.equal(silent.hasAudio, false);
  assert.equal(parseFfmpegMediaInfo(banner.replace(/Duration:.*/, '')), null);
  assert.equal(parseFfmpegMediaInfo(''), null);
  assert.equal(parseFfmpegMediaInfo('no stream facts here'), null);
  const long = parseFfmpegMediaInfo(banner.replace('00:01:01.50', '05:00:00.00'));
  assert.equal(long.durationSeconds, MEDIA_LIMITS.videoSeconds);
});

test('frame timestamps sample interior spans, deduplicate and guard bad durations', t => {
  assert.deepEqual(frameTimestamps(60, 3), [10, 30, 50]);
  assert.deepEqual(frameTimestamps(0, 3), [0]);
  assert.deepEqual(frameTimestamps(-4, 3), [0]);
  assert.deepEqual(frameTimestamps(1, 3).length >= 1, true);
  const deduped = frameTimestamps(0.02, 3);
  assert.equal(new Set(deduped).size, deduped.length);
});

test('WhatsApp video messages authenticate with bounded duration and dimensions before download', t => {
  const { store } = fixture(t);
  const body = { mimetype: 'video/mp4', fileLength: mp4.length, seconds: 61, width: 1280, height: 720 };
  const metadata = authenticateMediaMetadata(whatsappVideo(body), identity, 1010, 1000, null);
  assert.equal(metadata.kind, 'video');
  assert.deepEqual([metadata.duration, metadata.width, metadata.height, metadata.mime], [61, 1280, 720, 'video/mp4']);
  assert.match(metadata.name, /^video-VID1/);
  const rejected = [
    whatsappVideo({ ...body, fileLength: MEDIA_LIMITS.video + 1 }), // over the 20 MB bound
    whatsappVideo({ ...body, seconds: 0 }),
    whatsappVideo({ ...body, seconds: MEDIA_LIMITS.videoSeconds + 1 }),
    whatsappVideo({ ...body, mimetype: 'video/x-msvideo' }),
    whatsappVideo({ ...body, mimetype: 'video/avi' }),
    whatsappVideo({ ...body, contextInfo: { isForwarded: true } }),
    whatsappVideo({ ...body, viewOnce: true })
  ];
  for (const candidate of rejected) assert.equal(authenticateMediaMetadata(candidate, identity, 1010, 1000, null), null);
});

test('video magic bytes are enforced for every allowed container and mismatches leave no residue', async t => {
  const { store } = fixture(t);
  for (const [bytes, mime] of [[mp4, 'video/mp4'], [webm, 'video/webm'], [mov, 'video/quicktime']]) {
    const attachment = await stageInboundMedia(store, [bytes], { kind: 'video', mime, size: bytes.length, name: `clip-${mime}` });
    assert.equal(attachment.kind, 'video');
    assert.equal(attachment.size, bytes.length);
    assert.equal(fs.statSync(attachment.path).mode & 0o777, 0o600);
    assert.ok(attachment.path.startsWith(store.file('attachments/incoming/')));
  }
  await assert.rejects(stageInboundMedia(store, [junk], { kind: 'video', mime: 'video/mp4', size: junk.length, name: 'fake.mp4' }), /MIME/);
  await assert.rejects(stageInboundMedia(store, [junk], { kind: 'video', mime: 'video/webm', size: junk.length, name: 'fake.webm' }), /MIME/);
  assert.equal(fs.readdirSync(store.file('attachments/incoming')).filter(name => name.startsWith('.')).length, 0);
});

test('the 20 MB bound is enforced on declared metadata and on the staged stream', async t => {
  const { store } = fixture(t);
  const exact = Buffer.alloc(MEDIA_LIMITS.video, 2);
  exact.subarray(4, 8).set(Buffer.from('ftyp'));
  const at = authenticateMediaMetadata(whatsappVideo({ mimetype: 'video/mp4', fileLength: exact.length, seconds: 30 }), identity, 1010, 1000, null);
  assert.ok(at);
  const attachment = await stageInboundMedia(store, [exact], { kind: 'video', mime: 'video/mp4', size: exact.length, name: 'big.mp4' });
  assert.equal(attachment.size, MEDIA_LIMITS.video);
  await assert.rejects(stageInboundMedia(store, [Buffer.concat([exact, Buffer.from('x')])],
    { kind: 'video', mime: 'video/mp4', size: exact.length, name: 'big.mp4' }), /declared/);
  await assert.rejects(authenticatedMediaMessage(whatsappVideo({ mimetype: 'video/mp4', fileLength: exact.length, seconds: 30 }),
    identity, 1010, 1000, null, { store, download: async function* () { yield exact; yield Buffer.from('over'); }, ...hooks() }), /declared/);
});

test('a full video handoff stages frames, transcript and sidecar privately with explicit facts', async t => {
  const { store } = fixture(t);
  let transcriptions = 0;
  const accepted = await authenticatedMediaMessage(
    whatsappVideo({ mimetype: 'video/mp4', fileLength: mp4.length, seconds: 61, width: 640, height: 360, fileName: 'clip.mp4' }),
    identity, 1010, 1000, null, { store, download: async () => [mp4], video: hooks({
      transcribe: async () => { transcriptions++; return { available: true, text: 'the deploy is stuck' }; } }) });
  assert.equal(transcriptions, 1);
  assert.match(accepted.text, /WhatsApp video received \(remote; away mode unchanged\)/);
  assert.match(accepted.text, /MIME: video\/mp4; bytes: \d+\.\nDuration: 61s; dimensions: 1280x720; audio track: present\./);
  assert.match(accepted.text, /Representative keyframes staged privately \(sampled stills; motion between frames is not analyzed/);
  assert.match(accepted.text, /Frame 1 of 3 \(at 0:10\): /);
  assert.match(accepted.text, /Local transcript of the audio \(read completely\): /);
  assert.match(accepted.text, /Bounded transcript preview \(start\):\nthe deploy is stuck\nBounded transcript preview \(end\)\./);
  assert.equal(accepted.attachment.name, 'clip.mp4');
  const digest = accepted.attachment.digest;
  const transcript = store.file(`attachments/incoming/${digest}.transcript.txt`);
  const sidecar = store.file(`attachments/incoming/${digest}.video.json`);
  assert.equal(fs.readFileSync(transcript, 'utf8'), 'the deploy is stuck');
  assert.equal(fs.statSync(transcript).mode & 0o777, 0o600);
  const record = readVideoSidecar(sidecar);
  assert.equal(record.schema, VIDEO_CONFIG_SCHEMA);
  assert.deepEqual([record.durationSeconds, record.width, record.height, record.hasAudio], [61, 1280, 720, true]);
  assert.equal(record.frames.length, 3);
  assert.ok(fs.existsSync(record.frames[0].path));
  for (const frame of [...record.frames.map(f => f.path), transcript, sidecar, accepted.attachment.path]) {
    assert.ok(fs.realpathSync(frame).startsWith(fs.realpathSync(store.root)), `artifact escaped the private store: ${frame}`);
    assert.equal(fs.statSync(frame).mode & 0o777, 0o600);
  }
  assert.ok(!accepted.text.includes('nothing to transcribe'));
});

test('a corrupt or undecodable clip still hands off with an explicit failure note and no derived files', async t => {
  const { store } = fixture(t);
  const accepted = await authenticatedMediaMessage(
    whatsappVideo({ mimetype: 'video/mp4', fileLength: mp4.length, seconds: 10 }),
    identity, 1010, 1000, null, { store, download: async () => [mp4],
      video: hooks({ probe: async () => null, transcribe: async () => { throw new Error('must not transcribe'); } }) });
  assert.match(accepted.text, /Video inspection failed locally \(the clip may be corrupt or in an unsupported container\)/);
  const digest = accepted.attachment.digest;
  assert.ok(!fs.existsSync(store.file(`attachments/incoming/${digest}.video.json`)));
  assert.ok(!fs.existsSync(store.file(`attachments/incoming/${digest}.transcript.txt`)));
  assert.ok(fs.existsSync(accepted.attachment.path), 'the bounded video attachment is retained privately');
});

test('missing local ffmpeg configuration degrades the video block without blocking the request', async t => {
  const { store } = fixture(t);
  const attachment = await stageInboundMedia(store, [mp4], { kind: 'video', mime: 'video/mp4', size: mp4.length, name: 'clip.mp4' });
  let extracted = 0;
  const text = await inboundMediaText(store, attachment,
    { kind: 'video', mime: 'video/mp4', size: mp4.length, duration: 61, width: 0, height: 0, name: 'clip.mp4' },
    { transcribe: async () => { throw new Error('must not transcribe'); },
      video: { extractFrames: async () => { extracted++; return []; } } });
  assert.match(text, /Video inspection is unavailable; configure private offline ffmpeg and whisper\.cpp paths/);
  assert.match(text, /Local attachment: /);
  assert.equal(extracted, 0);
  assert.equal(fs.readdirSync(store.file('attachments/incoming')).filter(name => name.endsWith('.video.json')).length, 0);
});

test('a silent video skips transcription and says the audio track is absent', async t => {
  const { store } = fixture(t);
  const attachment = await stageInboundMedia(store, [mp4], { kind: 'video', mime: 'video/mp4', size: mp4.length, name: 'clip.mp4' });
  const text = await inboundMediaText(store, attachment,
    { kind: 'video', mime: 'video/mp4', size: mp4.length, duration: 61, width: 1280, height: 720, name: 'clip.mp4' },
    { video: hooks({ probe: async () => ({ ...PROBE, hasAudio: false }),
      transcribe: async () => { throw new Error('must not transcribe a silent clip'); } }) });
  assert.match(text, /audio track: absent/);
  assert.match(text, /The video has no audio track, so there is nothing to transcribe\./);
  assert.ok(!text.includes('Local transcript'));
});

test('when transcription fails the failure is explicit and frames still carry the clip', async t => {
  const { store } = fixture(t);
  const attachment = await stageInboundMedia(store, [mp4], { kind: 'video', mime: 'video/mp4', size: mp4.length, name: 'clip.mp4' });
  const text = await inboundMediaText(store, attachment,
    { kind: 'video', mime: 'video/mp4', size: mp4.length, duration: 61, width: 0, height: 0, name: 'clip.mp4' },
    { video: hooks({ probe: async () => ({ ...PROBE, width: 0, height: 0 }),
      transcribe: async () => ({ available: false, message: 'Voice transcription failed locally.' }) }) });
  assert.match(text, /dimensions: unknown/);
  assert.match(text, /Voice transcription failed locally\./);
  assert.match(text, /Frame 1 of 3/);
});

test('Telegram admits video and video notes on the same bounds and refuses other motion media', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-video-tg-admit-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const store = new Store(base, path.join(base, 'private'));
  writeJson(store.file('identity.json'), { account: '15555550123@s.whatsapp.net' });
  const tokenFile = path.join(base, 'token');
  fs.writeFileSync(tokenFile, `123456:${'c'.repeat(30)}`, { mode: 0o600 });
  writeJson(store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true,
    tokenFile, userId: '1234', chatId: '1234', enabledAt: 900, fallbackAfterSeconds: 30, whatsappRoute: store.currentRoute() });
  const config = telegramConfig(store);
  const update = (fields, changes = {}) => ({ update_id: 2, message: { message_id: 10, date: 999,
    chat: { id: 1234, type: 'private' }, from: { id: 1234, is_bot: false }, ...changes, ...fields } });
  const video = authenticatedTelegram(update({ video: { file_id: 'vid', file_size: mp4.length, duration: 61, width: 1280, height: 720, mime_type: 'video/mp4' } }), config, 1000);
  assert.equal(video.media.kind, 'video');
  assert.deepEqual([video.media.fileId, video.media.duration, video.media.width, video.media.height, video.media.name], ['vid', 61, 1280, 720, 'video-TG_10.mp4']);
  const note = authenticatedTelegram(update({ video_note: { file_id: 'note', file_size: mp4.length, duration: 30 } }), config, 1000);
  assert.deepEqual([note.media.kind, note.media.mime, note.media.name], ['video', 'video/mp4', 'video-note-TG_10.mp4']);
  const webmVideo = authenticatedTelegram(update({ video: { file_id: 'w', file_size: webm.length, duration: 5, mime_type: 'video/webm', file_name: 'clip.webm' } }), config, 1000);
  assert.equal(webmVideo.media.name, 'clip.webm');
  const rejected = [
    update({ video: { file_id: 'vid', file_size: MEDIA_LIMITS.video + 1, duration: 5 } }),
    update({ video: { file_id: 'vid', file_size: mp4.length, duration: 0 } }),
    update({ video: { file_id: 'vid', file_size: mp4.length, duration: MEDIA_LIMITS.videoSeconds + 1 } }),
    update({ video: { file_id: 'vid', file_size: mp4.length, duration: 5, mime_type: 'video/x-msvideo' } }),
    update({ video: { file_id: '../../etc', file_size: mp4.length, duration: 5 } }),
    update({ video: { file_id: 'vid', file_size: mp4.length, duration: 5 }, animation: { file_id: 'a', file_size: 9, duration: 2 } }),
    update({ animation: { file_id: 'a', file_size: 9, duration: 2 } }),
    update({ sticker: { file_id: 's', file_size: 9 } })
  ];
  for (const candidate of rejected) assert.equal(authenticatedTelegram(candidate, config, 1000), null);
});

test('Telegram video downloads, inspects and hands off through the ordinary note path', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-video-tg-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const store = new Store(base, path.join(base, 'private'));
  writeJson(store.file('identity.json'), { account: '15555550123@s.whatsapp.net' });
  const tokenFile = path.join(base, 'token');
  fs.writeFileSync(tokenFile, `123456:${'c'.repeat(30)}`, { mode: 0o600 });
  writeJson(store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true,
    tokenFile, userId: '1234', chatId: '1234', enabledAt: 900, fallbackAfterSeconds: 30, whatsappRoute: store.currentRoute() });
  const notes = []; let downloads = 0;
  const client = {
    updates: async offset => offset > 2 ? [] : [{ update_id: 2, message: { message_id: 10, date: 999,
      chat: { id: 1234, type: 'private' }, from: { id: 1234, is_bot: false },
      video: { file_id: 'vid', file_size: mp4.length, duration: 61, width: 1280, height: 720, mime_type: 'video/mp4' }, caption: 'watch this' } }],
    download: async (fileId, maximum) => { downloads++; assert.ok(maximum >= MEDIA_LIMITS.video); return [mp4]; },
    send: async () => 'TG_20' };
  const delegate = new TelegramDelegate({ store, clientFactory: () => client, clock: () => 1000, video: hooks(),
    adapter: { note: async (key, body) => notes.push(body), status: async () => 'status' } });
  await delegate.tick({ connected: true }, { afk: false });
  assert.equal(downloads, 1);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Telegram video received/);
  assert.match(notes[0], /Duration: 61s; dimensions: 1280x720; audio track: present/);
  assert.match(notes[0], /Frame 1 of 3 \(at 0:10\): /);
  assert.match(notes[0], /Caption from the paired person:\nwatch this/);
  const frame = notes[0].match(/Frame 1 of 3 \(at 0:10\): (\S+)/)[1];
  assert.ok(fs.realpathSync(frame).startsWith(fs.realpathSync(store.root)));
  assert.equal(store.records('telegram-pending').length, 0);
});

test('retention removes an unreferenced video family and protects any member a record still names', t => {
  const { store } = fixture(t);
  fs.mkdirSync(store.file('attachments/incoming'), { recursive: true, mode: 0o700 });
  const now = 3_000_000_000;
  const digestLive = 'a'.repeat(64), digestGone = 'b'.repeat(64), digestNamed = 'c'.repeat(64);
  const incoming = store.file('attachments/incoming');
  const family = digest => [`${digest}`, `${digest}.json`, `${digest}.transcript.txt`, `${digest}.video.json`,
    `${digest}.frame-1.jpg`, `${digest}.frame-2.jpg`];
  for (const digest of [digestLive, digestGone, digestNamed]) {
    for (const name of family(digest)) {
      const file = path.join(incoming, name);
      fs.writeFileSync(file, name === digest ? 'blob' : 'derived', { mode: 0o600 });
      fs.utimesSync(file, new Date(0), new Date(0)); // older than any horizon
    }
  }
  // A handoff envelope still names one keyframe of digestNamed: the whole family stays.
  fs.mkdirSync(store.file('handoffs'), { mode: 0o700 });
  writeJson(store.file(`handoffs/${digestNamed}.json`), { phase: 'handled', body: `video received\nFrame 1 of 3 (at 0:10): ${path.join(incoming, `${digestNamed}.frame-1.jpg`)}` });
  const report = retainPrivateState(store, null, { now });
  assert.equal(report.attachments, 2); // only the two unreferenced families
  for (const name of [...family(digestLive), ...family(digestGone)]) assert.ok(!fs.existsSync(path.join(incoming, name)), name);
  for (const name of family(digestNamed)) assert.ok(fs.existsSync(path.join(incoming, name)), name);
  // Orphaned derived artifacts whose blob is already gone age out on their own.
  const orphan = path.join(incoming, `${'d'.repeat(64)}.frame-1.jpg`);
  fs.writeFileSync(orphan, 'orphan', { mode: 0o600 });
  fs.utimesSync(orphan, new Date(0), new Date(0));
  retainPrivateState(store, null, { now });
  assert.ok(!fs.existsSync(orphan));
});

test('describeVideoMedia rejects unusable inputs and guards its limits', async t => {
  const { store } = fixture(t);
  const withoutConfig = await describeVideoMedia(store, { path: '/nonexistent/clip.mp4', digest: 'e'.repeat(64) });
  assert.equal(withoutConfig.available, false);
  assert.match(withoutConfig.message, /Video inspection is unavailable/);
  assert.equal(VIDEO_LIMITS.frames, 3);
  assert.ok(VIDEO_LIMITS.maxFrameBytes > 0 && VIDEO_LIMITS.maxDimension >= 640);
});

const BANNER = ['Input #0, mov,mp4 from clip:', '  Duration: 00:01:00.00, start: 0.000000, bitrate: 1000 kb/s',
  '  Stream #0:0[0x1](und): Video: h264 1280x720', '  Stream #0:1[0x2](und): Audio: aac 44100 Hz'].join('\n');

test('a poisoned transcript is refused at composition and never reaches the note path', async t => {
  const { store } = fixture(t);
  const attachment = await stageInboundMedia(store, [mp4], { kind: 'video', mime: 'video/mp4', size: mp4.length, name: 'clip.mp4' });
  const text = await inboundMediaText(store, attachment,
    { kind: 'video', mime: 'video/mp4', size: mp4.length, duration: 61, width: 0, height: 0, name: 'clip.mp4' },
    { video: hooks({ transcribe: async () => ({ available: true, text: 'bad\u0000text' }) }) });
  assert.match(text, /Audio transcription returned no usable text\./);
  assert.ok(!fs.existsSync(store.file(`attachments/incoming/${attachment.digest}.transcript.txt`)));
  assert.match(text, /Frame 1 of 3/); // frames still carry the clip
});

function voiceConfigFixture(t, store) {
  const home = store.root;
  const ffmpeg = path.join(home, 'ffmpeg-fake'), whisper = path.join(home, 'whisper-fake'), model = path.join(home, 'model.bin');
  fs.writeFileSync(ffmpeg, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(whisper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(model, 'weights', { mode: 0o600 });
  writeJson(store.file('voice.json'), { schema: 'fm-whatsapp-voice.v1', ffmpeg, whisper, model, language: 'en' });
  fs.chmodSync(store.file('voice.json'), 0o600);
  return { ffmpeg, whisper, model };
}

test('default hooks shape real ffmpeg argv: banner probe, interior seeks, bounded frames', async t => {
  const { home, store } = fixture(t);
  const { ffmpeg } = voiceConfigFixture(t, store);
  fs.mkdirSync(store.file('attachments/incoming'), { recursive: true, mode: 0o700 });
  const input = path.join(home, 'clip.mp4'); fs.writeFileSync(input, mp4, { mode: 0o600 });
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args.includes('-frames:v')) { fs.writeFileSync(args.at(-1), Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { mode: 0o600 }); return { stdout: '', stderr: '' }; }
    return { code: 1, stdout: '', stderr: BANNER }; // `ffmpeg -i` without an output exits nonzero after printing facts
  };
  const digest = 'f'.repeat(64);
  const result = await describeVideoMedia(store, { path: input, digest }, { run, transcribe: async () => ({ available: false, message: 'no transcription in this test' }) });
  assert.equal(result.available, true);
  assert.deepEqual([result.info.durationSeconds, result.info.width, result.info.height, result.info.hasAudio], [60, 1280, 720, true]);
  assert.equal(calls[0].file, ffmpeg);
  assert.deepEqual(calls[0].args.slice(0, 3), ['-nostdin', '-hide_banner', '-i']);
  assert.equal(result.frames.length, 3);
  for (const frame of result.frames) assert.equal(fs.statSync(frame.path).mode & 0o777, 0o600);
  const extract = calls.filter(call => call.args.includes('-frames:v'));
  assert.deepEqual(extract.map(call => call.args.at(-1)), result.frames.map(frame => frame.path));
  for (const call of extract) {
    assert.equal(call.args[0], '-nostdin');
    assert.equal(call.args[call.args.indexOf('-ss') + 1], String(result.frames[extract.indexOf(call)].at));
    assert.equal(call.args.indexOf('-vf') > 0, true);
    assert.match(call.args[call.args.indexOf('-vf') + 1], /^scale=min\(1280\\,iw\):min\(1280\\,ih\):force_original_aspect_ratio=decrease$/);
    assert.ok(call.options.timeout <= VIDEO_LIMITS.frameTimeoutMs);
  }
  assert.match(result.transcript.message, /no transcription in this test/);
});

test('a seek failure falls back to the first frame and a refused frame is simply absent', async t => {
  const { home, store } = fixture(t);
  voiceConfigFixture(t, store);
  fs.mkdirSync(store.file('attachments/incoming'), { recursive: true, mode: 0o700 });
  const input = path.join(home, 'clip.mp4'); fs.writeFileSync(input, mp4, { mode: 0o600 });
  let seeks = 0;
  const run = async (file, args) => {
    if (!args.includes('-frames:v')) return { code: 1, stdout: '', stderr: BANNER };
    if (args.includes('-ss')) { seeks++; throw new Error('seek failed'); } // every seek fails; fall back to frame 0
    fs.writeFileSync(args.at(-1), Buffer.from([0xff, 0xd8, 0xff]), { mode: 0o600 });
    return { stdout: '', stderr: '' };
  };
  const result = await describeVideoMedia(store, { path: input, digest: '1'.repeat(64) },
    { run, transcribe: async () => ({ available: false, message: 'x' }) });
  assert.equal(seeks, 3);
  assert.equal(result.frames.length, 3);
  for (const frame of result.frames) assert.equal(frame.at, 0);
  // An extractor that produces nothing yields an explicit no-frames note.
  const empty = await describeVideoMedia(store, { path: input, digest: '2'.repeat(64) },
    { run: async (file, args) => args.includes('-frames:v') ? { stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: BANNER },
      transcribe: async () => ({ available: false, message: 'x' }) });
  assert.equal(empty.frames.length, 0);
});
