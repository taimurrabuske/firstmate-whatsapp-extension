// Durable, transport-neutral request lifecycle, bounded context, and summaries.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { privateDirectory, readJson, writeJson, sameRoute, validText } from './core.mjs';

export const REQUEST_STATES = ['received', 'picked-up', 'working', 'waiting', 'completed', 'failed'];
const transitions = {
  received: new Set(['picked-up', 'working', 'waiting', 'failed']),
  'picked-up': new Set(['working', 'waiting', 'completed', 'failed']),
  working: new Set(['picked-up', 'waiting', 'completed', 'failed']),
  waiting: new Set(['picked-up', 'working', 'completed', 'failed']),
  completed: new Set(), failed: new Set()
};
const validKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
const clean = text => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const excerpt = (text, limit) => text.length <= limit ? text : `${text.slice(0, Math.floor(limit * 0.7))} … ${text.slice(-(limit - Math.floor(limit * 0.7) - 3))}`;
const MAX_PAGE = 3300;
const routeScope = (route, provenance = route?.provenance ?? 'whatsapp') => crypto.createHash('sha256').update(JSON.stringify({
  provenance,
  credential: route?.credentialFingerprint ?? route?.account,
  recipient: route?.recipient
})).digest('hex');

export class RequestJournal {
  constructor(store, clock = () => Math.floor(Date.now() / 1000)) {
    this.store = store; this.clock = clock;
    privateDirectory(store.file('requests'));
  }
  file(key) { if (!validKey(key)) throw new Error('invalid request identity'); return this.store.file(`requests/${key}.json`); }
  get(key) { return readJson(this.file(key)); }
  receive(key, { route, text, quoted = null, decision = null, provenance = 'whatsapp' }) {
    if (!validText(text)) throw new Error('invalid request text');
    const file = this.file(key), existing = readJson(file);
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
    if (!REQUEST_STATES.includes(state) || (text && !validText(text))) throw new Error('invalid request progress');
    const file = this.file(key), record = readJson(file);
    if (!record) throw new Error('unknown request identity');
    if (record.state === state) return record;
    if (!transitions[record.state]?.has(state)) throw new Error(`invalid request transition from ${record.state}`);
    const now = this.clock(); record.state = state; record.updated = now;
    record.history = [...record.history, { state, at: now, ...(text ? { text: clean(text) } : {}) }].slice(-32);
    writeJson(file, record); return record;
  }
  list(route = null) {
    const scope = route ? routeScope(route) : null;
    return fs.readdirSync(this.store.file('requests')).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => readJson(this.store.file(`requests/${name}`))).filter(Boolean)
      .filter(record => !route || (sameRoute(record.route, route) &&
        (record.routeScope ?? routeScope(record.route, record.provenance)) === scope))
      .sort((a, b) => b.updated - a.updated || a.key.localeCompare(b.key));
  }
  recentContext(route, { exclude, limit = 4, budget = 2400 } = {}) {
    const records = this.list(route).filter(record => record.key !== exclude);
    const open = records.filter(x => !['completed', 'failed'].includes(x.state)).slice(0, limit);
    const completed = records.find(x => ['completed', 'failed'].includes(x.state));
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
    while (cursor.index < cursor.keys.length && output.length < MAX_PAGE) {
      const record = this.get(cursor.keys[cursor.index]);
      if (!record || (record.routeScope ?? routeScope(record.route, record.provenance)) !== routeScope(route)) {
        cursor.index++; cursor.offset = 0; continue;
      }
      const row = this.requestRow(record), room = MAX_PAGE - output.length;
      output += row.slice(cursor.offset, cursor.offset + room);
      cursor.offset += room;
      if (cursor.offset >= row.length) { cursor.index++; cursor.offset = 0; if (output.length < MAX_PAGE) output += '\n'; }
    }
    return this.finishPage(cursor, route, output || 'No recorded matching remote requests.');
  }
  textPage(cursor, route) {
    const output = cursor.text.slice(cursor.offset, cursor.offset + MAX_PAGE) || 'No recorded matching facts.';
    cursor.offset += Math.min(MAX_PAGE, Math.max(0, cursor.text.length - cursor.offset));
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
      const cursor = readJson(this.cursorFile(route));
      if (cursor?.kind === 'requests') return this.requestPage(cursor, route);
      if (cursor?.kind === 'text') return this.textPage(cursor, route);
      return 'No additional recorded summary page. Repeat a summary command to start again.';
    }
    const all = this.list(route);
    let rows;
    if (lower === 'pending') rows = all.filter(x => !['completed', 'failed'].includes(x.state));
    else if (lower === 'blocked') rows = all.filter(x => x.state === 'waiting' || x.state === 'failed');
    else if (lower === 'last result') rows = all.filter(x => ['completed', 'failed'].includes(x.state)).slice(0, 1);
    else rows = all;
    const cursor = { kind: 'requests', query: lower, keys: rows.map(x => x.key), index: 0, offset: 0, at: this.clock() };
    return this.requestPage(cursor, route);
  }
}
