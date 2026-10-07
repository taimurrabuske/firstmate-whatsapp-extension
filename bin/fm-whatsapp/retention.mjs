// Bounded retention and quarantine accounting for private durable state.
// Deletion policy, in one place: only proven terminal artifacts are removed
// (handled handoffs of terminal requests, terminal request records, and
// attachment content past the horizon that no unresolved record still
// references). Open requests, uncertain handoffs, pending replies, and
// undelivered queue entries are never deleted; send-receipt expiry stays in
// `Store.pruneSent` on its own 24-hour boundary. Damaged or incompatible
// records are never deleted at all: readers quarantine them byte-preserved.
import fs from 'node:fs';
import path from 'node:path';
import { epoch, readStoredRecord } from './core.mjs';
import { TERMINAL_REQUEST_STATES } from './requests.mjs';

export const RETENTION = Object.freeze({ seconds: 30 * 86400, litterSeconds: 3600 });
export const QUARANTINE_INSPECTION_LIMIT = 100;

const HEX_JSON = name => /^[a-f0-9]{64}\.json$/.test(name);
const DIGEST = name => /^[a-f0-9]{64}$/.test(name);
// Buckets whose writeJson/enqueue staging leaves `.tmp` litter after a crash.
// `auth` is intentionally absent: the transport owns those files.
const LITTER_BUCKETS = ['outbox', 'pending', 'media-pending', 'telegram-pending', 'sent', 'incoming', 'handoffs', 'requests'];

function listBucket(store, bucket) {
  try { return fs.readdirSync(store.file(bucket)); } catch { return []; }
}
function safeStat(file) { try { return fs.lstatSync(file); } catch { return null; } }

/** Count quarantined records (metadata sidecars excluded) without reading their contents. */
export function quarantineSummary(root) {
  const summary = { records: 0, bytes: 0 };
  let buckets;
  try { buckets = fs.readdirSync(path.join(root, 'quarantine')); } catch { return summary; }
  for (const bucket of buckets) {
    const directory = path.join(root, 'quarantine', bucket);
    const stat = safeStat(directory);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    for (const entry of fs.readdirSync(directory)) {
      if (entry.endsWith('.meta.json')) continue;
      const fileStat = safeStat(path.join(directory, entry));
      if (!fileStat) continue;
      summary.records += 1;
      summary.bytes += fileStat.size;
    }
  }
  return summary;
}

/**
 * One bounded retention pass. `requests` (a RequestJournal) enables handoff and
 * journal pruning; every phase is independent, so a partial pass simply retries
 * on the next tick. Returns deletion counts for tests and diagnostics.
 */
export function retainPrivateState(store, requests = null, { now = epoch(), seconds = RETENTION.seconds } = {}) {
  const horizon = now - seconds;
  const report = { handoffs: 0, requests: 0, attachments: 0, temporaries: 0 };

  if (requests) {
    // Handoff receipts of terminal requests whose inbox note Firstmate handled.
    // Uncertain, calling, and saved receipts always stay: publication is not
    // yet proved handled, so the envelope must remain recoverable.
    for (const name of listBucket(store, 'handoffs').filter(HEX_JSON)) {
      const file = store.file(`handoffs/${name}`);
      const { record: receipt } = readStoredRecord(store.root, file);
      if (receipt?.phase !== 'handled' || !Number.isFinite(receipt.created) || receipt.created >= horizon) continue;
      const request = requests.get(name.slice(0, -5));
      if (!request || !TERMINAL_REQUEST_STATES.includes(request.state)) continue;
      fs.unlinkSync(file);
      report.handoffs++;
    }
    // Terminal request records past the horizon, but only once no unhandled
    // handoff receipt still needs the journal for context. Open records never go.
    for (const name of listBucket(store, 'requests').filter(HEX_JSON)) {
      const file = store.file(`requests/${name}`);
      const { record } = readStoredRecord(store.root, file);
      if (!record || !TERMINAL_REQUEST_STATES.includes(record.state)) continue;
      if (!Number.isFinite(record.updated) || record.updated >= horizon) continue;
      const { record: receipt } = readStoredRecord(store.root, store.file(`handoffs/${name}`));
      if (receipt && receipt.phase !== 'handled') continue;
      fs.unlinkSync(file);
      report.requests++;
    }
  }

  // Attachment content past the horizon that nothing unresolved references.
  // Undelivered queue entries protect their staged attachment by digest, and
  // any pending job, handoff envelope, or journaled request text protects the
  // exact paths it names (including transcripts) no matter how old they are.
  const protectedDigests = new Set(), protectedBodies = [];
  for (const name of store.records('outbox')) {
    const { record: job } = readStoredRecord(store.root, store.file(`outbox/${name}`));
    const digest = job?.attachment?.digest;
    if (typeof digest === 'string' && DIGEST(digest)) protectedDigests.add(digest);
  }
  for (const bucket of ['pending', 'handoffs', 'requests', 'telegram-pending']) {
    for (const name of listBucket(store, bucket).filter(HEX_JSON)) {
      const { record } = readStoredRecord(store.root, store.file(`${bucket}/${name}`));
      if (typeof record?.body === 'string') protectedBodies.push(record.body);
      if (typeof record?.requestText === 'string') protectedBodies.push(record.requestText);
      // A Telegram media job carries its surrogate text before any handoff body exists.
      if (bucket === 'telegram-pending' && typeof record?.text === 'string') protectedBodies.push(record.text);
    }
  }
  for (const bucket of ['attachments/outgoing', 'attachments/incoming']) {
    for (const digest of listBucket(store, bucket).filter(DIGEST)) {
      const blob = store.file(`${bucket}/${digest}`);
      const stat = safeStat(blob);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.mtimeMs / 1000 >= horizon) continue;
      const transcript = `${blob}.transcript.txt`;
      if (protectedDigests.has(digest) || protectedBodies.some(body => body.includes(blob) || body.includes(transcript))) continue;
      for (const file of [blob, `${blob}.json`, transcript]) fs.rmSync(file, { force: true });
      report.attachments++;
    }
  }

  // Crash leftovers from atomic writes: only our own `.tmp` names, only files,
  // and only after an hour. Real records never match the pattern.
  for (const bucket of [...LITTER_BUCKETS, '.']) {
    const directory = bucket === '.' ? store.root : store.file(bucket);
    let entries;
    try { entries = fs.readdirSync(directory); } catch { continue; }
    for (const entry of entries) {
      if (!/\.(tmp)$/.test(entry)) continue;
      const file = path.join(directory, entry);
      const stat = safeStat(file);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.mtimeMs / 1000 >= now - RETENTION.litterSeconds) continue;
      fs.rmSync(file, { force: true });
      report.temporaries++;
    }
  }
  return report;
}
