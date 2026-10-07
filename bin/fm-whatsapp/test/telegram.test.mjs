import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, readJson, writeJson } from '../core.mjs';
import { authenticatedTelegram, configureTelegram, telegramConfig, telegramStore, TelegramDelegate, TelegramClient } from '../telegram.mjs';

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
    .filter(job => /could not process that attachment/.test(job?.text ?? '')).length;
  assert.equal(replies, 1, 'the person is told once after the final failed attempt');
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
