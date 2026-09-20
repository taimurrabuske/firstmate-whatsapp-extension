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
import { WHISPER_MODEL_CATALOG, catalogModels, installWhisperModel, removeWhisperModel, resolveCatalogModel } from './model-store.mjs';
import { MediaIntake } from './media-intake.mjs';
import { QUARANTINE_INSPECTION_LIMIT, quarantineSummary, retainPrivateState } from './retention.mjs';
import { TelegramDelegate, telegramStore, telegramConfig, telegramConfigured, configureTelegram } from './telegram.mjs';
import { Acknowledgements, Bridge, Store, readJson, writeJson, delegateState, verifyHomeBinding, ownIdentity, canonicalJid, authenticatedMessage, validText, parseRequest, epoch, MAX_TEXT, MAX_QUEUE, validateSnapshot } from './core.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const help = `Usage: FM_HOME=/absolute/home bin/fm-whatsapp.sh <command>
  pair [--qr-file /absolute/file]  Display a QR (SVG when file ends .svg), exit after linking.
  run                            Run the self-chat bridge until stopped with SIGINT/SIGTERM.
  status                         Print private bridge health and single-instance lock ownership without connecting.
  doctor                         Verify installation, dependencies, private state, single-instance ownership, queues,
                                 uncertain handoffs, adapter liveness, and service-manager binding. Read-only.
  reply <message-key>            Queue stdin response to an accepted phone request, including outside AFK.
  progress <key> <state>         Report picked-up, working, waiting, or failed; detail on stdin.
  reply-file <key> <file>        Send a local image/report for this request; optional caption on stdin.
  summary <shortcut>            Read status, pending, blocked, decisions, last result, or more.
  preferences <command>         Set alerts, subscriptions, quiet hours, or digest interval.
  voice-status                  Check the local offline transcription setup.
  voice-config set|inspect|remove
                                Configure local ffmpeg, whisper.cpp, model, and language paths (see help below).
  voice-model list              List supported whisper.cpp models and which are installed.
  voice-model install NAME      Explicitly download supported model NAME over HTTPS into private
                                state with pinned checksum verification.
  voice-model remove NAME       Remove installed model NAME from private state.
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
paths or the name of an installed catalog model, validates executables and the model file, and writes
private mode-600 state. voice-config inspect prints the validated setup; voice-config remove clears it.
Model downloads never happen automatically: voice-model install NAME fetches one explicitly over HTTPS
into this extension's private state, verifies it against a pinned checksum manifest, and installs it
atomically with private permissions. Nothing from other installed speech applications is reused;
see docs/media.md.
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
  let data = null;
  try { data = readJson(path.join(state, 'whatsapp/health.json')); } catch { data = null; }
  const fresh = Number.isFinite(data?.updated_epoch) && data.updated_epoch <= now + 5 && data.updated_epoch >= now - 60;
  return { connected: data?.connected === true && fresh, fresh: Boolean(fresh),
    updated_epoch: data?.updated_epoch ?? null, queued: data?.queued ?? 0,
    pending: data?.pending ?? 0, uncertain: data?.uncertain ?? 0,
    lock: lockOwner(state).state,
    problem: fresh ? (data.problem || '') : 'bridge is not running or health is stale' };
}
function lstatOrNull(file) { try { return fs.lstatSync(file); } catch { return null; } }
function realpathOrNull(file) { try { return fs.realpathSync(file); } catch { return null; } }
// Read-only single-instance ownership classification for run.lock. Never
// removes a lock; 'exited' means the recorded pid is gone (stale), 'live'
// means the recorded process still exists. Locks recorded before owner
// metadata was introduced report null home/delegateState/started.
export function lockOwner(state, processAlive = pid => { process.kill(pid, 0); }) {
  const file = path.join(state, 'whatsapp', 'run.lock');
  const stat = lstatOrNull(file);
  if (!stat) return { state: 'absent', file };
  if (!stat.isDirectory()) return { state: 'invalid', file };
  let owner = null;
  try { owner = readJson(path.join(file, 'owner.json')); } catch { owner = null; }
  if (!Number.isInteger(owner?.pid) || owner.pid < 1) return { state: 'unreadable', file };
  let liveness = 'unknown';
  try { processAlive(owner.pid); liveness = 'live'; }
  catch (error) { if (error?.code === 'ESRCH') liveness = 'exited'; }
  return { state: liveness, file, pid: owner.pid,
    started: Number.isInteger(owner?.started) ? owner.started : null,
    home: typeof owner?.home === 'string' ? owner.home : null,
    delegateState: typeof owner?.delegateState === 'string' ? owner.delegateState : null };
}
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
  processAlive = pid => { process.kill(pid, 0); }, now = epoch() } = {}) {
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
    for (const name of ['', 'auth', 'outbox', 'sent', 'incoming', 'pending', 'models'].map(suffix => path.join(directory, suffix))) {
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
    const canonicalHome = fs.realpathSync(home);
    const binding = readJson(path.join(directory, 'home.json'));
    if (!binding) note('single-home binding is not written yet; the first bridge run creates it');
    else if (binding.home !== canonicalHome) problem(`private state belongs to another Firstmate home; point FM_DELEGATE_STATE at a state directory bound to ${canonicalHome}`);
    else ok('private state is bound to exactly this Firstmate home');
    const identity = readJson(path.join(directory, 'identity.json'));
    if (identity?.account) ok('a linked device is paired for this state');
    else note('device is not paired yet; run pair and scan the QR');
    const recipient = readJson(path.join(directory, 'recipient.json'));
    if (!recipient?.account) ok('recipient defaults to Message yourself');
    else if (canonicalJid(recipient.account) === recipient.account && recipient.account.endsWith('@s.whatsapp.net')) ok('a single second number is configured for this state');
    else problem('recipient configuration is invalid; stop the bridge and run recipient self or recipient +COUNTRYNUMBER');
    const quarantine = quarantineSummary(directory);
    if (quarantine.records > 0) {
      const detail = `quarantine holds ${quarantine.records} preserved record(s) (${quarantine.bytes} bytes) under ${path.join(directory, 'quarantine')}; damaged records are never silently dropped`;
      if (quarantine.records > QUARANTINE_INSPECTION_LIMIT) problem(`${detail}; inspect, repair or discard each one manually`);
      else note(`${detail}; inspect before discarding, and restore any record this bridge still needs`);
    }
    const voiceFile = path.join(directory, 'voice.json');
    if (!lstatOrNull(voiceFile)) note('offline voice transcription is not configured; voice-model install fetches a supported whisper.cpp model explicitly and voice-config set enables local transcription (optional)');
    else if (loadVoiceConfig({ file: () => voiceFile }).available) ok('offline voice transcription configuration validates');
    else problem('voice.json is not a valid private transcription configuration; run voice-config inspect, then voice-config set to rewrite it');
    // Single-instance ownership: live versus stale, with recorded binding.
    const lock = lockOwner(state, processAlive);
    if (lock.state === 'absent') ok('no live bridge holds this private state');
    else if (lock.state === 'invalid') problem(`run.lock at ${lock.file} is not a lock directory; inspect it manually`);
    else if (lock.state === 'unreadable') problem(`run.lock owner is unreadable; confirm no bridge is running, then inspect ${lock.file} manually`);
    else if (lock.state === 'unknown') problem(`run.lock pid ${lock.pid} cannot be probed; inspect ${lock.file} manually before starting`);
    else {
      const age = lock.started == null ? null : Math.max(0, now - lock.started);
      if (lock.state === 'live') note(`a bridge process (pid ${lock.pid}) holds this state; a second instance refuses to start`);
      else problem(`stale run.lock from exited pid ${lock.pid}${age == null ? '' : ` (lock age ${age}s)`}; confirm the process is gone, then remove ${lock.file} manually`);
      // A lock recorded for another home or private state directory means the
      // service manager is starting the bridge with a mismatched environment.
      // Diagnostics only name the alignment action; they never remove a lock.
      if (lock.home != null && lock.home !== canonicalHome)
        problem(`run.lock was recorded for another Firstmate home (${lock.home}); align FM_HOME in the service manager environment before starting here`);
      if (lock.delegateState != null && lock.delegateState !== directory &&
          realpathOrNull(lock.delegateState) !== realpathOrNull(directory))
        problem(`run.lock was recorded for another private state directory (${lock.delegateState}); align FM_DELEGATE_STATE in the service manager environment`);
    }
    const health = safeHealth(state, now);
    if (health.updated_epoch == null) note('bridge health has not been written yet; run publishes it every few seconds');
    else if (health.connected) ok('bridge health is fresh and reports connected');
    else {
      note(`bridge is not currently connected (${health.fresh ? 'fresh' : 'stale'} health)`);
      if (health.fresh && health.problem) note(`health reports: ${health.problem}`);
    }
    if (health.connected && health.fresh && lock.state !== 'live')
      problem('health is fresh and reports connected but no live run.lock owner exists; a second instance would start unchecked; find the publisher before starting');
    if (lock.state === 'live' && !health.fresh)
      note(`a bridge holds run.lock but health is ${health.updated_epoch == null ? 'not written yet' : 'stale'}; it may still be starting or reconnecting`);
    if (!health.connected && lock.state === 'absent' && identity?.account)
      note('bridge is not running; start it once under your process manager with the same explicit FM_HOME, FM_CODE_ROOT, FM_STATE_OVERRIDE and FM_DELEGATE_STATE environment');
    // Bounded queue inventory: counts and phases only, never message text.
    const inventory = (name, limit = 200) => {
      try {
        const files = fs.readdirSync(path.join(directory, name)).filter(entry => /^[a-f0-9]{64}\.json$/.test(entry));
        return { files: files.slice(0, limit), total: files.length };
      } catch { return null; }
    };
    const safeRecord = file => { try { return readJson(file); } catch { return null; } };
    const outbox = inventory('outbox', MAX_QUEUE);
    if (outbox) {
      if (outbox.total >= MAX_QUEUE) problem(`outbound queue is full (${outbox.total} messages); the bridge refuses new alerts until delivery drains; do not delete queued files manually`);
      else if (outbox.total > 0) note(`outbound queue holds ${outbox.total} message(s); delivery resumes automatically when the bridge connects`);
    }
    const pendingQueue = inventory('pending');
    if (pendingQueue?.total) {
      const unproved = pendingQueue.files.filter(name => safeRecord(path.join(directory, 'pending', name))?.uncertain === true);
      if (unproved.length) problem(`${unproved.length} accepted request(s) could not be proved delivered to Firstmate; inspect their handoff receipts and Firstmate's pending and handled inbox; never delete a receipt or republish automatically`);
      else note(`${pendingQueue.total} accepted request(s) await processing; the bridge retries them automatically`);
    }
    const handoffs = inventory('handoffs');
    if (handoffs?.total) {
      const phaseCount = phase => handoffs.files.filter(name => safeRecord(path.join(directory, 'handoffs', name))?.phase === phase).length;
      const uncertain = phaseCount('uncertain'), calling = phaseCount('calling');
      if (uncertain) problem(`${uncertain} handoff receipt(s) record an uncertain publication in ${path.join(directory, 'handoffs')}; compare them with Firstmate's pending and handled inbox; never delete a receipt or retry the handoff automatically`);
      if (calling) problem(`${calling} handoff receipt(s) were left mid-publication by an interrupted bridge; recheck after the bridge restarts; do not delete them`);
      if (handoffs.total > handoffs.files.length) note(`handoff receipt scan covered the first ${handoffs.files.length} of ${handoffs.total} receipts`);
    }
    // Inbox wake adapter availability and controller watcher liveness (read-only).
    const adapterConfigFile = env.WHATSAPP_ADAPTER_CONFIG || path.join(state, 'inbox-adapter.json');
    if (!lstatOrNull(adapterConfigFile)) note('inbox wake adapter is not configured; requests are saved but may not wake the controller; see README "Connect the controlling Firstmate"');
    else {
      let adapterConfig = null;
      try { adapterConfig = readJson(adapterConfigFile); } catch { adapterConfig = null; }
      if (!adapterConfig || adapterConfig.schema !== 'firstmate.whatsapp-inbox-config.v1')
        problem(`inbox adapter configuration ${adapterConfigFile} is unreadable or has an unrecognized schema; re-register the whatsapp-inbox source; do not edit captured results`);
      else {
        const bound = { whatsapp_state: realpathOrNull(directory), fm_home: canonicalHome };
        const mismatched = Object.keys(bound).filter(key => adapterConfig[key] !== bound[key]);
        const stage = typeof adapterConfig.extension_root === 'string' ?
          path.join(adapterConfig.extension_root, 'adapter/bin/firstmate-extension.mjs') : null;
        if (mismatched.length || !stage || !lstatOrNull(stage))
          problem(`inbox adapter configuration ${adapterConfigFile} does not match this installation${mismatched.length ? ` (${mismatched.join(', ')})` : ''}; re-register the whatsapp-inbox source; do not edit captured results`);
        else ok('inbox adapter configuration matches this home and private state');
      }
    }
    const beaconFile = path.join(env.FM_STATE_OVERRIDE || path.join(home, 'state'), '.last-watcher-beat');
    const beacon = lstatOrNull(beaconFile);
    if (!beacon || !beacon.isFile() || beacon.isSymbolicLink()) note('no controller watcher beacon found; wake liveness is unproven');
    else {
      const age = Math.max(0, now - Math.floor(beacon.mtimeMs / 1000));
      if (age >= 300) note(`controller watcher beacon is ${age}s old; saved requests may not be picked up; check the controller watcher before relying on wakes`);
      else ok(`controller watcher beacon is fresh (${age}s old)`);
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
  let qrFile, recipient, messageKey, progressState, attachmentFile, value, tokenFile, userId, voiceAction, voicePaths, voiceModelAction, voiceModelName;
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
  if (command === 'voice-model' && argv.length) {
    const [action, ...rest] = argv;
    if (action === 'list') {
      if (rest.length) throw new Error('voice-model list takes no arguments');
      voiceModelAction = 'list';
    } else if (action === 'install' || action === 'remove') {
      if (rest.length !== 1 || !/^[a-z0-9._-]{1,64}$/.test(rest[0]))
        throw new Error(`voice-model ${action} requires one supported model name; use voice-model list`);
      voiceModelAction = action; voiceModelName = rest[0];
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
      (command === 'voice-config' && !voiceAction) || (command === 'voice-model' && !voiceModelAction) ||
      !['pair', 'run', 'status', 'doctor', 'notify', 'reply', 'progress', 'reply-file', 'summary', 'preferences', 'voice-status', 'voice-config', 'voice-model', 'telegram-config', 'enable', 'disable', 'recipient', 'ping', 'help', '--help'].includes(command)) throw new Error('invalid command; use help');
  return { command, qrFile, recipient, messageKey, progressState, attachmentFile, value, tokenFile, userId, voiceAction, voicePaths, voiceModelAction, voiceModelName };
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
  const { command, qrFile, recipient, messageKey, progressState, attachmentFile, value, tokenFile, userId, voiceAction, voicePaths, voiceModelAction, voiceModelName } = parseArgs(argv);
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
  if (command === 'voice-model') {
    if (voiceModelAction === 'list') {
      process.stdout.write(`${JSON.stringify(catalogModels(store))}\n`); return;
    }
    if (voiceModelAction === 'install') {
      if (!Object.prototype.hasOwnProperty.call(WHISPER_MODEL_CATALOG, voiceModelName))
        throw new Error('unsupported model; use voice-model list for the supported names');
      const result = await installWhisperModel(voiceModelName, { store });
      process.stdout.write(result.alreadyInstalled
        ? 'model was already installed and verified; nothing downloaded\n'
        : `model installed in private state after pinned sha256 verification (${Math.round(result.bytes / 1_000_000)} MB)\n`);
      return;
    }
    const removed = removeWhisperModel(voiceModelName, { store });
    process.stdout.write(removed.removed ? 'model removed from private state\n' : 'model was not installed\n');
    return;
  }
  if (command === 'voice-config') {
    if (voiceAction === 'set') {
      const [ffmpeg, whisper, model, language] = voicePaths;
      // A bare catalog name selects an already-installed private model; absolute
      // local paths keep working unchanged. Downloads stay explicit and separate.
      let modelPath = model;
      if (!path.isAbsolute(model)) {
        if (!/^[a-z0-9._-]{1,64}$/.test(model)) throw new Error('voice model must be an absolute local path or an installed catalog model name; use voice-model list');
        modelPath = resolveCatalogModel(store, model);
        if (!modelPath) throw new Error('voice model is not installed; run voice-model install first');
      }
      // Validation happens before any write: only a fully verified absolute local
      // setup replaces the private configuration, atomically and mode 600 via writeJson.
      const resolved = validateVoicePaths({ ffmpeg, whisper, model: modelPath, language: language ?? 'en' });
      writeJson(store.file('voice.json'), { schema: VOICE_CONFIG_SCHEMA, ffmpeg, whisper, model: modelPath, language: resolved.language });
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
            // Bounded retention of proven terminal artifacts; failures leave
            // everything in place and simply retry on a later tick.
            try { retainPrivateState(store, bridge.requests, { now: epoch() }); }
            catch { log('retention sweep skipped; private state retained unchanged'); }
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
