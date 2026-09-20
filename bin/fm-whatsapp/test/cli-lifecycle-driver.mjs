// Drives the real cli.mjs `run` lifecycle in-process against a fake Baileys
// transport and a fake Telegram API. Emits one DRIVER_RESULT line on stderr
// from a process exit hook so results survive the CLI's own process.exit.
// Usage: node --experimental-test-module-mocks cli-lifecycle-driver.mjs <scenario>
import { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, writeJson, readJson, epoch } from '../core.mjs';
import { configureTelegram, telegramConfig } from '../telegram.mjs';

const scenario = process.argv[2] ?? 'logout';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-cli-lifecycle-'));

const home = path.join(base, 'home'), code = path.join(base, 'code'), state = path.join(base, 'state');
for (const dir of [home, code, state]) fs.mkdirSync(dir);
process.env.FM_HOME = home; process.env.FM_CODE_ROOT = code; process.env.FM_STATE_OVERRIDE = state;
process.env.FM_DELEGATE_STATE = path.join(base, 'delegate');
process.umask(0o077);

const summary = {
  scenario, timelineComplete: false, socketCount: 0, sent: 0, outbox: 0,
  health: null, telegramHealth: null, telegramCalls: [], cliLogs: []
};

const trace = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);
process.on('exit', () => {
  try {
    summary.sent = store.records('sent').length;
    summary.outbox = store.records('outbox').length;
    summary.health = readJson(store.file('health.json'));
    summary.telegramHealth = readJson(store.file('telegram-health.json'));
    summary.telegramCalls = telegramCalls;
    fs.rmSync(base, { recursive: true, force: true });
  } catch { }
  try { fs.writeSync(2, `DRIVER_RESULT ${JSON.stringify(summary)}\n`); } catch { }
});
const originalStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => { summary.cliLogs.push(String(chunk).trim()); return originalStderr(chunk, ...rest); };

const store = new Store(home, path.join(base, 'delegate'));
// An authenticated WhatsApp identity from the previous pairing survives re-pair.
writeJson(store.file('identity.json'), { account: '15555550123@s.whatsapp.net', pairedAt: epoch() - 5000 });

const telegramCalls = [];
globalThis.fetch = async url => {
  telegramCalls.push(String(url).replace(/bot[^/]+\//, 'bot**/').split('/').pop());
  if (String(url).includes('getUpdates')) return { ok: true, text: async () => JSON.stringify({ ok: true, result: [] }) };
  return { ok: true, text: async () => JSON.stringify({ ok: true, result: { is_bot: true, id: 123456, message_id: 7, chat: { id: 1234 } } }) };
};

const tokenFile = path.join(base, 'token');
fs.writeFileSync(tokenFile, `123456:${'a'.repeat(30)}`, { mode: 0o600 });
let fallbackRoute = null;
if (scenario !== 'unconfigured') {
  await configureTelegram(store, tokenFile, '1234', { now: epoch() - 4000 });
  fallbackRoute = telegramConfig(store).route;
}
store.enqueue('the answer text', { kind: 'reply', session: '', route: store.currentRoute(), fallbackRoute });
// The outage predates the run start, so the fallback gate is already open.
if (fallbackRoute) writeJson(store.file('telegram-offline.json'), { since: epoch() - 9999 });

let handlers = {};
const makeWASocket = () => {
  const ev = { on: (name, fn) => { (handlers[name] ??= []).push(fn); } };
  const ws = { on: (name, fn) => { (handlers[`ws:${name}`] ??= []).push(fn); } };
  summary.socketCount += 1;
  return {
    ws, ev, user: { id: '15555550123:1@s.whatsapp.net' },
    signalRepository: { lidMapping: { getLIDForPN: async () => null } },
    sendMessage: async (jid, _content, opts) => ({ key: { id: opts?.messageId, remoteJid: jid, fromMe: true } }),
    end: () => { }
  };
};
const emit = (name, payload) => { for (const fn of handlers[name] ?? []) fn(payload); };
const fakeBaileys = {
  default: makeWASocket,
  useMultiFileAuthState: async dir => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { state: { creds: { me: { id: '15555550123:1@s.whatsapp.net', name: 'lifecycle' } } },
      saveCreds: async () => { } };
  },
  DisconnectReason: { connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, timedOut: 408,
    loggedOut: 401, badSession: 500, restartRequired: 515, multideviceMismatch: 411, forbidden: 403, unavailableService: 503 },
  downloadMediaMessage: async () => { throw new Error('unused'); },
  proto: { WebMessageInfo: { encode: () => ({ finish: () => Buffer.from([]) }), decode: () => ({}) } }
};
mock.module('@whiskeysockets/baileys', { namedExports: fakeBaileys, defaultExport: fakeBaileys.default });
mock.module('qrcode-terminal', { defaultExport: { generate: (_c, _o, cb) => cb('qr') }, namedExports: {} });
mock.module('qrcode-terminal/vendor/QRCode/index.js', { defaultExport: function QRCode() { }, namedExports: {} });
mock.module('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js', { defaultExport: { M: 0 }, namedExports: { M: 0 } });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
process.argv[1] = new URL('../cli.mjs', import.meta.url).pathname;
process.argv[2] = 'run';
import(new URL('../cli.mjs', import.meta.url).pathname).catch(error => { trace(`cli import failed: ${error.message}`); });
await sleep(300);

if (scenario === 'startup-qr') {
  // run starts while WhatsApp already demands pairing: rotating QRs, a QR-timeout
  // close that takes the reconnect disposition, and a second socket still unpaired.
  emit('connection.update', { qr: 'QR-1' });
  await sleep(200);
  emit('connection.update', { qr: 'QR-2' });
  await sleep(200);
  emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  await sleep(1400); // reconnect timer (1s backoff) creates the second socket
  emit('connection.update', { qr: 'QR-3' });
  await sleep(3600); // interval tick services the fallback
} else if (scenario === 'logout') {
  // Connected run loses its linked session: QR challenge then a loggedOut close.
  emit('connection.update', { connection: 'open' });
  await sleep(300);
  emit('connection.update', { qr: 'QR-PAYMENT-REQUIRED' });
  await sleep(200);
  emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await sleep(4000);
} else if (scenario === 'token-blip') {
  // Explicitly configured fallback whose token file is unreadable at the exact
  // pairing moment; readable again before the next interval tick must deliver.
  fs.chmodSync(tokenFile, 0o644);
  emit('connection.update', { qr: 'QR-WHILE-TOKEN-UNREADABLE' });
  await sleep(2300);
  fs.chmodSync(tokenFile, 0o600);
  await sleep(4000);
} else if (scenario === 'recovery') {
  // A QR challenge that resolves without re-pairing: the same session reconnects.
  emit('connection.update', { connection: 'open' });
  await sleep(200);
  emit('connection.update', { qr: 'QR-CHALLENGE' });
  await sleep(200);
  emit('connection.update', { connection: 'open' });
  await sleep(900);
} else { // unconfigured
  emit('connection.update', { connection: 'open' });
  await sleep(300);
  emit('connection.update', { qr: 'QR-NO-FALLBACK' });
  await sleep(3000); // only reached if the bridge wrongly stays alive
}
summary.timelineComplete = true;
process.exit(0); // deterministic end: the CLI's interval handles would otherwise linger
