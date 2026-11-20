import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, readJson, writeJson } from '../core.mjs';
import { authenticatedTelegram, configureTelegram, pairedRejection, telegramConfig, telegramStore, TelegramDelegate, TelegramClient,
  TelegramFailure } from '../telegram.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-telegram-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const store = new Store(base, path.join(base, 'private'));
  writeJson(store.file('identity.json'), { account: '15555550123@s.whatsapp.net' });
  const tokenFile = path.join(base, 'token');
  fs.writeFileSync(tokenFile, `123456:${'a'.repeat(30)}`, { mode: 0o600 });
  writeJson(store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true,
    tokenFile, userId: '1234', chatId: '1234', enabledAt: 900, fallbackAfterSeconds: 30, whatsappRoute: store.currentRoute() });
  return { base, store, tokenFile, config: telegramConfig(store) };
}
const update = (changes = {}) => ({ update_id: 2, message: { message_id: 10, date: 999,
  chat: { id: 1234, type: 'private' }, from: { id: 1234, is_bot: false }, text: 'Check the simulation', ...changes } });

test('Telegram admits only the explicitly paired private person and rejects forwards/stale/spoofed input', t => {
  const f = fixture(t);
  assert.ok(authenticatedTelegram(update(), f.config, 1000));
  for (const change of [{ chat: { id: 1234, type: 'group' } }, { from: { id: 999 } },
    { forward_origin: {} }, { date: 800 }, { date: 999999 }, { from: { id: 1234, is_bot: true } },
    { text: '' }, { via_bot: {} }]) assert.equal(authenticatedTelegram(update(change), f.config, 1000), null);
  assert.equal(authenticatedTelegram({ edited_message: update().message }, f.config, 1000), null);
});

test('Telegram configuration keeps tokens private and pins bot and recipient identity', async t => {
  const f = fixture(t);
  assert.equal(telegramStore(f.store).currentRoute().recipient, 'telegram:1234');
  assert.ok(!JSON.stringify(f.config.route).includes('a'.repeat(30)));
  fs.chmodSync(f.tokenFile, 0o644);
  assert.throws(() => telegramConfig(f.store));
  fs.chmodSync(f.tokenFile, 0o600);
  await configureTelegram(f.store, f.tokenFile, '1234', { now: 1000, fetcher: async () =>
    ({ ok: true, text: async () => JSON.stringify({ ok: true, result: { is_bot: true, id: 123456 } }) }) });
  assert.equal(readJson(f.store.file('telegram.json')).enabledAt, 900);
  assert.equal(fs.statSync(f.store.file('telegram.json')).mode & 0o777, 0o600);
});

test('Telegram API errors never reveal the token or remote body', async () => {
  const client = new TelegramClient({ token: 'secret', chatId: '1234' }, async () => { throw new Error('secret'); });
  await assert.rejects(client.send('hi'), error => !error.message.includes('secret'));
});

test('Telegram cursor persists intake before handoff and retries same request without acting twice', async t => {
  const f = fixture(t); let calls = 0, fail = true, now = 1000;
  const client = { updates: async offset => offset > 2 ? [] : [update()], send: async () => 'TG_20' };
  const adapter = { note: async key => { calls++; if (fail) throw new Error('offline'); assert.ok(f.store.incoming(key)); }, status: async () => 'status' };
  const delegate = new TelegramDelegate({ store: f.store, adapter, clientFactory: () => client, clock: () => now });
  await delegate.tick({ connected: true }, { afk: false });
  assert.equal(readJson(f.store.file('telegram-cursor.json')).offset, 3);
  assert.equal(f.store.records('telegram-pending').length, 1);
  fail = false; now += 16;
  await delegate.tick({ connected: true }, { afk: false });
  assert.equal(calls, 2);
  assert.equal(f.store.records('telegram-pending').length, 0);
  assert.equal(f.store.records('sent').length, 1);
  await delegate.tick({ connected: true }, { afk: false });
  assert.equal(calls, 2);
});

test('Fallback waits for WhatsApp outage and retains AFK-only alert gating', async t => {
  const f = fixture(t); let now = 1000; const sends = [];
  const delegate = new TelegramDelegate({ store: f.store, adapter: {}, clock: () => now,
    clientFactory: () => ({ updates: async () => [], send: async text => { sends.push(text); return 'TG_20'; } }) });
  f.store.enqueue('answer', { kind: 'reply', session: '', route: f.store.currentRoute(), fallbackRoute: f.config.route });
  await delegate.tick({ connected: true }, { afk: false });
  now += 10; await delegate.tick({ connected: false }, { afk: false });
  assert.equal(sends.length, 0);
  now += 30; await delegate.tick({ connected: false }, { afk: false });
  assert.equal(sends.length, 1);
  f.store.enqueue('proactive', { session: 'afk-session', fallbackRoute: f.config.route });
  now += 30; await delegate.tick({ connected: false }, { afk: false });
  assert.equal(sends.length, 1);
  await delegate.tick({ connected: false }, { afk: true, session: 'afk-session' });
  assert.equal(sends.length, 2);
});

test('An absent Telegram configuration makes no requests', async t => {
  const f = fixture(t); fs.unlinkSync(f.store.file('telegram.json'));
  const delegate = new TelegramDelegate({ store: f.store, adapter: {}, clientFactory: () => { throw new Error('must not call'); } });
  await delegate.tick({ connected: false }, { afk: false });
  assert.equal(readJson(f.store.file('telegram-health.json')), null);
});

test('fallback cannot adopt unbound old jobs or move a bound reply after token rotation', async t => {
  const f = fixture(t); let now = 1000; const sends = [];
  const delegate = new TelegramDelegate({ store: f.store, adapter: {}, clock: () => now,
    clientFactory: () => ({ updates: async () => [], send: async text => { sends.push(text); return 'TG_30'; } }) });
  f.store.enqueue('old unbound answer', { kind: 'reply', session: '', route: f.store.currentRoute() });
  f.store.enqueue('bound answer', { kind: 'reply', session: '', route: f.store.currentRoute(), fallbackRoute: f.config.route });
  await delegate.tick({ connected: true }, { afk: false });
  fs.writeFileSync(f.tokenFile, `123456:${'b'.repeat(30)}`);
  now += 60; await delegate.tick({ connected: false }, { afk: false });
  assert.equal(sends.length, 0); assert.equal(f.store.records('outbox').length, 2);
});

const media = (fields, changes = {}) => {
  const value = update({ ...changes });
  delete value.message.text;
  Object.assign(value.message, fields);
  return value;
};
const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 7)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const pdf = Buffer.from('%PDF-1.7\nfixture body\n');

test('Telegram media admits only the paired person and the WhatsApp media allowlist and limits', t => {
  const f = fixture(t);
  const voice = authenticatedTelegram(media({ voice: { file_id: 'v1', file_size: 64, duration: 4, mime_type: 'audio/ogg' } }), f.config, 1000);
  assert.deepEqual([voice.media.kind, voice.media.mime, voice.media.fileId, voice.text, voice.caption], ['voice', 'audio/ogg', 'v1', '', '']);
  const photo = authenticatedTelegram(media({ photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'large', file_size: 64 },
    { file_id: 'huge', file_size: 64 * 1024 * 1024 }], caption: 'what is this' }), f.config, 1000);
  assert.deepEqual([photo.media.kind, photo.media.fileId, photo.caption], ['image', 'large', 'what is this']);
  const document = authenticatedTelegram(media({ document: { file_id: 'd1', file_size: 22, mime_type: 'application/pdf', file_name: 'spec.pdf' } }), f.config, 1000);
  assert.deepEqual([document.media.kind, document.media.name], ['document', 'spec.pdf']);
  for (const value of [
    media({ voice: { file_id: 'v1', file_size: 64, duration: 4 } }, { from: { id: 999 } }),
    media({ voice: { file_id: 'v1', file_size: 64, duration: 4 } }, { forward_origin: {} }),
    media({ voice: { file_id: 'v1', file_size: 64, duration: 4 } }, { chat: { id: 1234, type: 'group' } }),
    media({ voice: { file_id: 'v1', file_size: 64 * 1024 * 1024, duration: 4 } }),
    media({ voice: { file_id: 'v1', file_size: 64, duration: 0 } }),
    media({ voice: { file_id: '../../x', file_size: 64, duration: 4 } }),
    media({ document: { file_id: 'd1', file_size: 22, mime_type: 'application/zip' } }),
    media({ document: { file_id: 'd1', file_size: 22, mime_type: 'audio/ogg' } }),
    media({ video: { file_id: 'x', file_size: 20 } }),
    media({ sticker: { file_id: 'x' } }),
    media({ voice: { file_id: 'v1', file_size: 64, duration: 4 }, photo: [{ file_id: 'p', file_size: 9 }] }),
    media({ voice: { file_id: 'v1', file_size: 64, duration: 4 }, caption: '\u0000' })
  ]) assert.equal(authenticatedTelegram(value, f.config, 1000), null);
});

test('Telegram voice note is downloaded, transcribed locally and handed over like WhatsApp media', async t => {
  const f = fixture(t); const notes = []; let downloads = 0;
  const client = {
    updates: async offset => offset > 2 ? [] : [media({ voice: { file_id: 'v1', file_size: ogg.length, duration: 4, mime_type: 'audio/ogg' }, caption: 'please act' })],
    download: async (fileId, maximum) => { downloads++; assert.equal(fileId, 'v1'); assert.ok(maximum >= ogg.length); return [ogg]; },
    send: async () => 'TG_20' };
  const transcribe = async file => { assert.ok(fs.existsSync(file)); return { available: true, text: 'run the nightly' }; };
  const delegate = new TelegramDelegate({ store: f.store, clientFactory: () => client, clock: () => 1000, transcribe,
    adapter: { note: async (key, body) => notes.push(body), status: async () => 'status' } });
  await delegate.tick({ connected: true }, { afk: false });
  assert.equal(downloads, 1);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Telegram voice note received/);
  assert.match(notes[0], /run the nightly/);
  assert.match(notes[0], /Caption from the paired person:\nplease act/);
  const staged = notes[0].match(/Local attachment: (\S+)/)[1];
  assert.ok(staged.startsWith(f.store.file('attachments/incoming/')));
  assert.deepEqual(fs.readFileSync(staged), ogg);
  assert.equal((fs.statSync(staged).mode & 0o777), 0o600);
  assert.equal(f.store.records('telegram-pending').length, 0);
  const everything = fs.readdirSync(f.store.root, { recursive: true }).filter(name => fs.statSync(path.join(f.store.root, name)).isFile())
    .map(name => fs.readFileSync(path.join(f.store.root, name), 'latin1')).join('\n');
  assert.ok(!everything.includes('a'.repeat(30)), 'the bot token never reaches private state');
});

test('Telegram photo and document are staged with WhatsApp magic-byte checks; mismatched bytes are refused', async t => {
  const f = fixture(t); const notes = [];
  let pending = [media({ photo: [{ file_id: 'p1', file_size: jpeg.length }] }, { message_id: 11 }),
    media({ document: { file_id: 'd1', file_size: pdf.length, mime_type: 'application/pdf', file_name: 'spec.pdf' } }, { message_id: 12 })];
  pending = pending.map((value, index) => ({ ...value, update_id: 2 + index }));
  const bytes = { p1: jpeg, d1: pdf };
  const delegate = new TelegramDelegate({ store: f.store, clock: () => 1000,
    clientFactory: () => ({ updates: async offset => pending.filter(value => value.update_id >= offset), download: async id => [bytes[id]], send: async () => 'TG_20' }),
    adapter: { note: async (key, body) => notes.push(body), status: async () => 'status' } });
  await delegate.tick({ connected: true }, { afk: false });
  delegate.lastPoll = -100; await delegate.tick({ connected: true }, { afk: false });
  assert.equal(notes.length, 2);
  assert.match(notes.join('\n'), /Telegram image received[\s\S]*MIME: image\/jpeg/);
  assert.match(notes.join('\n'), /Telegram document received[\s\S]*MIME: application\/pdf/);

  const g = fixture(t); let replies = 0;
  const forged = new TelegramDelegate({ store: g.store, clock: () => 1000,
    clientFactory: () => ({ updates: async offset => offset > 2 ? [] : [media({ photo: [{ file_id: 'p1', file_size: pdf.length }] })],
      download: async () => [pdf], send: async () => 'TG_20' }),
    adapter: { note: async () => { throw new Error('must not hand off forged media'); }, status: async () => 'status' } });
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = fs.existsSync(g.store.file('telegram-pending')) ? g.store.records('telegram-pending')[0] : undefined;
    if (job) { const file = g.store.file(`telegram-pending/${job}`); const value = readJson(file); value.next = 0; writeJson(file, value); }
    await forged.tick({ connected: true }, { afk: false });
  }
  assert.equal(g.store.records('telegram-pending').length, 0);
  replies = ['outbox', 'sent'].flatMap(bucket => fs.existsSync(g.store.file(bucket)) ? g.store.records(bucket).map(name => readJson(g.store.file(`${bucket}/${name}`))) : [])
    .filter(job => /did not match what Telegram declared for it \(content-mismatch\), so it was refused and not kept/.test(job?.text ?? '')).length;
  assert.equal(replies, 1, 'the person is told once after the final failed attempt');
  const [failedName] = g.store.records('telegram-media-failed');
  assert.equal(readJson(g.store.file(`incoming/${failedName}`)).failure.stage, 'content-mismatch');
});

test('Telegram file downloads refuse unsafe paths and oversize files and never reveal the token', async () => {
  const token = `123456:${'z'.repeat(30)}`;
  const reply = result => ({ ok: true, text: async () => JSON.stringify({ ok: true, result }) });
  const seen = [];
  const client = new TelegramClient({ token, chatId: '1234' }, async (url, options) => {
    seen.push(url);
    if (url.endsWith('/getFile')) return reply(JSON.parse(options.body).file_id === 'big' ? { file_path: 'voice/a.oga', file_size: 999 } :
      JSON.parse(options.body).file_id === 'escape' ? { file_path: 'voice/../../etc/passwd', file_size: 5 } : { file_path: 'voice/a.oga', file_size: 5 });
    throw new Error(`network failure for ${url}`);
  });
  await assert.rejects(client.download('big', 100), error => !error.message.includes(token));
  await assert.rejects(client.download('escape', 100), error => !error.message.includes(token));
  await assert.rejects(client.download('ok', 100), error => !error.message.includes(token) && /details omitted/.test(error.message));
  assert.ok(seen.some(url => url.includes('/file/bot')), 'the download used the Bot API file endpoint');
  await assert.rejects(client.download('../x', 100));
});

const queuedTexts = store => ['outbox', 'sent'].flatMap(bucket => fs.existsSync(store.file(bucket)) ?
  store.records(bucket).map(name => readJson(store.file(`${bucket}/${name}`))?.text ?? '') : []);
const privateText = store => fs.readdirSync(store.root, { recursive: true })
  .filter(name => fs.statSync(path.join(store.root, name)).isFile())
  .map(name => fs.readFileSync(path.join(store.root, name), 'latin1')).join('\n');

test('a failed Telegram download records its stage, keeps the file locator and tells the person what happened', async t => {
  const f = fixture(t); const logs = []; let now = 1000, downloads = 0;
  const delegate = new TelegramDelegate({ store: f.store, clock: () => now, log: line => logs.push(line),
    clientFactory: () => ({
      updates: async offset => offset > 552 ? [] : [media({ voice: { file_id: 'v552', file_size: 4096, duration: 9, mime_type: 'audio/ogg' } },
        { message_id: 552 })].map(value => ({ ...value, update_id: 552 })),
      download: async () => { downloads++; throw new TelegramFailure('Telegram request failed; details omitted', 'getfile-timeout'); },
      send: async () => 'TG_553' }),
    adapter: { note: async () => { throw new Error('a failed download must not be handed over'); }, status: async () => 'status' } });
  for (let tick = 0; tick < 4; tick++) { await delegate.tick({ connected: true }, { afk: false }); now += 400; }
  assert.equal(downloads, 3);
  assert.equal(f.store.records('telegram-pending').length, 0);
  const [name] = f.store.records('telegram-media-failed');
  const retained = readJson(f.store.file(`telegram-media-failed/${name}`));
  assert.equal(retained.media.fileId, 'v552', 'the still-valid Telegram file id is kept for inspection or retry');
  assert.deepEqual(retained.mediaFailures.map(entry => entry.stage), ['getfile-timeout', 'getfile-timeout', 'getfile-timeout']);
  assert.equal(retained.failure.staged, null);
  const receipt = readJson(f.store.file(`incoming/${name}`));
  assert.deepEqual([receipt.operation, receipt.failure.stage, receipt.failure.kind, receipt.failure.mime, receipt.failure.size],
    ['media-failed', 'getfile-timeout', 'voice', 'audio/ogg', 4096]);
  assert.equal(readJson(f.store.file('telegram-health.json')).lastMediaFailure.stage, 'getfile-timeout');
  const replies = queuedTexts(f.store).filter(text => /attachment/.test(text));
  assert.equal(replies.length, 1);
  assert.match(replies[0], /could not download that attachment from Telegram \(getfile-timeout\), so nothing was saved here/);
  assert.doesNotMatch(replies[0], /retained/, 'nothing was downloaded, so nothing is claimed to be retained');
  assert.equal(logs.length, 3);
  assert.match(logs[2], /^Telegram attachment TG_552 \(voice audio\/ogg, 4096 bytes\) failed at getfile-timeout \(attempt 3\/3\)$/);
  assert.ok(!privateText(f.store).includes('a'.repeat(30)), 'the bot token never reaches private state');
});

test('a failure after staging says the download is retained', async t => {
  const f = fixture(t); let now = 1000;
  const delegate = new TelegramDelegate({ store: f.store, clock: () => now,
    transcribe: async () => { throw new Error('transcriber crashed'); },
    clientFactory: () => ({ updates: async offset => offset > 2 ? [] : [media({ voice: { file_id: 'v1', file_size: ogg.length, duration: 4, mime_type: 'audio/ogg' } })],
      download: async () => [ogg], send: async () => 'TG_20' }),
    adapter: { note: async () => { throw new Error('must not hand off'); }, status: async () => 'status' } });
  for (let tick = 0; tick < 4; tick++) { await delegate.tick({ connected: true }, { afk: false }); now += 400; }
  const [name] = f.store.records('telegram-media-failed');
  const retained = readJson(f.store.file(`telegram-media-failed/${name}`));
  assert.equal(retained.failure.stage, 'describe-failed');
  assert.ok(retained.failure.staged.startsWith(f.store.file('attachments/incoming/')));
  assert.match(queuedTexts(f.store).join('\n'), /could not prepare it locally \(describe-failed\)\. The download is retained privately for inspection\./);
});

test('Telegram client failures carry a closed stage and never the token or remote text', async () => {
  const token = `123456:${'q'.repeat(30)}`;
  const answer = (result, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(result) });
  const client = scenario => new TelegramClient({ token, chatId: '1234' }, async (url, options) => {
    if (url.endsWith('/getFile')) return scenario.getFile(options);
    return scenario.file(options);
  }, { timeouts: { request: 20, download: 20 } });
  const neverAnswers = options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  const fileOk = answer({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: 5 } });
  const stageOf = async scenario => {
    try { const body = await client(scenario).download('AwACAgEAAxk', 100); for await (const chunk of body) void chunk; return 'ok'; }
    catch (error) {
      assert.ok(!error.message.includes(token) && !/temporarily|Bad Request/.test(error.message));
      return error.stage;
    }
  };
  assert.equal(await stageOf({ getFile: neverAnswers }), 'getfile-timeout');
  assert.equal(await stageOf({ getFile: async () => answer({ ok: false, error_code: 400, description: 'Bad Request: file is temporarily unavailable' }, 400) }),
    'getfile-refused-400-temporarily-unavailable');
  assert.equal(await stageOf({ getFile: async () => answer({ ok: false, error_code: 400, description: 'Bad Request: file is too big' }, 400) }),
    'getfile-refused-400-too-big');
  assert.equal(await stageOf({ getFile: async () => { throw new TypeError('fetch failed'); } }), 'getfile-network');
  assert.equal(await stageOf({ getFile: async () => answer({ ok: true, result: { file_path: 'voice/file_1.oga' } }) }), 'file-metadata-size-missing');
  assert.equal(await stageOf({ getFile: async () => answer({ ok: true, result: { file_path: 'voice/file 1.oga', file_size: 5 } }) }), 'file-metadata-path');
  assert.equal(await stageOf({ getFile: async () => answer({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: 500 } }) }), 'file-metadata-size-over');
  assert.equal(await stageOf({ getFile: async () => fileOk, file: neverAnswers }), 'download-timeout');
  assert.equal(await stageOf({ getFile: async () => fileOk, file: async () => ({ ok: false, status: 404 }) }), 'download-http-404');
  assert.equal(await stageOf({ getFile: async () => fileOk, file: async () => ({ ok: true, status: 200,
    body: (async function* broken() { yield Buffer.from('Og'); throw new Error(`reset while reading ${token}`); })() }) }), 'download-stream');
  assert.equal(await stageOf({ getFile: async () => fileOk, file: async () => ({ ok: true, status: 200, body: [Buffer.from('OggS!')] }) }), 'ok');
});

test('paired-person messages that cannot be accepted are explained once; everyone else stays unanswered', async t => {
  const f = fixture(t); const logs = [];
  const voice = { file_id: 'v1', file_size: 64, duration: 4, mime_type: 'audio/ogg' };
  const updates = [
    media({ voice }, { message_id: 11, forward_origin: { type: 'user' } }),
    media({ audio: { file_id: 'a1', file_size: 64, duration: 4, mime_type: 'audio/x-m4a', file_name: 'memo.m4a' } }, { message_id: 12 }),
    media({ document: { file_id: 'd1', file_size: 64, mime_type: 'audio/mpeg', file_name: 'memo.mp3' } }, { message_id: 13 }),
    media({ sticker: { file_id: 's1' } }, { message_id: 14 }),
    media({ voice }, { message_id: 15, from: { id: 999, is_bot: false } }),
    media({ voice }, { message_id: 16, date: 800 }),
    update({ message_id: 17, text: '[Firstmate] echo' })
  ].map((value, index) => ({ ...value, update_id: 20 + index }));
  const delegate = new TelegramDelegate({ store: f.store, clock: () => 1000, log: line => logs.push(line),
    clientFactory: () => ({ updates: async () => updates, send: async () => 'TG_30' }),
    adapter: { note: async () => { throw new Error('refused input must not be handed over'); }, status: async () => 'status' } });
  await delegate.tick({ connected: true }, { afk: false });
  // Redelivery after a lost cursor must not explain the same message twice.
  fs.rmSync(f.store.file('telegram-cursor.json')); delegate.lastPoll = -100;
  await delegate.tick({ connected: true }, { afk: false });
  const replies = queuedTexts(f.store).filter(text => text.startsWith('Not accepted:'));
  assert.equal(replies.length, 4);
  assert.match(replies.join('\n'), /Forwarded messages are not accepted/);
  assert.match(replies.join('\n'), /That audio format is not supported/);
  assert.match(replies.join('\n'), /Audio sent as a file is not accepted/);
  assert.match(replies.join('\n'), /That kind of message is not supported here/);
  const reasons = f.store.records('incoming').map(name => readJson(f.store.file(`incoming/${name}`)))
    .filter(receipt => receipt.operation === 'unsupported').map(receipt => receipt.reason).sort();
  assert.deepEqual(reasons, ['audio-as-file', 'audio-format', 'forwarded', 'unsupported']);
  assert.equal(f.store.records('telegram-pending').length, 0);
  assert.equal(logs.length, 4);
});

test('paired-person refusal reasons cover limits, formats and captions', t => {
  const f = fixture(t);
  const reason = (fields, changes) => pairedRejection(media(fields, changes), f.config, 1000);
  assert.equal(reason({ voice: { file_id: 'v', file_size: 64 * 1024 * 1024, duration: 4 } }), 'too-large');
  assert.equal(reason({ voice: { file_id: 'v', file_size: 64, duration: 0 } }), 'too-short');
  assert.equal(reason({ voice: { file_id: 'v', file_size: 64, duration: 4000 } }), 'too-long');
  assert.equal(reason({ video: { file_id: 'x', file_size: 64, duration: 4, mime_type: 'video/x-matroska' } }), 'video-format');
  assert.equal(reason({ document: { file_id: 'd', file_size: 64, mime_type: 'video/mp4' } }), 'video-as-file');
  assert.equal(reason({ document: { file_id: 'd', file_size: 64, mime_type: 'application/zip' } }), 'file-format');
  assert.equal(reason({ voice: { file_id: 'v', file_size: 64, duration: 4 }, caption: '\u0000' }), 'caption-invalid');
  assert.equal(reason({ voice: { file_id: 'v', file_size: 64, duration: 4 } }, { via_bot: { id: 5 } }), 'via-bot');
  assert.equal(reason({ voice: { file_id: 'v', file_size: 64, duration: 4 } }), null, 'acceptable media is not refused');
  assert.equal(pairedRejection(update({ text: '' }), f.config, 1000), 'text-invalid');
  assert.equal(reason({ story: { id: 1 } }), 'unsupported');
  assert.equal(reason({ pinned_message: { message_id: 3 } }), null, 'service events stay silent');
});
