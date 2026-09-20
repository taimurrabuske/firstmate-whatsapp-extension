#!/usr/bin/env node
// CLI owner: explicit home, private linked-device auth, lifecycle, and subprocess boundaries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { FirstmateAdapter } from './firstmate.mjs';
import { NotificationPolicy } from './notifications.mjs';
import { stageAttachment, outboundContent, attachmentBytes } from './media.mjs';
import { loadVoiceConfig, transcribeVoice, validateVoicePaths, VOICE_CONFIG_SCHEMA } from './voice.mjs';
import { MediaIntake } from './media-intake.mjs';
import { TelegramDelegate, telegramStore, telegramConfig, telegramConfigured, configureTelegram } from './telegram.mjs';
import { Acknowledgements, Bridge, Store, readJson, writeJson, delegateState, verifyHomeBinding, ownIdentity, canonicalJid, authenticatedMessage, validText, parseRequest, epoch, MAX_TEXT, validateSnapshot } from './core.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const help = `Usage: FM_HOME=/absolute/home bin/fm-whatsapp.sh <command>
  pair [--qr-file /absolute/file]  Display a QR (SVG when file ends .svg), exit after linking.
  run                            Run the self-chat bridge until stopped with SIGINT/SIGTERM.
  status                         Print private bridge health without connecting.
  doctor                         Verify installation, dependencies, private state, and single-instance readiness.
  reply <message-key>            Queue stdin response to an accepted phone request, including outside AFK.
  progress <key> <state>         Report picked-up, working, waiting, or failed; detail on stdin.
  reply-file <key> <file>        Send a local image/report for this request; optional caption on stdin.
  summary <shortcut>            Read status, pending, blocked, decisions, last result, or more.
  preferences <command>         Set alerts, subscriptions, quiet hours, or digest interval.
  voice-status                  Check the local offline transcription setup.
  voice-config set|inspect|remove
                                Configure local ffmpeg, whisper.cpp, model, and language paths (see help below).
  telegram-config <file> <id>    Pair optional fallback using a private token file and exact user ID.
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
Offline voice transcription: voice-config set FFMPEG WHISPER MODEL [LANGUAGE] accepts absolute local
paths, validates executables and the model file, and writes private mode-600 state. voice-config inspect
prints the validated setup; voice-config remove clears it. Models are never downloaded; see docs/media.md.
Send instructions directly, without a prefix. Shortcuts: status, pending, blocked, decisions, last result, more, help.
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
function lstatOrNull(file) { try { return fs.lstatSync(file); } catch { return null; } }
function resolveTransport(extensionRoot) {
  const requireModule = createRequire(path.join(extensionRoot, 'bin/fm-whatsapp', 'package.json'));
  for (const name of ['@whiskeysockets/baileys', 'qrcode-terminal']) {
    try { requireModule.resolve(name); } catch { return false; }
  }
  return true;
}
function jqInstalled() {
  try { return spawnSync('jq', ['--version'], { timeout: 10000 }).status === 0; } catch { return false; }
}
// Read-only installation diagnostics for operators and process managers.
// Injected probes keep the checks hermetic for tests; defaults inspect the real
// installation. Findings never include phone numbers or credentials.
export function doctorReport({ home, env = process.env, extensionRoot = root,
  nodeMajor = Number(process.versions.node.split('.')[0]),
  transportReady = resolveTransport(root), jqReady = jqInstalled(),
  processAlive = pid => { process.kill(pid, 0); } } = {}) {
  const lines = [];
  const missing = [];
  const ok = detail => lines.push(`ok: ${detail}`);
  const note = detail => lines.push(`note: ${detail}`);
  const problem = detail => lines.push(`problem: ${detail}`);
  const finished = () => ({ ready: !lines.some(line => line.startsWith('problem:')), lines });
  try {
    if (nodeMajor >= 20) ok(`node major version ${nodeMajor} satisfies the required >= 20`);
    else problem(`node major version ${nodeMajor} is present but Node >= 20 is required; install a newer Node`);
    if (transportReady) ok('pinned WhatsApp transport dependencies resolve (Baileys, qrcode-terminal)');
    else problem(`WhatsApp transport dependencies are missing; run npm ci --prefix ${path.join(extensionRoot, 'bin/fm-whatsapp')}`);
    if (jqReady) ok('jq is installed for Firstmate event and decision projections');
    else problem('jq is missing; install jq so status summaries and AFK alert projections work');
    const codeRoot = env.FM_CODE_ROOT || home;
    if (lstatOrNull(path.join(codeRoot, 'bin/fm-afk-contract.sh'))) ok(`Firstmate scripts are installed under ${codeRoot}`);
    else problem(`Firstmate helper fm-afk-contract.sh is not installed under ${codeRoot}; set FM_CODE_ROOT to the installed Firstmate home`);
    for (const script of ['bin/fm-whatsapp-events.sh', 'bin/fm-whatsapp-decisions.sh']) {
      if (!lstatOrNull(path.join(extensionRoot, script))) missing.push(script);
    }
    if (missing.length) problem(`extension projection scripts missing from ${extensionRoot}: ${missing.join(', ')}; use a complete checkout`);
    else ok('extension projection scripts are present');
    let state = null;
    try { state = delegateState(home, env); }
    catch (error) {
      if (error?.code === 'ENOENT') problem(`FM_HOME ${home} does not exist; create the home or correct the path`);
      else problem(`private state location cannot be resolved: ${error.message}`);
    }
    if (!state) return finished();
    const directory = path.join(state, 'whatsapp');
    if (!lstatOrNull(directory)) {
      note(`private state ${directory} does not exist yet; pair creates it`);
      return finished();
    }
    for (const name of ['', 'auth', 'outbox', 'sent', 'incoming', 'pending'].map(suffix => path.join(directory, suffix))) {
      const stat = lstatOrNull(name);
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) problem(`private state directory ${name} must be a regular directory, not a symlink`);
      else if ((stat.mode & 0o777) !== 0o700) problem(`private state directory ${name} is mode ${(stat.mode & 0o777).toString(8)}; run chmod 700 ${name}`);
    }
    for (const name of ['health.json', 'identity.json', 'recipient.json', 'enabled.json', 'expired.json', 'receive-health.json', 'voice.json']) {
      const file = path.join(directory, name);
      const stat = lstatOrNull(file);
      if (stat && stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) !== 0o600) problem(`private state file ${file} is mode ${(stat.mode & 0o777).toString(8)}; run chmod 600 ${file}`);
    }
    const binding = readJson(path.join(directory, 'home.json'));
    if (!binding) note('single-home binding is not written yet; the first bridge run creates it');
    else if (binding.home !== fs.realpathSync(home)) problem(`private state belongs to another Firstmate home; point FM_DELEGATE_STATE at a state directory bound to ${fs.realpathSync(home)}`);
    else ok('private state is bound to exactly this Firstmate home');
    const identity = readJson(path.join(directory, 'identity.json'));
    if (identity?.account) ok('a linked device is paired for this state');
    else note('device is not paired yet; run pair and scan the QR');
    const recipient = readJson(path.join(directory, 'recipient.json'));
    if (!recipient?.account) ok('recipient defaults to Message yourself');
    else if (canonicalJid(recipient.account) === recipient.account && recipient.account.endsWith('@s.whatsapp.net')) ok('a single second number is configured for this state');
    else problem('recipient configuration is invalid; stop the bridge and run recipient self or recipient +COUNTRYNUMBER');
    const voiceFile = path.join(directory, 'voice.json');
    if (!lstatOrNull(voiceFile)) note('offline voice transcription is not configured; voice-config set enables local whisper.cpp (optional, never downloads a model)');
    else if (loadVoiceConfig({ file: () => voiceFile }).available) ok('offline voice transcription configuration validates');
    else problem('voice.json is not a valid private transcription configuration; run voice-config inspect, then voice-config set to rewrite it');
    const lockFile = path.join(directory, 'run.lock');
    const lock = lstatOrNull(lockFile);
    if (!lock) ok('no live bridge holds this private state');
    else if (!lock.isDirectory()) problem(`run.lock at ${lockFile} is not a lock directory; inspect it manually`);
    else {
      const owner = readJson(path.join(lockFile, 'owner.json'));
      if (!Number.isInteger(owner?.pid) || owner.pid < 1) problem(`run.lock owner is unreadable; confirm no bridge is running, then inspect ${lockFile} manually`);
      else {
        let liveness = 'unknown';
        try { processAlive(owner.pid); liveness = 'running'; }
        catch (error) { if (error?.code === 'ESRCH') liveness = 'exited'; }
        if (liveness === 'running') note(`a bridge process (pid ${owner.pid}) holds this state; a second instance refuses to start`);
        else if (liveness === 'exited') problem(`stale run.lock from exited pid ${owner.pid}; confirm the process is gone, then remove ${lockFile} manually`);
        else problem(`run.lock pid ${owner.pid} cannot be probed; inspect ${lockFile} manually before starting`);
      }
    }
    const health = safeHealth(state);
    if (health.updated_epoch == null) note('bridge health has not been written yet; run publishes it every few seconds');
    else if (health.connected) ok('bridge health is fresh and reports connected');
    else {
      note(`bridge is not currently connected (${health.fresh ? 'fresh' : 'stale'} health)`);
      if (health.fresh && health.problem) note(`health reports: ${health.problem}`);
    }
    const enabled = readJson(path.join(directory, 'enabled.json'));
    if (enabled?.enabled === true) ok('WhatsApp alerts are enabled');
    else note('WhatsApp alerts are not enabled; connect the bridge and run enable for AFK alerts');
  } catch (error) {
    problem(`diagnostics could not complete: ${error.message}`);
  }
  return finished();
}
export function parseArgs(argv) {
  const command = argv.shift() || 'help';
  let qrFile, recipient, messageKey, progressState, attachmentFile, value, tokenFile, userId, voiceAction, voicePaths;
  if (command === 'progress' && argv.length === 2) [messageKey, progressState] = argv.splice(0);
  if (command === 'reply-file' && argv.length === 2) [messageKey, attachmentFile] = argv.splice(0);
  if (['summary', 'preferences'].includes(command) && argv.length) value = argv.splice(0).join(' ');
  if (command === 'telegram-config' && argv.length === 2) [tokenFile, userId] = argv.splice(0);
  if (command === 'voice-config' && argv.length) {
    const [action, ...rest] = argv;
    if (action === 'set') {
      if (rest.length < 3 || rest.length > 4) throw new Error('voice-config set requires FFMPEG WHISPER MODEL [LANGUAGE]');
      voiceAction = 'set'; voicePaths = rest;
    } else if (action === 'inspect' || action === 'remove') {
      if (rest.length) throw new Error(`voice-config ${action} takes no arguments`);
      voiceAction = action;
    }
    argv = [];
  }
  if (command === 'reply' && argv.length === 1 && /^[a-f0-9]{64}$/.test(argv[0])) messageKey = argv.shift();
  if (command === 'recipient' && argv.length === 1) {
    recipient = argv.shift();
    if (recipient !== 'self' && !/^\+[1-9]\d{7,14}$/.test(recipient)) throw new Error('use an international phone number');
  }
  if (command === 'pair' && argv[0] === '--qr-file' && argv.length === 2) {
    qrFile = argv[1]; argv = [];
    if (!path.isAbsolute(qrFile)) throw new Error('QR file must be an absolute path');
  }
  if (argv.length || (command === 'recipient' && !recipient) ||
      (['reply', 'progress', 'reply-file'].includes(command) && !/^[a-f0-9]{64}$/.test(messageKey ?? '')) ||
      (command === 'progress' && !['picked-up', 'working', 'waiting', 'failed'].includes(progressState)) ||
      (command === 'reply-file' && !path.isAbsolute(attachmentFile ?? '')) ||
      (command === 'summary' && !['status', 'pending', 'blocked', 'decisions', 'last result', 'more'].includes(value)) ||
      (command === 'preferences' && !value) || (command === 'telegram-config' && (!tokenFile || !userId)) ||
      (command === 'voice-config' && !voiceAction) ||
      !['pair', 'run', 'status', 'doctor', 'notify', 'reply', 'progress', 'reply-file', 'summary', 'preferences', 'voice-status', 'voice-config', 'telegram-config', 'enable', 'disable', 'recipient', 'ping', 'help', '--help'].includes(command)) throw new Error('invalid command; use help');
  return { command, qrFile, recipient, messageKey, progressState, attachmentFile, value, tokenFile, userId, voiceAction, voicePaths };
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
  const { command, qrFile, recipient, messageKey, progressState, attachmentFile, value, tokenFile, userId, voiceAction, voicePaths } = parseArgs(argv);
  if (command === 'help' || command === '--help') { process.stdout.write(help); return; }
  const home = process.env.FM_HOME;
  if (!home || !path.isAbsolute(home)) throw new Error('set FM_HOME to an absolute operational home');
  if (command === 'doctor') {
    const report = doctorReport({ home, env: process.env, extensionRoot: root });
    process.stdout.write(`fm-whatsapp installation check\nhome: ${home}\n`);
    for (const line of report.lines) process.stdout.write(`${line}\n`);
    process.stdout.write(report.ready
      ? 'ready: installation can start the bridge; supervise at most one instance per private state directory under your process manager, passing the same explicit FM_HOME, FM_CODE_ROOT, FM_STATE_OVERRIDE and FM_DELEGATE_STATE environment\n'
      : 'not ready: resolve each problem above, then run doctor again\n');
    return report.ready ? undefined : 1;
  }
  const state = delegateState(home);
  verifyHomeBinding(state, home);
  const firstmateState = process.env.FM_STATE_OVERRIDE || path.join(home, 'state');
  const codeRoot = process.env.FM_CODE_ROOT || home;
  if (!path.isAbsolute(firstmateState) || !path.isAbsolute(codeRoot)) throw new Error('Firstmate state and code root must be absolute');
  if (command === 'status') { process.stdout.write(`${JSON.stringify(safeHealth(state))}\n`); return; }
  const store = new Store(home, state);
  if (command === 'voice-status') { process.stdout.write(`${JSON.stringify(loadVoiceConfig(store))}\n`); return; }
  if (command === 'voice-config') {
    if (voiceAction === 'set') {
      const [ffmpeg, whisper, model, language] = voicePaths;
      // Validation happens before any write: only a fully verified absolute local
      // setup replaces the private configuration, atomically and mode 600 via writeJson.
      const resolved = validateVoicePaths({ ffmpeg, whisper, model, language: language ?? 'en' });
      writeJson(store.file('voice.json'), { schema: VOICE_CONFIG_SCHEMA, ffmpeg, whisper, model, language: resolved.language });
      process.stdout.write(`offline voice transcription configured (language ${resolved.language}); private voice.json written mode 600\n`);
      return;
    }
    if (voiceAction === 'inspect') { process.stdout.write(`${JSON.stringify(loadVoiceConfig(store))}\n`); return; }
    try { fs.unlinkSync(store.file('voice.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; process.stdout.write('voice configuration was not present\n'); return; }
    process.stdout.write('voice configuration removed; voice notes are retained but no longer transcribed\n');
    return;
  }
  if (command === 'telegram-config') {
    await configureTelegram(store, tokenFile, userId);
    process.stdout.write('Telegram fallback paired; start the bridge and message the bot from that user.\n'); return;
  }
  if (command === 'recipient') {
    const unlock = store.lock();
    try {
      if (['outbox', 'pending', 'media-pending', 'telegram-pending'].some(directory =>
        fs.existsSync(store.file(directory)) && store.records(directory).length)) throw new Error('resolve queued messages before changing recipient');
      writeJson(store.file('recipient.json'), { account: recipient === 'self' ? null : `${recipient.slice(1)}@s.whatsapp.net` });
      process.stdout.write('recipient configured; start the bridge\n');
    } finally { unlock(); }
    return;
  }
  if (command === 'ping') {
    if (!safeHealth(state).connected) throw new Error('bridge must be connected');
    store.enqueue('Firstmate is connected to this number. Send status to check the connection, or send your instruction directly. No prefix is needed.', { kind: 'reply', session: '' });
    process.stdout.write('connection test queued\n'); return;
  }
  if (command === 'enable' || command === 'disable') {
    if (command === 'enable' && !safeHealth(state).connected) throw new Error('bridge is not connected; run it before enabling');
    writeJson(store.file('enabled.json'), { enabled: command === 'enable' });
    process.stdout.write(`${command === 'enable' ? 'enabled' : 'disabled'}\n`); return;
  }
  const adapter = new FirstmateAdapter({ home, codeRoot, state: firstmateState, store, extensionRoot: root });
  const tgStore = telegramStore(store);
  const tgAdapter = new FirstmateAdapter({ home, codeRoot, state: firstmateState, store: tgStore, extensionRoot: root });
  const requestAdapter = key => readJson(store.file(`handoffs/${key}.json`))?.route?.transport === 'telegram' ? tgAdapter : adapter;
  const policy = new NotificationPolicy({ stateDir: store.root });
  const optionalTelegram = () => { try { return telegramConfig(store); } catch { return null; } };
  if (command === 'summary') { process.stdout.write(`${await adapter.summary(value)}\n`); return; }
  if (command === 'preferences') {
    const result = policy.command(value);
    if (!result.recognized) throw new Error('unknown notification preference');
    process.stdout.write(`${result.text}\n`); return;
  }
  const events = () => adapter.events();
  if (['notify', 'reply', 'progress', 'reply-file'].includes(command)) {
    const chunks = []; let count = 0;
    for await (const chunk of process.stdin) {
      count += chunk.length;
      if (count > MAX_TEXT * 4) throw new Error('message too long');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (command === 'reply') {
      process.stdout.write(`queued ${requestAdapter(messageKey).reply(messageKey, text)}\n`); return;
    }
    if (command === 'progress') {
      requestAdapter(messageKey).progress(messageKey, progressState, text);
      process.stdout.write(`recorded ${progressState}\n`); return;
    }
    if (command === 'reply-file') {
      const selected = requestAdapter(messageKey);
      const { receipt } = selected.requestReceipt(messageKey);
      const attachment = stageAttachment(selected.store, attachmentFile, { requestKey: messageKey });
      const caption = text || `Report: ${attachment.name}`;
      const queued = store.enqueue(caption, { kind: 'reply', session: '', route: attachment.route,
        requestKey: messageKey, attachment, fallbackRoute: receipt.fallbackRoute, id: `attachment:${messageKey}:${attachment.digest}:${caption}` });
      process.stdout.write(`queued ${queued}\n`); return;
    }
    const current = validateSnapshot(await events());
    if (!current.afk) throw new Error('the delegate must be enabled and Firstmate away; nothing queued');
    const key = store.enqueue(text, { session: current.session, route: store.currentRoute(), fallbackRoute: optionalTelegram()?.route });
    process.stdout.write(`queued ${key}\n`); return;
  }
  const release = store.lock();
  let socket, interval, reconnect, done, stopped = false, attempt = 0, qrShown = false;
  let serial = Promise.resolve();
  let pending = 0; let ticking = false;
  let bridge, mediaWork;
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
    let makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, proto, qr, QRCode, qrLevel;
    try {
      ({ default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, proto } = await import('@whiskeysockets/baileys'));
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
      summary: command => adapter.summary(command),
      notificationPolicy: policy,
      localCommand: text => policy.command(text),
      fallbackRoute: () => optionalTelegram()?.route,
      send: async (jid, text, messageId, job) => {
        if (!socket || stopped) return false;
        // Resolve the recipient's authenticated PN/LID mapping before sending,
        // so either form of server acknowledgement can be matched exactly.
        if (bridge.peer) {
          const lid = canonicalJid(await socket.signalRepository.lidMapping.getLIDForPN(bridge.peer.account));
          if (lid?.endsWith('@lid') && !bridge.peer.aliases.includes(lid)) bridge.peer.aliases.push(lid);
        }
        const waiter = acknowledgements.register(messageId, bridge.peer ?? bridge.identity);
        try {
          const content = job?.attachment ? outboundContent({ ...job, text }, store) : { text };
          const response = await socket.sendMessage(jid, content, { messageId });
          if (response?.key?.id !== messageId) throw new Error('unexpected local send identity');
          return await waiter.promise;
        } catch { waiter.cancel(); return false; }
      } });
    const intake = new MediaIntake({ store, bridge,
      encode: message => proto.WebMessageInfo.encode(message).finish(),
      decode: bytes => proto.WebMessageInfo.decode(bytes),
      download: message => downloadMediaMessage(message, 'stream', { options: { signal: AbortSignal.timeout(30000) } }),
      transcribe: file => transcribeVoice(file, { store }) });
    const telegram = new TelegramDelegate({ store, adapter: tgAdapter,
      notificationAllowed: (job, snapshot, now) => policy.allow(job, snapshot, now),
      command: async text => { const result = policy.command(text); return result.recognized ? result.text : null; },
      attachmentReader: job => attachmentBytes(job, store) });
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
            requestType: parseRequest(message.message?.conversation ?? message.message?.extendedTextMessage?.text)?.operation ?? null,
            authenticated: Boolean(authenticatedMessage(message, bridge.identity, epoch(), bridge.pairedAt, bridge.peer)),
            stubType: message.messageStubType ?? null
          }));
          writeJson(store.file('receive-health.json'), { at: epoch(), type: batch.type, messages: diagnostics });
          bridge.stage(batch);
          intake.stage(batch);
        }
        catch { bridge.problem = 'incoming capture failed; retry message'; bridge.health(); }
        enqueue(() => bridge.processPending());
      });
      current.ev.on('connection.update', update => {
        if (socket !== current || stopped) return;
        if (update.connection) currentState = update.connection;
        if (update.qr) {
          if (command !== 'pair') {
            // Decided without the token file: a transiently unreadable token is
            // the tick's degraded-and-retried condition, never a reason to stop
            // a run whose explicitly configured fallback must stay serviced.
            if (telegramConfigured(store)) bridge.disconnect('WhatsApp pairing required; Telegram fallback enabled');
            else stop('pairing required');
            return;
          }
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
            if (command === 'run' && telegramConfigured(store)) {
              log('WhatsApp requires pairing; optional Telegram remains available');
              bridge.disconnect('WhatsApp login required; Telegram fallback enabled');
            } else {
              log('session is unavailable; stopped without deleting credentials'); stop('login required or connection replaced');
            }
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
          if (tick++ % 5 === 0) {
            await bridge.refresh();
            const reports = await adapter.maintain();
            for (const report of reports) adapter.notifyMaintenance(report);
            if (optionalTelegram()) for (const report of await tgAdapter.maintain()) tgAdapter.notifyMaintenance(report);
          }
          if (!mediaWork) mediaWork = intake.processOne().catch(() => {
            bridge.problem = 'media processing unavailable; private intake retained';
          }).finally(() => { mediaWork = null; });
          bridge.health();
          await bridge.flush();
          await telegram.tick(bridge, bridge.snapshot);
        } finally { ticking = false; }
      });
      if (!admitted) ticking = false;
    }, 3000);
    await finish;
    await serial;
    await mediaWork;
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
  main(process.argv.slice(2)).then(code => process.exit(Number.isInteger(code) ? code : 0)).catch(() => {
    // Neither auth objects, QR data nor vendor errors are ever diagnostic output.
    process.stderr.write('fm-whatsapp: command failed; verify configuration, pairing and private bridge health (details omitted for privacy)\n');
    process.exit(1);
  });
}
