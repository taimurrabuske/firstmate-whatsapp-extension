#!/usr/bin/env node
// CLI owner: explicit home, private linked-device auth, lifecycle, and subprocess boundaries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirstmateAdapter } from './firstmate.mjs';
import { Acknowledgements, Bridge, Store, readJson, writeJson, delegateState, verifyHomeBinding, ownIdentity, canonicalJid, authenticatedMessage, validText, epoch, MAX_TEXT, validateSnapshot } from './core.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const help = `Usage: FM_HOME=/absolute/home bin/fm-whatsapp.sh <command>
  pair [--qr-file /absolute/file]  Display a QR (SVG when file ends .svg), exit after linking.
  run                            Run the self-chat bridge until stopped with SIGINT/SIGTERM.
  status                         Print private bridge health without connecting.
  notify                         Queue stdin text for the enabled delegate's current AFK session.
  enable                         Opt in to alerts while Firstmate is away (requires live bridge).
  disable                        Disable alerts; preserve credentials and saved notes.
  recipient +COUNTRYNUMBER|self   Select the one allowed chat (bridge must be stopped).
  ping                           Queue a connection-test greeting to the selected chat.
  help                           Show this help.
Requires Node >=20; install the pinned transport with npm ci --prefix bin/fm-whatsapp.
FM_CODE_ROOT selects existing Firstmate scripts (default FM_HOME).
FM_STATE_OVERRIDE selects Firstmate state only, never bridge credentials.
Bridge records use FM_DELEGATE_STATE or XDG_STATE_HOME/firstmate-whatsapp/<home-hash>/whatsapp.
Without XDG_STATE_HOME, ~/.local/state is used. State is bound to canonical FM_HOME.
Only the configured recipient's private conversation is accepted; default is Message Yourself.
Commands: !fm status, !fm help, !fm note TEXT; replies to sent Firstmate messages become notes.
Stop never logs the device out. Unlink it in WhatsApp's Linked devices when retiring it.
Pending sends remain queued on failure; remote acceptance does not prove a human read.
A remote-send/local-receipt crash can duplicate a notification, never create approval authority.
No model service is used. Pairing uses an unofficial linked-device client.
`;

export function connectionDisposition(code, reasons) {
  return [reasons.loggedOut, reasons.badSession, reasons.connectionReplaced, reasons.forbidden]
    .filter(Number.isFinite).includes(code) ? 'stop' : 'reconnect';
}
export function reconnectDelay(attempt) { return Math.min(60000, 1000 * 2 ** Math.min(attempt, 6)); }
export function safeHealth(state, now = epoch()) {
  const data = readJson(path.join(state, 'whatsapp/health.json'));
  const fresh = Number.isFinite(data?.updated_epoch) && data.updated_epoch <= now + 5 && data.updated_epoch >= now - 60;
  return { connected: data?.connected === true && fresh, fresh: Boolean(fresh),
    updated_epoch: data?.updated_epoch ?? null, queued: data?.queued ?? 0,
    pending: data?.pending ?? 0, uncertain: data?.uncertain ?? 0,
    problem: fresh ? (data.problem || '') : 'bridge is not running or health is stale' };
}
function parseArgs(argv) {
  const command = argv.shift() || 'help';
  let qrFile, recipient;
  if (command === 'recipient' && argv.length === 1) {
    recipient = argv.shift();
    if (recipient !== 'self' && !/^\+[1-9]\d{7,14}$/.test(recipient)) throw new Error('use an international phone number');
  }
  if (command === 'pair' && argv[0] === '--qr-file' && argv.length === 2) {
    qrFile = argv[1]; argv = [];
    if (!path.isAbsolute(qrFile)) throw new Error('QR file must be an absolute path');
  }
  if (argv.length || (command === 'recipient' && !recipient) || !['pair', 'run', 'status', 'notify', 'enable', 'disable', 'recipient', 'ping', 'help', '--help'].includes(command)) throw new Error('invalid command; use help');
  return { command, qrFile, recipient };
}
export function qrSvg(code) {
  const size = code.getModuleCount(), edge = size + 8;
  let cells = '';
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    if (code.isDark(row, col)) cells += `M${col + 4},${row + 4}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 ${edge} ${edge}" shape-rendering="crispEdges"><rect width="${edge}" height="${edge}" fill="white"/><path d="${cells}" fill="black"/></svg>\n`;
}
function writeQr(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}
async function main(argv) {
  process.umask(0o077);
  const { command, qrFile, recipient } = parseArgs(argv);
  if (command === 'help' || command === '--help') { process.stdout.write(help); return; }
  const home = process.env.FM_HOME;
  if (!home || !path.isAbsolute(home)) throw new Error('set FM_HOME to an absolute operational home');
  const state = delegateState(home);
  verifyHomeBinding(state, home);
  const firstmateState = process.env.FM_STATE_OVERRIDE || path.join(home, 'state');
  const codeRoot = process.env.FM_CODE_ROOT || home;
  if (!path.isAbsolute(firstmateState) || !path.isAbsolute(codeRoot)) throw new Error('Firstmate state and code root must be absolute');
  if (command === 'status') { process.stdout.write(`${JSON.stringify(safeHealth(state))}\n`); return; }
  const store = new Store(home, state);
  if (command === 'recipient') {
    const unlock = store.lock();
    try {
      if (store.records('outbox').length || store.records('pending').length) throw new Error('resolve queued messages before changing recipient');
      writeJson(store.file('recipient.json'), { account: recipient === 'self' ? null : `${recipient.slice(1)}@s.whatsapp.net` });
      process.stdout.write('recipient configured; start the bridge\n');
    } finally { unlock(); }
    return;
  }
  if (command === 'ping') {
    if (!safeHealth(state).connected) throw new Error('bridge must be connected');
    store.enqueue('Firstmate is connected to this number. Reply with !fm status to check the connection, or !fm note followed by your instruction.', { kind: 'reply', session: '' });
    process.stdout.write('connection test queued\n'); return;
  }
  if (command === 'enable' || command === 'disable') {
    if (command === 'enable' && !safeHealth(state).connected) throw new Error('bridge is not connected; run it before enabling');
    writeJson(store.file('enabled.json'), { enabled: command === 'enable' });
    process.stdout.write(`${command === 'enable' ? 'enabled' : 'disabled'}\n`); return;
  }
  const adapter = new FirstmateAdapter({ home, codeRoot, state: firstmateState, store, extensionRoot: root });
  const events = () => adapter.events();
  if (command === 'notify') {
    const chunks = []; let count = 0;
    for await (const chunk of process.stdin) {
      count += chunk.length;
      if (count > MAX_TEXT * 4) throw new Error('message too long');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    const current = validateSnapshot(await events());
    if (!current.afk) throw new Error('the delegate must be enabled and Firstmate away; nothing queued');
    const key = store.enqueue(text, { session: current.session });
    process.stdout.write(`queued ${key}\n`); return;
  }
  const release = store.lock();
  let socket, interval, reconnect, done, stopped = false, attempt = 0, qrShown = false;
  let serial = Promise.resolve();
  let pending = 0; let ticking = false;
  let bridge;
  const acknowledgements = new Acknowledgements();
  const finish = new Promise(resolve => { done = resolve; });
  const log = text => process.stderr.write(`fm-whatsapp: ${text}\n`);
  const clearQr = () => { if (qrFile && qrShown) { try { fs.unlinkSync(qrFile); } catch (error) { if (error.code !== 'ENOENT') log('could not remove QR artifact'); } } };
  const stop = reason => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval); clearTimeout(reconnect);
    acknowledgements.disconnect();
    socket?.end(new Error('local bridge stopped'));
    clearQr();
    if (bridge) bridge.disconnect(reason);
    done();
  };
  const enqueue = action => {
    if (pending >= 100) { log('input queue is full; retry the note after recovery'); return false; }
    pending += 1;
    serial = serial.then(async () => { if (!stopped) await action(); }).catch(() => {
      // Never render vendor exceptions: they can contain message content or credentials.
      if (bridge) { bridge.problem = 'bridge operation failed; inspect local health and retry'; bridge.health(); }
      log('operation failed; private messages and credentials omitted');
    }).finally(() => { pending -= 1; });
    return true;
  };
  const onSignal = () => stop('stopped');
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    // libsignal bypasses the configured Baileys logger and can print key material.
    // Our own diagnostics use explicit sanitized process.stderr writes below.
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) console[method] = () => {};
    let makeWASocket, useMultiFileAuthState, DisconnectReason, qr, QRCode, qrLevel;
    try {
      ({ default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import('@whiskeysockets/baileys'));
      qr = (await import('qrcode-terminal')).default;
      QRCode = (await import('qrcode-terminal/vendor/QRCode/index.js')).default;
      qrLevel = (await import('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js')).default;
    } catch { throw new Error('transport dependency unavailable; run npm ci --prefix bin/fm-whatsapp'); }
    const auth = await useMultiFileAuthState(store.file('auth'));
    // QR pairing establishes creds.me; `registered` belongs to the separate
    // phone-number pairing flow and can remain false after a successful QR link.
    if (command === 'run') ownIdentity(auth.state.creds.me);
    const recipientConfig = readJson(store.file('recipient.json'));
    const peerAccount = recipientConfig?.account;
    if (peerAccount && (!canonicalJid(peerAccount)?.endsWith('@s.whatsapp.net') || canonicalJid(peerAccount) !== peerAccount)) throw new Error('invalid recipient configuration');
    const peer = peerAccount && peerAccount !== canonicalJid(auth.state.creds.me?.id) ? { account: peerAccount, aliases: [peerAccount] } : null;
    bridge = new Bridge({ store, events, peer,
      inbox: (key, text) => adapter.note(key, text),
      status: () => adapter.status(),
      send: async (jid, text, messageId) => {
        if (!socket || stopped) return false;
        // Resolve the recipient's authenticated PN/LID mapping before sending,
        // so either form of server acknowledgement can be matched exactly.
        if (bridge.peer) {
          const lid = canonicalJid(await socket.signalRepository.lidMapping.getLIDForPN(bridge.peer.account));
          if (lid?.endsWith('@lid') && !bridge.peer.aliases.includes(lid)) bridge.peer.aliases.push(lid);
        }
        const waiter = acknowledgements.register(messageId, bridge.peer ?? bridge.identity);
        try {
          const response = await socket.sendMessage(jid, { text }, { messageId });
          if (response?.key?.id !== messageId) throw new Error('unexpected local send identity');
          return await waiter.promise;
        } catch { waiter.cancel(); return false; }
      } });
    bridge.disconnect('connecting');
    const silent = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
    const connect = () => {
      if (stopped) return;
      const current = makeWASocket({ auth: auth.state, logger: silent, markOnlineOnConnect: false,
        syncFullHistory: false, shouldSyncHistoryMessage: () => false,
        browser: ['Firstmate', 'Desktop', '0.1.0'], connectTimeoutMs: 20000, defaultQueryTimeoutMs: 20000 });
      socket = current;
      let currentState = 'connecting';
      current.ws.on('CB:ack,class:message', node => {
        if (socket === current && currentState === 'open' && !stopped) acknowledgements.observeNode(node);
      });
      current.ev.on('messages.update', updates => {
        if (socket === current && currentState === 'open' && !stopped) acknowledgements.observe(updates);
      });
      current.ev.on('creds.update', () => enqueue(async () => {
        if (socket !== current) return;
        await auth.saveCreds();
        if (bridge.connected) bridge.connect(auth.state.creds.me);
      }));
      current.ev.on('messages.upsert', batch => {
        if (socket !== current || currentState !== 'open' || command !== 'run' || stopped) return;
        try {
          const identity = bridge.peer ?? bridge.identity;
          const diagnostics = (batch.messages ?? []).slice(0, 10).map(message => ({
            fromMe: message.key?.fromMe,
            remoteMatches: identity?.aliases.includes(canonicalJid(message.key?.remoteJid)),
            alternateMatches: identity?.aliases.includes(canonicalJid(message.key?.remoteJidAlt)),
            keyFields: Object.keys(message.key ?? {}),
            fields: Object.keys(message.message ?? {}),
            contextFields: Object.keys(message.message?.extendedTextMessage?.contextInfo ?? {}),
            timestampRecent: Number(message.messageTimestamp) >= bridge.pairedAt,
            timestampAge: epoch() - Number(message.messageTimestamp),
            idValid: /^[A-Za-z0-9_-]{1,128}$/.test(message.key?.id ?? ''),
            optionalAddresses: ['participant', 'participantAlt'].map(field => ({ field,
              absent: message.key?.[field] == null, empty: message.key?.[field] === '',
              matches: identity?.aliases.includes(canonicalJid(message.key?.[field])) })),
            textValid: validText(message.message?.conversation ?? message.message?.extendedTextMessage?.text),
            recognizedCommand: /^!fm\s+(status|help|note)(?:\s|$)/i.test(message.message?.conversation ?? message.message?.extendedTextMessage?.text ?? ''),
            authenticated: Boolean(authenticatedMessage(message, bridge.identity, epoch(), bridge.pairedAt, bridge.peer)),
            stubType: message.messageStubType ?? null
          }));
          writeJson(store.file('receive-health.json'), { at: epoch(), type: batch.type, messages: diagnostics });
          bridge.stage(batch);
        }
        catch { bridge.problem = 'incoming capture failed; retry message'; bridge.health(); }
        enqueue(() => bridge.processPending());
      });
      current.ev.on('connection.update', update => {
        if (socket !== current || stopped) return;
        if (update.connection) currentState = update.connection;
        if (update.qr) {
          if (command !== 'pair') { stop('pairing required'); return; }
          qr.generate(update.qr, { small: true }, rendered => {
            try {
              if (qrFile) {
                let artifact = rendered;
                if (qrFile.endsWith('.svg')) {
                  const code = new QRCode(-1, qrLevel.M); code.addData(update.qr); code.make();
                  artifact = qrSvg(code);
                }
                writeQr(qrFile, artifact);
              } else process.stdout.write(`${rendered}\n`);
            } catch { log('QR artifact could not be written'); stop('QR publication failed'); return; }
            qrShown = true;
            log(qrFile ? 'QR artifact ready; scan it with WhatsApp Linked devices' : 'scan the QR with WhatsApp Linked devices');
          });
        }
        if (update.connection === 'open') {
          // Publish the authenticated identity synchronously: a following upsert
          // must be staged even while a previous helper is still in the queue.
          try { bridge.connect(current.user ?? auth.state.creds.me); }
          catch { log('authenticated account identity refused'); stop('account identity refused'); return; }
          attempt = 0; clearQr();
          enqueue(async () => {
            if (socket !== current || currentState !== 'open' || stopped) return;
            if (command === 'pair') {
              await auth.saveCreds();
              log('device linked; run the bridge before enabling WhatsApp alerts');
              stop('paired; run bridge to receive messages');
            } else {
              log('connected to the selected private chat');
              if (bridge.peer) {
                const lid = canonicalJid(await current.signalRepository.lidMapping.getLIDForPN(bridge.peer.account));
                if (lid?.endsWith('@lid') && !bridge.peer.aliases.includes(lid)) bridge.peer.aliases.push(lid);
              }
              await bridge.refresh();
            }
          });
        }
        if (update.connection === 'close') {
          acknowledgements.disconnect();
          bridge.disconnect('disconnected; reconnect pending');
          const code = update.lastDisconnect?.error?.output?.statusCode;
          if (connectionDisposition(code, DisconnectReason) === 'stop') {
            log('session is unavailable; stopped without deleting credentials'); stop('login required or connection replaced');
          } else {
            const delay = reconnectDelay(attempt++);
            clearTimeout(reconnect);
            reconnect = setTimeout(() => { try { connect(); } catch { log('connection failed'); stop('connection failed'); } }, delay);
          }
        }
      });
    };
    connect();
    let tick = 0;
    if (command === 'run') interval = setInterval(() => {
      if (ticking || stopped) return;
      ticking = true;
      const admitted = enqueue(async () => {
        try {
          await bridge.processPending();
          if (tick++ % 5 === 0) await bridge.refresh();
          bridge.health();
          await bridge.flush();
        } finally { ticking = false; }
      });
      if (!admitted) ticking = false;
    }, 3000);
    await finish;
    await serial;
  } finally {
    stopped = true; clearInterval(interval); clearTimeout(reconnect);
    socket?.end(new Error('local bridge stopped'));
    clearQr();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    if (bridge?.connected) bridge.disconnect('stopped');
    release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(() => process.exit(0)).catch(() => {
    // Neither auth objects, QR data nor vendor errors are ever diagnostic output.
    process.stderr.write('fm-whatsapp: command failed; verify configuration, pairing and private bridge health (details omitted for privacy)\n');
    process.exit(1);
  });
}
