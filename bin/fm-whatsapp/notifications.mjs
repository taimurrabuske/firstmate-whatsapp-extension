// Local notification preferences and restart-safe event/digest planning.
// The caller must enqueue every returned delivery before calling commit().
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KINDS = ['completion', 'failure', 'decision', 'progress'];
const DEFAULTS = Object.freeze({
  enabled: true,
  kinds: { completion: true, failure: true, decision: true, progress: false },
  decisionUrgent: true,
  quiet: null,
  digestMinutes: 0,
  projects: {},
  tasks: {}
});
const canonical = value => value.trim().toLocaleLowerCase('en-US');
const nowSeconds = value => value instanceof Date ? Math.floor(value.getTime() / 1000) : Math.floor(Number(value));
const digestId = ids => crypto.createHash('sha256').update(ids.slice().sort().join('\n')).digest('hex');

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe notification state directory');
  fs.chmodSync(directory, 0o700);
}
function read(file, fallback) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error();
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('unreadable notification state');
  }
}
function write(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function validZone(zone) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }).format(); return true; }
  catch { return false; }
}
function minutesAt(epoch, zone) {
  const fields = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(epoch * 1000));
  const part = type => Number(fields.find(item => item.type === type)?.value);
  return part('hour') * 60 + part('minute');
}
function parseTime(value) {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value);
  return match ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
}
function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULTS)); }
function eventValid(event) {
  return event && typeof event.id === 'string' && event.id && typeof event.text === 'string' && event.text &&
    KINDS.includes(event.kind) && typeof event.task === 'string' && typeof event.project === 'string';
}

export class NotificationPolicy {
  constructor(options) {
    const stateDir = typeof options === 'string' ? options : options?.stateDir;
    if (!path.isAbsolute(stateDir ?? '')) throw new Error('notification state path must be absolute');
    privateDirectory(stateDir);
    this.stateDir = stateDir;
    this.preferencesFile = path.join(stateDir, 'notification-preferences.json');
    this.ledgerFile = path.join(stateDir, 'notification-ledger.json');
    if (!read(this.preferencesFile, null)) write(this.preferencesFile, { schema: 'fm-whatsapp-notifications.v1', ...cloneDefaults() });
  }
  preferences() {
    const value = read(this.preferencesFile, null);
    if (!value || value.schema !== 'fm-whatsapp-notifications.v1') {
      if (value && value.enabled !== undefined) throw new Error('invalid notification preferences');
      const fresh = { schema: 'fm-whatsapp-notifications.v1', ...cloneDefaults() };
      write(this.preferencesFile, fresh); return fresh;
    }
    return value;
  }
  save(preferences) { write(this.preferencesFile, preferences); }
  subscribed(event, preferences = this.preferences()) {
    const task = preferences.tasks[canonical(event.task)];
    if (typeof task === 'boolean') return task;
    const project = preferences.projects[canonical(event.project)];
    return typeof project === 'boolean' ? project : true;
  }
  quiet(now, preferences = this.preferences()) {
    const quiet = preferences.quiet;
    if (!quiet) return false;
    const local = minutesAt(nowSeconds(now), quiet.timezone);
    if (quiet.start === quiet.end) return true;
    return quiet.start < quiet.end ? local >= quiet.start && local < quiet.end : local >= quiet.start || local < quiet.end;
  }
  allow(job, snapshot, now) {
    const preferences = this.preferences();
    if (!preferences.enabled || !snapshot?.afk || !snapshot.session || job?.session !== snapshot.session ||
        this.quiet(now, preferences)) return false;
    const events = job?.sourceEvents ?? (job?.kind && job?.task !== undefined ? [job] : []);
    const active = new Set((snapshot.events ?? []).map(event => event.id));
    return events.length > 0 && events.every(event => eventValid(event) && preferences.kinds[event.kind] &&
      this.subscribed(event, preferences) && (event.kind !== 'decision' || active.has(event.id)));
  }
  plan(snapshot, now) {
    const at = nowSeconds(now);
    if (!Number.isFinite(at)) throw new Error('invalid planning time');
    const preferences = this.preferences();
    let ledger = read(this.ledgerFile, { schema: 'fm-whatsapp-notification-ledger.v1', initialized: false, seen: [], pending: {} });
    if (ledger.schema !== 'fm-whatsapp-notification-ledger.v1' || !Array.isArray(ledger.seen) || !ledger.pending) throw new Error('invalid notification ledger');
    const events = Array.isArray(snapshot?.events) ? snapshot.events.filter(eventValid) : [];
    if (!ledger.initialized) {
      // Installation is an observation boundary, not a replay of the status log.
      ledger.initialized = true;
      ledger.seen = events.map(event => event.id).slice(-10000);
      write(this.ledgerFile, ledger);
      return [];
    }
    const seen = new Set(ledger.seen);
    for (const event of events) {
      if (seen.has(event.id) || ledger.pending[event.id]) continue;
      seen.add(event.id);
      if (snapshot.afk && preferences.enabled && preferences.kinds[event.kind] && this.subscribed(event, preferences)) {
        ledger.pending[event.id] = { event, captured: at, session: snapshot.session };
      }
    }
    // Pending alerts never cross an AFK session boundary. The source event remains
    // observed, so returning from AFK cannot resurrect an old alert.
    const activeIds = new Set(events.map(event => event.id));
    for (const [id, pending] of Object.entries(ledger.pending)) {
      if (!snapshot?.afk || pending.session !== snapshot.session || !preferences.enabled ||
          !preferences.kinds[pending.event.kind] || !this.subscribed(pending.event, preferences) ||
          (pending.event.kind === 'decision' && !activeIds.has(id))) delete ledger.pending[id];
    }
    ledger.seen = [...seen].slice(-10000);
    write(this.ledgerFile, ledger); // capture before exposing any enqueue work
    if (!snapshot?.afk || !preferences.enabled || this.quiet(at, preferences)) return [];

    const ready = Object.entries(ledger.pending).filter(([, pending]) =>
      preferences.kinds[pending.event.kind] && this.subscribed(pending.event, preferences));
    const deliveries = [];
    const immediate = ready.filter(([, pending]) => preferences.digestMinutes === 0 ||
      (pending.event.kind === 'decision' && preferences.decisionUrgent));
    for (const [id, pending] of immediate) deliveries.push(this.delivery([id], [pending.event], pending.session, false));
    const batched = ready.filter(([id]) => !immediate.some(([other]) => other === id));
    if (batched.length && Math.min(...batched.map(([, item]) => item.captured)) + preferences.digestMinutes * 60 <= at) {
      deliveries.push(this.delivery(batched.map(([id]) => id), batched.map(([, item]) => item.event), snapshot.session, true));
    }
    return deliveries;
  }
  delivery(sourceIds, sourceEvents, session, digest) {
    const id = digest ? `notification-digest:${digestId(sourceIds)}` : `notification:${sourceIds[0]}`;
    const text = digest
      ? `Firstmate digest (${sourceEvents.length})\n\n${sourceEvents.map(event => `• ${event.text}`).join('\n')}`
      : sourceEvents[0].text;
    return { id, text: text.slice(0, 3500), kind: digest ? 'digest' : sourceEvents[0].kind,
      task: digest ? '' : sourceEvents[0].task, project: digest ? '' : sourceEvents[0].project,
      session, sourceIds, sourceEvents, automatic: true };
  }
  commit(delivery) {
    const ids = Array.isArray(delivery) ? delivery : delivery?.sourceIds;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('invalid notification acknowledgement');
    const ledger = read(this.ledgerFile, null);
    if (!ledger) return;
    for (const id of ids) delete ledger.pending[id];
    write(this.ledgerFile, ledger);
  }
  command(text) {
    const input = typeof text === 'string' ? text.trim() : '';
    const preferences = this.preferences();
    let match;
    if (/^alerts$/i.test(input)) return { recognized: true, text: this.describe(preferences), preferences };
    if ((match = /^alerts\s+(on|off)$/i.exec(input))) preferences.enabled = match[1].toLowerCase() === 'on';
    else if ((match = /^alerts\s+(completion|failure|decisions|progress)\s+(on|off)$/i.exec(input))) {
      const kind = match[1].toLowerCase() === 'decisions' ? 'decision' : match[1].toLowerCase();
      preferences.kinds[kind] = match[2].toLowerCase() === 'on';
    } else if ((match = /^alerts\s+decisions\s+urgent\s+(on|off)$/i.exec(input))) preferences.decisionUrgent = match[1].toLowerCase() === 'on';
    else if ((match = /^(subscribe|unsubscribe)\s+(project|task)\s+(.{1,120})$/i.exec(input))) {
      const name = match[3].trim();
      if (!name || /[\u0000-\u001f\u007f]/.test(name)) return { recognized: false };
      preferences[`${match[2].toLowerCase()}s`][canonical(name)] = match[1].toLowerCase() === 'subscribe';
    } else if ((match = /^quiet\s+((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)\s+(\S+)$/i.exec(input))) {
      if (!validZone(match[3])) return { recognized: true, text: 'Unknown timezone; use an IANA name such as America/New_York.', error: true };
      preferences.quiet = { from: match[1], to: match[2], start: parseTime(match[1]), end: parseTime(match[2]), timezone: match[3] };
    } else if (/^quiet\s+off$/i.test(input)) preferences.quiet = null;
    else if ((match = /^digest\s+(0|[1-9]\d{0,3})$/i.exec(input))) {
      const minutes = Number(match[1]);
      if (minutes > 1440) return { recognized: true, text: 'Digest must be between 0 and 1440 minutes.', error: true };
      preferences.digestMinutes = minutes;
    } else return { recognized: false };
    this.save(preferences);
    return { recognized: true, text: `Notification preference saved. ${this.describe(preferences)}`, preferences };
  }
  describe(p) {
    const kinds = KINDS.map(kind => `${kind} ${p.kinds[kind] ? 'on' : 'off'}`).join(', ');
    const quiet = p.quiet ? `${p.quiet.from}-${p.quiet.to} ${p.quiet.timezone}` : 'off';
    return `Alerts ${p.enabled ? 'on' : 'off'}; ${kinds}; urgent decisions ${p.decisionUrgent ? 'on' : 'off'}; quiet ${quiet}; digest ${p.digestMinutes}m.`;
  }
}
