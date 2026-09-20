// Durable, transport-neutral request lifecycle and bounded conversation index.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { privateDirectory, readJson, writeJson, sameRoute, validText } from './core.mjs';

export const REQUEST_STATES = ['received', 'picked-up', 'working', 'waiting', 'completed', 'failed'];
const transitions = {
  received: new Set(['picked-up', 'working', 'waiting', 'failed']),
  'picked-up': new Set(['working', 'waiting', 'completed', 'failed']),
  working: new Set(['waiting', 'completed', 'failed']),
  waiting: new Set(['working', 'completed', 'failed']),
  completed: new Set(), failed: new Set()
};
const validKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);

export class RequestJournal {
  constructor(store, clock = () => Math.floor(Date.now() / 1000)) {
    this.store = store; this.clock = clock;
    privateDirectory(store.file('requests'));
  }
  file(key) { if (!validKey(key)) throw new Error('invalid request identity'); return this.store.file(`requests/${key}.json`); }
  get(key) { return readJson(this.file(key)); }
  receive(key, { route, text, quoted = null, decision = null, provenance = 'whatsapp' }) {
    const file = this.file(key), existing = readJson(file);
    const digest = crypto.createHash('sha256').update(text).digest('hex');
    if (existing) {
      if (existing.textDigest !== digest || !sameRoute(existing.route, route)) throw new Error('request identity changed');
      return existing;
    }
    const now = this.clock();
    const record = { schema: 'fm-remote-request.v1', key, route, provenance, textDigest: digest,
      state: 'received', received: now, updated: now, quoted, decision,
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
    record.history = [...record.history, { state, at: now, ...(text ? { text } : {}) }].slice(-32);
    writeJson(file, record); return record;
  }
  list(route = null) {
    return fs.readdirSync(this.store.file('requests')).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => readJson(this.store.file(`requests/${name}`))).filter(Boolean)
      .filter(record => !route || sameRoute(record.route, route)).sort((a, b) => b.updated - a.updated || a.key.localeCompare(b.key));
  }
  recentContext(route, { exclude, limit = 4 } = {}) {
    return this.list(route).filter(record => record.key !== exclude && !['completed', 'failed'].includes(record.state)).slice(0, limit)
      .map(record => ({ key: record.key, state: record.state }));
  }
  summarize(command, route, pageSize = 8) {
    const all = this.list(route), lower = command.toLowerCase();
    let rows;
    if (lower === 'pending') rows = all.filter(x => !['completed', 'failed'].includes(x.state));
    else if (lower === 'blocked') rows = all.filter(x => x.state === 'waiting' || x.state === 'failed');
    else if (lower === 'last result') rows = all.filter(x => ['completed', 'failed'].includes(x.state)).slice(0, 1);
    else rows = all;
    const cursorFile = this.store.file(`summary-${crypto.createHash('sha256').update(`${route.account}\n${route.recipient}`).digest('hex')}.json`);
    let offset = 0;
    if (lower === 'more') { const cursor = readJson(cursorFile); rows = all; offset = cursor?.offset ?? 0; }
    const page = rows.slice(offset, offset + pageSize);
    writeJson(cursorFile, { offset: offset + page.length >= rows.length ? 0 : offset + page.length });
    if (!page.length) return 'No recorded matching requests.';
    const rendered = page.map(x => `${x.key.slice(0, 12)} ${x.state}${x.history.at(-1)?.text ? ` — ${x.history.at(-1).text}` : ''}`);
    if (offset + page.length < rows.length) rendered.push(`Send more for ${rows.length - offset - page.length} more.`);
    return rendered.join('\n');
  }
}
