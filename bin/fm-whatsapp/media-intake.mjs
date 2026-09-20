// Journal encrypted media locators before asynchronous download/transcription.
import fs from 'node:fs';
import { readJson, writeJson, privateDirectory, epoch, sameRoute } from './core.mjs';
import { authenticateMediaMetadata, authenticatedMediaMessage } from './media.mjs';

export class MediaIntake {
  constructor({ store, bridge, encode, decode, download, transcribe, clock = epoch }) {
    Object.assign(this, { store, bridge, encode, decode, download, transcribe, clock });
    privateDirectory(store.file('media-pending'));
  }
  stage(batch) {
    if (batch.type !== 'notify') return;
    for (const message of (batch.messages ?? []).slice(0, 100)) {
      const meta = authenticateMediaMetadata(message, this.bridge.identity, this.clock(), this.bridge.pairedAt, this.bridge.peer);
      if (!meta || this.store.incoming(meta.key) || readJson(this.store.file(`pending/${meta.key}.json`)) ||
          readJson(this.store.file(`media-pending/${meta.key}.json`))) continue;
      if (this.store.records('media-pending').length >= 100) throw new Error('media intake full');
      const encoded = Buffer.from(this.encode(message)).toString('base64');
      if (encoded.length > 131072) throw new Error('media envelope too large');
      writeJson(this.store.file(`media-pending/${meta.key}.json`), { key: meta.key, encoded,
        route: this.store.currentRoute(), attempts: 0, next: 0 });
    }
  }
  async processOne() {
    if (!this.bridge.connected) return;
    for (const name of this.store.records('media-pending')) {
      const file = this.store.file(`media-pending/${name}`), job = readJson(file);
      if (!sameRoute(job.route, this.store.currentRoute()) || job.attempts >= 3 || job.next > this.clock()) continue;
      if (this.store.incoming(job.key) || readJson(this.store.file(`pending/${job.key}.json`))) { fs.unlinkSync(file); continue; }
      try {
        const message = this.decode(Buffer.from(job.encoded, 'base64'));
        const accepted = await authenticatedMediaMessage(message, this.bridge.identity, this.clock(), this.bridge.pairedAt,
          this.bridge.peer, { store: this.store, download: this.download, transcribe: this.transcribe });
        if (!accepted) throw new Error('media no longer eligible');
        if (!this.bridge.connected) return; // Keep the durable locator for the next connected pass.
        this.bridge.stage({ type: 'notify', messages: [{ ...message, message: { conversation: accepted.text } }] });
        if (!readJson(this.store.file(`pending/${job.key}.json`)) && !this.store.incoming(job.key)) throw new Error('media handoff not staged');
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
