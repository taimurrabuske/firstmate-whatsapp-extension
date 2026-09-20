// Durable, transport-neutral request lifecycle, bounded context, and summaries.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { plainRecord, privateDirectory, readStoredRecord, writeJson, sameRoute, validText, safeBoundaryEnd, MAX_TEXT } from './core.mjs';

export const REQUEST_STATES = ['received', 'picked-up', 'working', 'waiting', 'completed', 'failed'];
export const TERMINAL_REQUEST_STATES = ['completed', 'failed'];
const transitions = {
  received: new Set(['picked-up', 'working', 'waiting', 'completed', 'failed']),
  'picked-up': new Set(['working', 'waiting', 'completed', 'failed']),
  working: new Set(['picked-up', 'waiting', 'completed', 'failed']),
  waiting: new Set(['picked-up', 'working', 'completed', 'failed']),
  completed: new Set(), failed: new Set()
};
const validKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
// Compatibility gate: only records this version knows how to interpret stay in
// the live journal. Truncated, damaged, or future-schema records are quarantined
// byte-preserved by the reader instead of silently disappearing or wedging
// every summary. Open work must be restored by an operator from quarantine.
export const validRequestRecord = value => plainRecord(value) && value.schema === 'fm-remote-request.v1' &&
  validKey(value.key) && REQUEST_STATES.includes(value.state) && Number.isFinite(value.received) &&
  Number.isFinite(value.updated) && Array.isArray(value.history) && plainRecord(value.route);
const clean = text => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
// Recorded result and progress text is transport-agnostic journal history; it
// accepts everything the reply stdin bound (MAX_TEXT * 4 bytes) can carry.
// Evaluated lazily: core.mjs imports this module during its own load.
const validRecordedText = text => typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_TEXT * 4 &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
const excerpt = (text, limit) => {
  if (text.length <= limit) return text;
  const head = text.slice(0, safeBoundaryEnd(text, 0, Math.floor(limit * 0.7)));
  let tailStart = text.length - (limit - head.length - 3);
  // Open the tail on the whole character, never mid surrogate pair.
  if (text.charCodeAt(tailStart) >= 0xDC00 && text.charCodeAt(tailStart) <= 0xDFFF &&
      text.charCodeAt(tailStart - 1) >= 0xD800 && text.charCodeAt(tailStart - 1) <= 0xDBFF) tailStart -= 1;
  return `${head} … ${text.slice(tailStart)}`;
};
const MAX_PAGE = 3300;
const routeScope = (route, provenance = route?.transport ?? route?.provenance ?? 'whatsapp') => crypto.createHash('sha256').update(JSON.stringify({
  provenance,
  account: route?.account,
  credential: route?.credentialDigest ?? route?.credentialFingerprint ?? route?.account,
  recipient: route?.recipient
})).digest('hex');

export class RequestJournal {
  constructor(store, clock = () => Math.floor(Date.now() / 1000)) {
    this.store = store; this.clock = clock;
    privateDirectory(store.file('requests'));
  }
  file(key) { if (!validKey(key)) throw new Error('invalid request identity'); return this.store.file(`requests/${key}.json`); }
  get(key) {
    return readStoredRecord(this.store.root, this.file(key),
      { validate: validRequestRecord, reason: 'request record failed structural validation or schema compatibility' }).record;
  }
  receive(key, { route, text, quoted = null, decision = null, provenance = 'whatsapp' }) {
    if (!validText(text)) throw new Error('invalid request text');
    const file = this.file(key), existing = readStoredRecord(this.store.root, file,
      { validate: validRequestRecord, reason: 'request record failed structural validation or schema compatibility' }).record;
    const digest = crypto.createHash('sha256').update(text).digest('hex');
    const scope = routeScope(route, provenance);
    if (existing) {
      const existingScope = existing.routeScope ?? routeScope(existing.route, existing.provenance);
      if (existing.textDigest !== digest || !sameRoute(existing.route, route) || existingScope !== scope)
        throw new Error('request identity changed');
      if (!existing.routeScope || !existing.requestText) {
        existing.routeScope = scope; existing.requestText = clean(text); writeJson(file, existing);
      }
      return existing;
    }
    const now = this.clock();
    const record = { schema: 'fm-remote-request.v1', key, route, routeScope: scope, provenance,
      textDigest: digest, requestText: clean(text), state: 'received', received: now, updated: now, quoted, decision,
      history: [{ state: 'received', at: now, text: 'Authenticated request recorded.' }] };
    writeJson(file, record); return record;
  }
  transition(key, state, text = '') {
    if (!REQUEST_STATES.includes(state) || (text && !validRecordedText(text))) throw new Error('invalid request progress');
    const record = this.get(key);
    if (!record) throw new Error('unknown request identity');
    if (record.state === state && (!text || record.history.at(-1)?.text === clean(text))) return record;
    if (record.state !== state && !transitions[record.state]?.has(state)) throw new Error(`invalid request transition from ${record.state}`);
    // Reaching this line with a terminal record means the same final state was
    // replayed with different text. Refuse it without mutating durable history;
    // only exact replay of the recorded result stays idempotent.
    if (TERMINAL_REQUEST_STATES.includes(record.state))
      throw new Error(`request already ${record.state}; recorded result cannot change`);
    const now = this.clock(); record.state = state; record.updated = now;
    record.history = [...record.history, { state, at: now, ...(text ? { text: clean(text) } : {}) }].slice(-32);
    writeJson(this.file(key), record); return record;
  }
  list(route = null) {
    const scope = route ? routeScope(route) : null;
    return fs.readdirSync(this.store.file('requests')).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => this.get(name.slice(0, -5))).filter(Boolean)
      .filter(record => !route || (sameRoute(record.route, route) &&
        (record.routeScope ?? routeScope(record.route, record.provenance)) === scope))
      .sort((a, b) => b.updated - a.updated || a.key.localeCompare(b.key));
  }
  recentContext(route, { exclude, limit = 4, budget = 2400 } = {}) {
    const records = this.list(route).filter(record => record.key !== exclude);
    const open = records.filter(x => !TERMINAL_REQUEST_STATES.includes(x.state)).slice(0, limit);
    const completed = records.find(x => TERMINAL_REQUEST_STATES.includes(x.state));
    // Put the latest result first so open work cannot consume the result budget.
    const selected = completed ? [completed, ...open] : open;
    let output = '';
    for (const record of selected) {
      const meaningful = excerpt(record.history.filter(x => x.state !== 'received' && x.text).slice(-2)
        .map(x => `${x.state}: ${x.text}`).join(' | '), 1000);
      const request = excerpt(record.requestText ?? '[original request content not retained]', 700);
      const row = `${record.key} [${record.state}] request: ${request}` + (meaningful ? ` | response: ${meaningful}` : '') + '\n';
      if (output.length + row.length <= budget) output += row;
      else if (!output) output = row.slice(0, budget);
      else break;
    }
    return output.trimEnd();
  }
  cursorFile(route) { return this.store.file(`summary-${routeScope(route)}.json`); }
  requestRow(record) {
    const updates = record.history.filter(x => x.state !== 'received' && x.text)
      .map(x => `${x.state}: ${x.text}`).join('\n');
    return `Remote request ${record.key.slice(0, 12)} — lifecycle state: ${record.state}\nRequest: ${record.requestText ?? '[original request content not retained]'}` +
      (updates ? `\nRecorded updates:\n${updates}` : '') + '\n';
  }
  requestPage(cursor, route) {
    let output = '';
    // Loop while two units of room remain: a boundary back-off then always
    // leaves progress, and no page can end mid surrogate pair or mid CRLF.
    while (cursor.index < cursor.keys.length && output.length < MAX_PAGE - 1) {
      const record = this.get(cursor.keys[cursor.index]);
      if (!record || (record.routeScope ?? routeScope(record.route, record.provenance)) !== routeScope(route)) {
        cursor.index++; cursor.offset = 0; continue;
      }
      const row = this.requestRow(record);
      const end = safeBoundaryEnd(row, cursor.offset, Math.min(row.length, cursor.offset + (MAX_PAGE - output.length)));
      output += row.slice(cursor.offset, end);
      cursor.offset = end;
      if (cursor.offset >= row.length) { cursor.index++; cursor.offset = 0; if (output.length < MAX_PAGE) output += '\n'; }
    }
    return this.finishPage(cursor, route, output || 'No recorded matching remote requests.');
  }
  textPage(cursor, route) {
    const end = safeBoundaryEnd(cursor.text, cursor.offset, Math.min(cursor.text.length, cursor.offset + MAX_PAGE));
    const output = cursor.text.slice(cursor.offset, end) || 'No recorded matching facts.';
    cursor.offset = end;
    return this.finishPage(cursor, route, output);
  }
  finishPage(cursor, route, output) {
    const more = cursor.kind === 'requests' ? cursor.index < cursor.keys.length : cursor.offset < cursor.text.length;
    if (more) { writeJson(this.cursorFile(route), cursor); return `${output}\nSend more for the next recorded page.`; }
    writeJson(this.cursorFile(route), { kind: 'done', query: cursor.query, at: this.clock() });
    return output;
  }
  paginateText(query, route, text) {
    const cursor = { kind: 'text', query, text: String(text), offset: 0, at: this.clock() };
    return this.textPage(cursor, route);
  }
  summarize(command, route) {
    const lower = command.toLowerCase();
    if (lower === 'more') {
      // A damaged pagination cursor loses only the reading position, never a
      // recorded request; quarantine it and say so instead of failing forever.
      const { record: cursor } = readStoredRecord(this.store.root, this.cursorFile(route),
        { validate: value => value.kind === 'requests' || value.kind === 'text' || value.kind === 'done',
          reason: 'summary cursor failed structural validation' });
      if (cursor?.kind === 'requests') return this.requestPage(cursor, route);
      if (cursor?.kind === 'text') return this.textPage(cursor, route);
      return 'No additional recorded summary page. Repeat a summary command to start again.';
    }
    const all = this.list(route);
    let rows;
    if (lower === 'pending') rows = all.filter(x => !TERMINAL_REQUEST_STATES.includes(x.state));
    else if (lower === 'blocked') rows = all.filter(x => x.state === 'waiting' || x.state === 'failed');
    else if (lower === 'last result') rows = all.filter(x => TERMINAL_REQUEST_STATES.includes(x.state)).slice(0, 1);
    else rows = all;
    const cursor = { kind: 'requests', query: lower, keys: rows.map(x => x.key), index: 0, offset: 0, at: this.clock() };
    return this.requestPage(cursor, route);
  }
}
