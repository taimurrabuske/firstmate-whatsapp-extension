// Journal encrypted media locators before asynchronous download/transcription.
import fs from 'node:fs';
import { readStoredRecord, writeJson, privateDirectory, epoch, sameRoute } from './core.mjs';
import { authenticateMediaMetadata, authenticatedMediaMessage } from './media.mjs';

// Only our own hidden artifacts match: staging temps are dot-prefixed .tmp files
// and voice work directories are UUID-named. Real attachments and transcripts never match.
const TEMP_ARTIFACT = /^\..+\.tmp$/;
const TRANSCRIPTION_WORK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Longer than any in-flight decode + transcription (35 minutes of bounded subprocess runtime).
const TEMP_MAX_AGE = 3600;

function listDirectory(directory) {
  try { return fs.readdirSync(directory); } catch { return []; }
}
function staleArtifact(file, cutoff, predicate) {
  try {
    const stat = fs.lstatSync(file);
    return (stat.isFile() || stat.isSymbolicLink() || stat.isDirectory()) && stat.mtimeMs / 1000 < cutoff && predicate(stat);
  } catch { return false; }
}

/** Remove private temporaries left by interrupted downloads, staging copies, or transcription runs. */
export function sweepStaleTemporaries(store, { now = epoch(), maxAgeSeconds = TEMP_MAX_AGE } = {}) {
  const cutoff = now - maxAgeSeconds, removed = [];
  for (const bucket of ['attachments', 'attachments/incoming', 'attachments/outgoing']) {
    for (const entry of listDirectory(store.file(bucket))) {
      if (!TEMP_ARTIFACT.test(entry)) continue;
      const file = store.file(`${bucket}/${entry}`);
      if (!staleArtifact(file, cutoff, stat => stat.isFile() || stat.isSymbolicLink())) continue;
      try { fs.rmSync(file, { force: true }); removed.push(file); } catch { /* retained for the next pass */ }
    }
  }
  for (const entry of listDirectory(store.file('voice-tmp'))) {
    if (!TRANSCRIPTION_WORK.test(entry)) continue;
    const work = store.file(`voice-tmp/${entry}`);
    if (!staleArtifact(work, cutoff, stat => stat.isDirectory())) continue;
    try { fs.rmSync(work, { recursive: true, force: true }); removed.push(work); } catch { /* retained for the next pass */ }
  }
  return removed;
}

export class MediaIntake {
  constructor({ store, bridge, encode, decode, download, transcribe, clock = epoch }) {
    Object.assign(this, { store, bridge, encode, decode, download, transcribe, clock });
    privateDirectory(store.file('media-pending'));
    sweepStaleTemporaries(store, { now: this.clock() });
  }
  stage(batch) {
    if (batch.type !== 'notify') return;
    for (const message of (batch.messages ?? []).slice(0, 100)) {
      // Our own outbound media echo is transport feedback, never inbound intake.
      if (this.store.sentByRemoteId(message?.key?.id)) continue;
      const meta = authenticateMediaMetadata(message, this.bridge.identity, this.clock(), this.bridge.pairedAt, this.bridge.peer);
      if (!meta || this.store.incoming(meta.key) || readStoredRecord(this.store.root, this.store.file(`pending/${meta.key}.json`)).record ||
          readStoredRecord(this.store.root, this.store.file(`media-pending/${meta.key}.json`)).record) continue;
      if (this.store.records('media-pending').length >= 100) throw new Error('media intake full');
      const encoded = Buffer.from(this.encode(message)).toString('base64');
      if (encoded.length > 131072) {
        // One poisoned envelope must not discard the rest of the batch.
        this.bridge.problem = 'a media envelope exceeded the local staging bound and was not retained';
        this.bridge.health();
        continue;
      }
      writeJson(this.store.file(`media-pending/${meta.key}.json`), { key: meta.key, encoded,
        route: this.store.currentRoute(), attempts: 0, next: 0 });
    }
  }
  async processOne() {
    if (!this.bridge.connected) return;
    for (const name of this.store.records('media-pending')) {
      const file = this.store.file(`media-pending/${name}`), { record: job } = readStoredRecord(this.store.root, file);
      if (!job || !sameRoute(job.route, this.store.currentRoute()) || job.attempts >= 3 || job.next > this.clock()) continue;
      if (this.store.incoming(job.key) || readStoredRecord(this.store.root, this.store.file(`pending/${job.key}.json`)).record) { fs.unlinkSync(file); continue; }
      try {
        const message = this.decode(Buffer.from(job.encoded, 'base64'));
        if (this.store.sentByRemoteId(message.key?.id)) { fs.unlinkSync(file); continue; } // our own outbound echo
        const accepted = await authenticatedMediaMessage(message, this.bridge.identity, this.clock(), this.bridge.pairedAt,
          this.bridge.peer, { store: this.store, download: this.download, transcribe: this.transcribe });
        if (!accepted) throw new Error('media no longer eligible');
        if (!this.bridge.connected) return; // Keep the durable locator for the next connected pass.
        this.bridge.stage({ type: 'notify', messages: [{ ...message, message: { conversation: accepted.text } }] });
        if (!readStoredRecord(this.store.root, this.store.file(`pending/${job.key}.json`)).record && !this.store.incoming(job.key)) throw new Error('media handoff not staged');
        fs.unlinkSync(file);
      } catch {
        job.attempts++; job.next = this.clock() + Math.min(300, 10 * 2 ** job.attempts);
        writeJson(file, job);
        if (job.attempts === 3) this.store.enqueue('I could not process that attachment locally. It is retained privately; send the request as text or resend the attachment.',
          { kind: 'reply', session: '', route: job.route, id: `media-failed:${job.key}` });
      }
      return;
    }
  }
}
