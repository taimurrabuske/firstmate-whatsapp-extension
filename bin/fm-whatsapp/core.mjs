// Transport policy and durable storage. This module has no WhatsApp or model dependency.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { RequestJournal } from './requests.mjs';

export const MAX_TEXT = 3500;
export const MAX_QUEUE = 100;
export const MAX_SEEN = 10000;
export const PREFIX = '[Firstmate] ';
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const epoch = () => Math.floor(Date.now() / 1000);

export function delegateState(home, env = process.env) {
  const canonicalHome = fs.realpathSync(home);
  const base = env.FM_DELEGATE_STATE || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
    'firstmate-whatsapp', sha256(canonicalHome).slice(0, 16));
  if (!path.isAbsolute(base)) throw new Error('delegate state must be absolute');
  return base;
}
export function verifyHomeBinding(state, home) {
  const binding = readJson(path.join(state, 'whatsapp/home.json'));
  if (binding && binding.home !== fs.realpathSync(home)) throw new Error('delegate state belongs to another Firstmate home');
}

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe private directory');
  fs.chmodSync(directory, 0o700);
}
export function readJson(file, fallback = null) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('unsafe state file');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('unreadable private state');
  }
}
export function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
export function canonicalJid(jid) {
  if (typeof jid !== 'string') return null;
  const match = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(jid);
  return match ? `${match[1]}@${match[2]}` : null;
}
export function sameRoute(left, right) {
  return Boolean(left && right && left.account === right.account && left.recipient === right.recipient &&
    (left.transport ?? 'whatsapp') === (right.transport ?? 'whatsapp') && left.credentialDigest === right.credentialDigest);
}
export function ownIdentity(user) {
  const account = canonicalJid(user?.id);
  if (!account || !account.endsWith('@s.whatsapp.net')) throw new Error('authenticated phone identity unavailable');
  const aliases = [account];
  if (user.lid != null) {
    const lid = canonicalJid(user.lid);
    if (!lid || !lid.endsWith('@lid')) throw new Error('authenticated linked identity invalid');
    aliases.push(lid);
  }
  return { account, aliases };
}
export function validText(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_TEXT &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}
export function parseRequest(text) {
  if (!validText(text)) return null;
  const shortcut = /^(?:!fm\s+)?(status|help|pending|blocked|decisions|more|last result)$/i.exec(text.trim());
  if (shortcut) return { operation: shortcut[1].toLowerCase() === 'help' ? 'help' : 'summary', command: shortcut[1].toLowerCase() };
  const legacyNote = /^!fm\s+note\s+([\s\S]+)$/i.exec(text);
  return { operation: 'note', text: legacyNote ? legacyNote[1] : text };
}
export function authenticatedMessage(message, identity, now, pairedAt, peer = null) {
  const key = message?.key;
  if (!identity || key?.fromMe !== !peer || typeof key.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(key.id)) return null;
  const aliases = [...(peer ?? identity).aliases];
  // remoteJidAlt is authenticated transport metadata, not quoted message text.
  // A phone-number match can bind a LID before the background lookup completes.
  if (peer && canonicalJid(key.remoteJidAlt) === peer.account && canonicalJid(key.remoteJid)?.endsWith('@lid')) {
    aliases.push(canonicalJid(key.remoteJid));
  }
  const owns = jid => aliases.includes(canonicalJid(jid));
  if (!owns(key.remoteJid)) return null;
  for (const field of ['remoteJidAlt', 'participant', 'participantAlt']) {
    // Direct-message stanzas can carry participant="". It means absent,
    // not another sender; any nonempty alternate identity must still match.
    if (key[field] != null && key[field] !== '' && !owns(key[field])) return null;
  }
  const timestamp = Number(message.messageTimestamp);
  if (!Number.isFinite(timestamp) || timestamp < pairedAt || timestamp < now - 86400 || timestamp > now + 300) return null;
  const content = message.message;
  // History, edits, media captions, disappearing and view-once wrappers are not commands.
  if (!content || Object.keys(content).some(k => !['conversation', 'extendedTextMessage', 'messageContextInfo'].includes(k))) return null;
  const extended = content.extendedTextMessage;
  if (extended?.contextInfo?.isForwarded || Number(extended?.contextInfo?.forwardingScore) > 0) return null;
  const text = content.conversation ?? extended?.text;
  if (!validText(text) || text.startsWith(PREFIX)) return null;
  const context = extended?.contextInfo;
  if (context?.participant && !owns(context.participant) &&
      !(peer && identity.aliases.includes(canonicalJid(context.participant)))) return null;
  if (context?.remoteJid && !owns(context.remoteJid)) return null;
  return { id: key.id, key: sha256(`${identity.account}\n${peer ? `${peer.account}\n` : ''}${key.id}`), text,
    quotedId: typeof context?.stanzaId === 'string' ? context.stanzaId : null };
}
export function validateSnapshot(value) {
  if (value?.schema !== 'fm-whatsapp-events.v1' || typeof value.afk !== 'boolean' ||
      typeof value.session !== 'string' || value.session.length > 256 ||
      !Array.isArray(value.events) || value.events.length > MAX_QUEUE) throw new Error('invalid event snapshot');
  if (value.afk && !value.session) throw new Error('missing away session');
  for (const event of value.events) {
    if (typeof event.id !== 'string' || !event.id || event.id.length > 512 || !validText(event.text)) throw new Error('invalid event');
    if (event.kind != null && !['decision', 'alert', 'completion', 'failure', 'progress'].includes(event.kind)) throw new Error('invalid event metadata');
    if (event.project != null && (typeof event.project !== 'string' || event.project.length > 256 || /[\x00-\x1f\x7f]/.test(event.project))) throw new Error('invalid event metadata');
    for (const field of ['task', 'key']) if (event[field] != null && (typeof event[field] !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(event[field]))) throw new Error('invalid event metadata');
  }
  return value;
}

export class Store {
  constructor(home, state = delegateState(home)) {
    if (!path.isAbsolute(home) || !path.isAbsolute(state)) throw new Error('FM_HOME and state must be absolute');
    this.root = path.join(state, 'whatsapp');
    privateDirectory(this.root);
    const canonicalHome = fs.realpathSync(home);
    this.home = canonicalHome;
    const bindingFile = this.file('home.json');
    if (!readJson(bindingFile)) {
      const staged = this.file(`.home-${crypto.randomUUID()}.tmp`);
      writeJson(staged, { home: canonicalHome });
      try { fs.linkSync(staged, bindingFile); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      finally { fs.unlinkSync(staged); }
    }
    verifyHomeBinding(state, home);
    for (const name of ['auth', 'outbox', 'sent', 'incoming', 'pending']) privateDirectory(path.join(this.root, name));
  }
  file(name) { return path.join(this.root, name); }
  records(name) { return fs.readdirSync(this.file(name)).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).sort(); }
  incoming(key) { return readJson(this.file(`incoming/${key}.json`)); }
  markIncoming(key, now, request = {}) {
    writeJson(this.file(`incoming/${key}.json`), { at: now, operation: request.operation, route: request.route, fallbackRoute: request.fallbackRoute });
  }
  currentRoute() {
    const account = readJson(this.file('identity.json'))?.account;
    const recipient = readJson(this.file('recipient.json'))?.account || account;
    for (const value of [account, recipient]) {
      if (!value?.endsWith('@s.whatsapp.net') || canonicalJid(value) !== value) throw new Error('authenticated route unavailable');
    }
    return { account, recipient };
  }
  pruneIncoming(now) {
    for (const file of this.records('incoming')) {
      const record = readJson(this.file(`incoming/${file}`));
      if (record.at < now - 86400) fs.unlinkSync(this.file(`incoming/${file}`));
    }
  }
  enqueue(text, { kind = 'alert', session, id = crypto.randomUUID(), automatic = false, route, requestKey, event,
    sourceEvents, attachment, fallbackRoute, now = epoch() } = {}) {
    if (!validText(text) || !['alert', 'reply'].includes(kind) || typeof session !== 'string') throw new Error('invalid outbound message');
    const queueLock = this.file('queue.lock');
    try { fs.mkdirSync(queueLock, { mode: 0o700 }); }
    catch { throw new Error('queue busy or interrupted; retry or inspect queue.lock'); }
    try {
      const key = sha256(`${kind}\n${session}\n${id}`);
      const target = this.file(`outbox/${key}.json`);
      if (readJson(this.file(`sent/${key}.json`)) || readJson(target)) return key;
      if (this.records('outbox').length >= MAX_QUEUE) throw new Error('outbound queue full');
      // Independent immutable queue entries permit notify while run holds its process lock.
      const temp = this.file(`outbox/.${crypto.randomUUID()}.tmp`);
      writeJson(temp, { key, kind, session, text, automatic, route, requestKey, sourceEvents, attachment, fallbackRoute, eventId: id,
        event: event ? { kind: event.kind, task: event.task, key: event.key } : undefined, created: now, attempts: 0, next: 0,
        remoteId: `3EB0${crypto.randomBytes(14).toString('hex').toUpperCase()}` });
      try { fs.linkSync(temp, target); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      finally { fs.unlinkSync(temp); }
      const directory = fs.openSync(this.file('outbox'), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      return key;
    } finally { fs.rmdirSync(queueLock); }
  }
  expire(snapshot, now) {
    const active = new Set(snapshot.events.map(event => event.id));
    for (const name of this.records('outbox')) {
      const file = this.file(`outbox/${name}`);
      const job = readJson(file);
      if (!job || job.kind !== 'alert') continue;
      let reason = '';
      if (!snapshot.afk || job.session !== snapshot.session) reason = 'away session ended or replaced';
      else if (job.automatic && (job.sourceEvents
        ? job.sourceEvents.some(event => event.kind === 'decision' && !active.has(event.id))
        : !active.has(job.eventId))) reason = 'recorded decision no longer open';
      if (!reason) continue;
      const receipts = readJson(this.file('expired.json'), []);
      receipts.push({ key: job.key, at: now, reason });
      writeJson(this.file('expired.json'), receipts.slice(-MAX_QUEUE));
      fs.unlinkSync(file);
    }
  }
  sentByRemoteId(id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id ?? '')) return null;
    for (const name of this.records('sent')) {
      const record = readJson(this.file(`sent/${name}`));
      if (record.remoteId === id) return record;
    }
    return null;
  }
  lock() {
    const lock = this.file('run.lock');
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJson(path.join(lock, 'owner.json'));
      // Missing owner is an initialization/crash ambiguity, never an excuse to race.
      if (!Number.isInteger(owner?.pid) || owner.pid < 1) throw new Error('bridge lock requires inspection');
      try { process.kill(owner.pid, 0); throw new Error('another bridge owns this home'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      throw new Error('stale bridge lock; inspect and remove run.lock before restarting');
    }
    // Owner metadata lets read-only diagnostics distinguish live from stale
    // ownership and detect a service manager bound to another home or state.
    const token = crypto.randomUUID();
    writeJson(path.join(lock, 'owner.json'), { pid: process.pid, token, started: epoch(), home: this.home, delegateState: this.root });
    return () => {
      const current = readJson(path.join(lock, 'owner.json'));
      if (current?.token === token) fs.rmSync(lock, { recursive: true });
    };
  }
}

export class Bridge {
  constructor({ store, inbox, status, summary = null, events, send, peer = null, clock = epoch,
    notificationPolicy = null, localCommand = null, fallbackRoute = () => undefined }) {
    Object.assign(this, { store, inbox, status, summary, events, send, peer, clock, notificationPolicy, localCommand, fallbackRoute });
    this.requests = new RequestJournal(store, clock);
    this.identity = null;
    this.connected = false;
    this.snapshot = { afk: false, session: '', events: [] };
    this.problem = '';
    this.lastSent = 0;
  }
  connect(user) {
    const identity = ownIdentity(user);
    const previous = readJson(this.store.file('identity.json'));
    if (previous && previous.account !== identity.account) throw new Error('paired account changed; use a new private home');
    this.pairedAt = previous?.pairedAt ?? this.clock();
    writeJson(this.store.file('identity.json'), { ...identity, pairedAt: this.pairedAt });
    this.identity = identity;
    this.connected = true;
    this.problem = '';
    this.health();
  }
  disconnect(reason = 'disconnected') {
    this.connected = false;
    this.problem = reason;
    this.health();
  }
  health() {
    const pending = this.store.records('pending');
    const uncertain = pending.filter(name => readJson(this.store.file(`pending/${name}`))?.uncertain === true).length;
    writeJson(this.store.file('health.json'), { connected: this.connected, updated_epoch: this.clock(),
      account: this.identity?.account ?? '',
      problem: uncertain ? 'note publication uncertain; inspect handoff receipt, helper process and pending/handled inbox before recovery' : this.problem,
      queued: this.store.records('outbox').length, pending: pending.length, uncertain });
  }
  async refresh() {
    try {
      this.snapshot = validateSnapshot(await this.events());
      this.store.expire(this.snapshot, this.clock());
      if (this.notificationPolicy) {
        for (const delivery of this.notificationPolicy.plan(this.snapshot, this.clock())) {
          this.store.enqueue(delivery.text, { session: delivery.session, id: delivery.id,
            event: delivery.event, sourceEvents: delivery.sourceEvents, automatic: true,
            route: this.store.currentRoute(), fallbackRoute: this.fallbackRoute(), now: this.clock() });
          this.notificationPolicy.commit(delivery);
        }
      } else if (this.snapshot.afk) {
        for (const event of this.snapshot.events) this.store.enqueue(event.text,
          { session: this.snapshot.session, id: event.id, event, automatic: true, now: this.clock() });
      }
    } catch {
      this.snapshot = { afk: false, session: '', events: [] };
      this.problem = 'event source unavailable; alerts remain queued';
    }
    this.store.pruneIncoming(this.clock());
    this.health();
  }
  stage(batch) {
    if (!this.connected || batch?.type !== 'notify' || !Array.isArray(batch.messages)) return;
    // Stage every accepted message before a potentially failing Firstmate helper runs.
    for (const message of batch.messages.slice(0, 100)) {
      const incoming = authenticatedMessage(message, this.identity, this.clock(), this.pairedAt, this.peer);
      if (!incoming || this.store.incoming(incoming.key) || this.store.sentByRemoteId(incoming.id)) continue;
      const file = this.store.file(`pending/${incoming.key}.json`);
      if (readJson(file)) continue;
      const request = parseRequest(incoming.text);
      if (!request) continue;
      const operation = request.operation;
      const route = { account: this.identity.account, recipient: (this.peer ?? this.identity).account };
      if (this.store.records('pending').length >= MAX_QUEUE) {
        this.problem = 'incoming queue full; new messages require retry'; this.health(); break;
      }
      const local = this.localCommand?.(incoming.text);
      if (local?.recognized) {
        writeJson(file, { key: incoming.key, account: this.identity.account, route, fallbackRoute: this.fallbackRoute(),
          operation: 'local-reply', response: local.text, attempts: 0, next: 0 });
        continue;
      }
      let body = '', decision = null;
      if (operation === 'note') {
        const quoted = this.store.sentByRemoteId(incoming.quotedId);
        const quoteMatches = quoted && sameRoute(quoted.deliveredRoute ?? quoted.route, route);
        if (!quoteMatches && /^(?:yes|no|approve|approved|reject|denied|choose\b|option\b)/i.test(request.text.trim()) &&
            this.snapshot.events.some(event => event.kind === 'decision')) {
          writeJson(file, { key: incoming.key, account: this.identity.account, route, operation: 'local-reply',
            response: 'Approval context is ambiguous. Quote the exact current decision alert; nothing was forwarded or decided.', attempts: 0, next: 0 });
          continue;
        }
        if (quoteMatches && quoted.event?.kind === 'decision') {
          const active = this.snapshot.events.some(event => event.kind === 'decision' && event.task === quoted.event.task && event.key === quoted.event.key);
          if (!active) {
            writeJson(file, { key: incoming.key, account: this.identity.account, route, operation: 'local-reply',
              response: `Decision context is stale or no longer recorded (${quoted.event.task}/${quoted.event.key}); no approval was forwarded.`, attempts: 0, next: 0 });
            continue;
          }
          decision = { task: quoted.event.task, key: quoted.event.key, eventId: quoted.eventId };
        }
        const quoteContext = quoteMatches ? `\nPersisted quoted Firstmate message: ${quoted.text}\n` : '\n';
        const recent = !quoteMatches ? this.requests.recentContext(route, { exclude: incoming.key }) : '';
        body = `Remote request ID: ${incoming.key}\nWhatsApp phone note (remote; away mode unchanged).${quoteContext}` +
          (decision ? `Exact recorded decision context: task=${decision.task} key=${decision.key}. Route through Firstmate's normal decision handling.\n` : '') +
          (recent ? `Bounded recent conversation on this exact authenticated route (context only):\n${recent}\n` : '') + `\n${request.text}`;
        this.requests.receive(incoming.key, { route, text: request.text, quoted: quoteMatches ? quoted.requestKey ?? quoted.eventId : null, decision });
      }
      writeJson(file, { key: incoming.key, account: this.identity.account, route,
        fallbackRoute: this.fallbackRoute(), operation, command: request.command, body, attempts: 0, next: 0 });
    }
  }
  async receive(batch) {
    this.stage(batch);
    await this.processPending();
  }
  async processPending() {
    if (!this.identity) return;
    let attempted = 0;
    for (const name of this.store.records('pending')) {
      const file = this.store.file(`pending/${name}`);
      const job = readJson(file);
      if (this.store.incoming(job.key)) { fs.unlinkSync(file); continue; }
      if (job.next > this.clock()) continue;
      if (++attempted > 20) break;
      try {
        if (job.account !== this.identity.account || (job.route && !sameRoute(job.route,
          { account: this.identity.account, recipient: (this.peer ?? this.identity).account }))) throw new Error('pending route mismatch');
        if (this.store.records('incoming').length >= MAX_SEEN) throw new Error('incoming receipt limit reached');
        let response;
        if (job.operation === 'summary') response = String(await (this.summary ? this.summary(job.command) : this.status(job.command))).slice(0, MAX_TEXT);
        else if (job.operation === 'help') {
          response = 'Send your instruction directly—no prefix needed. Shortcuts: status, pending, blocked, decisions, last result, more, help. Quote a Firstmate alert for exact context. Phone messages do not end away mode; decisions still require supervisor handling and normal gates.';
        } else if (job.operation === 'local-reply') response = job.response;
        else if (job.operation === 'note') {
          await this.inbox(job.key, job.body);
          response = `Request ${job.key.slice(0, 12)} received and saved for Firstmate. State: received. Completion requires an explicit Firstmate result.`;
        } else throw new Error('invalid pending operation');
        this.store.enqueue(response, { kind: 'reply', session: '', id: job.key, route: job.route,
          fallbackRoute: job.fallbackRoute, now: this.clock() });
        this.store.markIncoming(job.key, this.clock(), job);
        fs.unlinkSync(file);
      } catch (error) {
        job.uncertain = error.code === 'FM_NOTE_UNCERTAIN';
        job.attempts += 1;
        job.next = this.clock() + Math.min(300, 2 ** Math.min(job.attempts, 8));
        writeJson(file, job);
        this.problem = 'inbound handoff incomplete; saved for retry';
        this.health();
      }
    }
  }
  async flush() {
    if (!this.connected || !this.identity || this.clock() - this.lastSent < 2) return;
    // Read the current posture for every attempted alert, never trust a cached AFK flag.
    let gate;
    try { gate = validateSnapshot(await this.events()); this.store.expire(gate, this.clock()); }
    catch { this.problem = 'event source unavailable; alerts remain queued'; gate = { afk: false }; }
    for (const file of this.store.records('outbox')) {
      const location = this.store.file(`outbox/${file}`);
      const job = readJson(location);
      if (!job || job.next > this.clock()) continue;
      if (job.route?.transport === 'telegram') continue;
      if (job.kind === 'alert' && (!gate.afk || job.session !== gate.session)) continue;
      if (job.kind === 'alert' && this.notificationPolicy && !this.notificationPolicy.allow(job, gate, this.clock())) continue;
      if (job.route && !sameRoute(job.route, { account: this.identity.account, recipient: (this.peer ?? this.identity).account })) {
        this.problem = 'reply route changed; queued response retained for inspection'; this.health(); continue;
      }
      if (this.store.records('sent').length >= MAX_SEEN) {
        this.problem = 'delivery receipt limit reached; inspect private state'; this.health(); return;
      }
      // A receipt written before queue deletion recovers without another remote send.
      if (readJson(this.store.file(`sent/${file}`))) { fs.unlinkSync(location); continue; }
      this.lastSent = this.clock();
      try {
        const delivered = await this.send((this.peer ?? this.identity).account, `${PREFIX}${job.text}`, job.remoteId, job);
        if (!delivered) throw new Error('unconfirmed send');
        writeJson(this.store.file(`sent/${file}`), { ...job,
          deliveredRoute: { account: this.identity.account, recipient: (this.peer ?? this.identity).account }, delivered: this.clock() });
        fs.unlinkSync(location);
        this.problem = '';
      } catch {
        job.attempts += 1;
        job.next = this.clock() + Math.min(300, 2 ** Math.min(job.attempts, 8));
        writeJson(location, job);
        this.problem = 'delivery failed or uncertain; queued for retry';
      }
      this.health();
      return;
    }
    this.health();
  }
}

// A local send return is not a server acknowledgement. Register before sending.
export class Acknowledgements {
  constructor(timeoutMs = 20000) { this.timeoutMs = timeoutMs; this.waiters = new Map(); }
  register(id, identity) {
    if (this.waiters.has(id)) throw new Error('duplicate acknowledgement waiter');
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {}); // A disconnect may reject while sendMessage is still pending.
    const timer = setTimeout(() => this.finish(id, false), this.timeoutMs);
    this.waiters.set(id, { identity, resolve, reject, timer });
    return { promise, cancel: () => this.finish(id, false) };
  }
  finish(id, success) {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id); clearTimeout(waiter.timer);
    if (success) waiter.resolve(true); else waiter.reject(new Error('delivery not acknowledged'));
  }
  observe(updates) {
    for (const entry of updates ?? []) {
      const key = entry?.key, waiter = this.waiters.get(key?.id);
      if (!waiter || key.fromMe !== true || !waiter.identity.aliases.includes(canonicalJid(key.remoteJid))) continue;
      if (key.participant && !waiter.identity.aliases.includes(canonicalJid(key.participant))) continue;
      const status = entry.update?.status;
      if (status === 0) this.finish(key.id, false);
      else if (Number.isInteger(status) && status >= 2 && status <= 5) this.finish(key.id, true);
    }
  }
  observeNode(node) {
    // Baileys rc14 discards successful message ACKs from messages.update;
    // its websocket callback exposes the authenticated raw protocol receipt.
    if (node?.tag !== 'ack' || node.attrs?.class !== 'message') return;
    const waiter = this.waiters.get(node.attrs.id);
    if (!waiter || !waiter.identity.aliases.includes(canonicalJid(node.attrs.from))) return;
    if (node.attrs.participant && !waiter.identity.aliases.includes(canonicalJid(node.attrs.participant))) return;
    this.finish(node.attrs.id, !node.attrs.error);
  }
  disconnect() { for (const id of [...this.waiters.keys()]) this.finish(id, false); }
}
