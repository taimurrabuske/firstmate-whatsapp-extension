// Bounded local attachment staging and authenticated inbound media handling.
// Baileys is deliberately injected by the caller; this module never fetches URLs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalJid, privateDirectory, readJson, sameRoute, sha256, writeJson, MAX_TEXT } from './core.mjs';
import { VOICE_LIMITS } from './voice.mjs';

export const MEDIA_LIMITS = Object.freeze({ image: 8 * 1024 * 1024, document: 15 * 1024 * 1024, voice: 10 * 1024 * 1024,
  voiceSeconds: VOICE_LIMITS.maxSeconds, name: 120 });
const MIME = Object.freeze({
  '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.png': ['image', 'image/png'], '.webp': ['image', 'image/webp'],
  '.pdf': ['document', 'application/pdf'], '.txt': ['document', 'text/plain'], '.csv': ['document', 'text/csv'],
  '.json': ['document', 'application/json']
});
const INBOUND_MIME = new Map([
  ['image/jpeg', 'image'], ['image/png', 'image'], ['image/webp', 'image'],
  ['application/pdf', 'document'], ['text/plain', 'document'], ['text/csv', 'document'], ['application/json', 'document'],
  ['audio/ogg', 'voice'], ['audio/ogg; codecs=opus', 'voice'], ['audio/mpeg', 'voice'], ['audio/mp4', 'voice']
]);

function directories(store) {
  for (const name of ['attachments', 'attachments/outgoing', 'attachments/incoming']) privateDirectory(store.file(name));
}
function safeName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const name = path.basename(value).normalize('NFC');
  if (!name || name === '.' || name === '..' || Buffer.byteLength(name) > MEDIA_LIMITS.name ||
      /[\u0000-\u001f\u007f]/.test(name) || name !== value) return fallback;
  return name;
}
function regularOpen(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) { fs.closeSync(fd); throw new Error('attachment must be a regular file'); }
  return { fd, stat };
}
function magicOkay(kind, mime, head) {
  if (mime === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mime === 'image/png') return head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/webp') return head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP';
  if (mime === 'application/pdf') return head.subarray(0, 5).toString() === '%PDF-';
  if (kind === 'voice' && mime.startsWith('audio/ogg')) return head.subarray(0, 4).toString() === 'OggS';
  if (kind === 'voice' && mime === 'audio/mpeg') return head.subarray(0, 3).toString() === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
  if (kind === 'voice' && mime === 'audio/mp4') return head.subarray(4, 8).toString() === 'ftyp';
  if (['text/plain', 'text/csv', 'application/json'].includes(mime)) return !head.includes(0);
  return false;
}
function atomicCopyFromFd(store, fd, { bucket, kind, mime, name, maximum }) {
  directories(store);
  const temp = store.file(`attachments/${bucket}/.${crypto.randomUUID()}.tmp`);
  const out = fs.openSync(temp, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  const head = Buffer.alloc(16); let headLength = 0, size = 0;
  try {
    const chunk = Buffer.alloc(64 * 1024); let offset = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (!read) break;
      offset += read; size += read;
      if (size > maximum) throw new Error('attachment exceeds size limit');
      if (headLength < head.length) { const count = Math.min(read, head.length - headLength); chunk.copy(head, headLength, 0, count); headLength += count; }
      hash.update(chunk.subarray(0, read));
      if (fs.writeSync(out, chunk, 0, read) !== read) throw new Error('attachment staging write interrupted');
    }
    fs.fsyncSync(out);
  } catch (error) { fs.closeSync(out); fs.rmSync(temp, { force: true }); throw error; }
  fs.closeSync(out);
  if (!size || !magicOkay(kind, mime, head.subarray(0, headLength))) { fs.rmSync(temp, { force: true }); throw new Error('attachment content does not match allowed MIME type'); }
  const digest = hash.digest('hex');
  const target = store.file(`attachments/${bucket}/${digest}`);
  try { fs.linkSync(temp, target); } catch (error) { if (error.code !== 'EEXIST') { fs.rmSync(temp, { force: true }); throw error; } }
  fs.rmSync(temp, { force: true });
  const meta = { schema: 'fm-whatsapp-attachment.v1', digest, size, mime, kind, name, path: target };
  writeJson(store.file(`attachments/${bucket}/${digest}.json`), meta);
  return meta;
}
function authenticatedRequest(store, requestKey) {
  if (!/^[a-f0-9]{64}$/.test(requestKey ?? '')) throw new Error('invalid authenticated request key');
  const handoff = readJson(store.file(`handoffs/${requestKey}.json`));
  const accepted = store.incoming(requestKey) ?? readJson(store.file(`pending/${requestKey}.json`));
  if (!handoff || !['saved', 'handled'].includes(handoff.phase) || !handoff.route ||
      (accepted && accepted.operation !== 'note') || !sameRoute(handoff.route, store.currentRoute())) {
    throw new Error('attachment requires a published authenticated request on the current route');
  }
  return handoff.route;
}

/** Stage an immutable private copy for reply-file. No URL or relative path is accepted. */
export function stageAttachment(store, file, options = {}) {
  const requestKey = typeof options === 'string' ? options : options.requestKey;
  const route = authenticatedRequest(store, requestKey);
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('attachment path must be absolute');
  const extension = path.extname(file).toLowerCase(), type = MIME[extension];
  if (!type) throw new Error('unsupported attachment type');
  const [kind, mime] = type, opened = regularOpen(file);
  try {
    if (opened.stat.size < 1 || opened.stat.size > MEDIA_LIMITS[kind]) throw new Error('attachment exceeds size limit');
    const meta = atomicCopyFromFd(store, opened.fd, { bucket: 'outgoing', kind, mime,
      name: safeName(path.basename(file), `attachment${extension}`), maximum: MEDIA_LIMITS[kind] });
    return { ...meta, requestKey, route };
  } finally { fs.closeSync(opened.fd); }
}

function verifyStaged(store, attachment) {
  if (attachment?.schema !== 'fm-whatsapp-attachment.v1' || !/^[a-f0-9]{64}$/.test(attachment.digest ?? '') ||
      !['image', 'document'].includes(attachment.kind) || !Number.isInteger(attachment.size)) throw new Error('invalid staged attachment');
  const expected = store.file(`attachments/outgoing/${attachment.digest}`);
  if (attachment.path !== expected) throw new Error('attachment path escaped private store');
  const opened = regularOpen(expected);
  try {
    if (opened.stat.size !== attachment.size || opened.stat.size > MEDIA_LIMITS[attachment.kind]) throw new Error('staged attachment changed');
    const hash = crypto.createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let offset = 0;
    for (;;) { const n = fs.readSync(opened.fd, chunk, 0, chunk.length, offset); if (!n) break; offset += n; hash.update(chunk.subarray(0, n)); }
    if (hash.digest('hex') !== attachment.digest) throw new Error('staged attachment changed');
  } finally { fs.closeSync(opened.fd); }
  return expected;
}

/** Convert a queued attachment job into a Baileys sendMessage payload. */
export function outboundContent(job, store) {
  const attachment = job?.attachment ?? job;
  const file = verifyStaged(store, attachment);
  const caption = typeof job?.text === 'string' && job.text ? job.text : undefined;
  if (attachment.kind === 'image') return { image: { url: file }, mimetype: attachment.mime, caption };
  return { document: { url: file }, mimetype: attachment.mime, fileName: attachment.name, caption };
}

/** Read verified bytes from one no-follow descriptor for non-Baileys transports. */
export function attachmentBytes(job, store) {
  const attachment = job.attachment;
  const file = verifyStaged(store, attachment), opened = regularOpen(file);
  try {
    if (opened.stat.size !== attachment.size || opened.stat.size > MEDIA_LIMITS[attachment.kind]) throw new Error('staged attachment changed');
    const data = Buffer.alloc(attachment.size); let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(opened.fd, data, offset, data.length - offset, offset);
      if (!count) throw new Error('staged attachment changed');
      offset += count;
    }
    if (sha256(data) !== attachment.digest || !magicOkay(attachment.kind, attachment.mime, data.subarray(0, 16))) throw new Error('staged attachment changed');
    return { data, mime: attachment.mime, name: attachment.name };
  } finally { fs.closeSync(opened.fd); }
}

const MAX_INBOUND_TRANSCRIPT = 12_000;

function number(value) {
  try { const result = Number(typeof value === 'object' && value !== null ? value.toString() : value); return Number.isSafeInteger(result) ? result : NaN; }
  catch { return NaN; }
}
function mediaEnvelope(message, identity, now, pairedAt, peer) {
  const key = message?.key, expectedFromMe = !peer;
  if (!identity || key?.fromMe !== expectedFromMe || typeof key.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.id)) return null;
  const aliases = [...(peer ?? identity).aliases];
  if (peer && canonicalJid(key.remoteJidAlt) === peer.account && canonicalJid(key.remoteJid)?.endsWith('@lid')) aliases.push(canonicalJid(key.remoteJid));
  const owns = jid => aliases.includes(canonicalJid(jid));
  if (!owns(key.remoteJid)) return null;
  for (const field of ['remoteJidAlt', 'participant', 'participantAlt']) if (key[field] != null && key[field] !== '' && !owns(key[field])) return null;
  const timestamp = Number(message.messageTimestamp);
  if (!Number.isFinite(timestamp) || timestamp < pairedAt || timestamp < now - 86400 || timestamp > now + 300) return null;
  const content = message.message;
  if (!content) return null;
  const mediaKeys = ['imageMessage', 'documentMessage', 'audioMessage'].filter(name => content[name]);
  if (mediaKeys.length !== 1 || Object.keys(content).some(name => ![mediaKeys[0], 'messageContextInfo'].includes(name))) return null;
  const body = content[mediaKeys[0]], context = body.contextInfo;
  if (body.viewOnce || context?.isForwarded || number(context?.forwardingScore) > 0) return null;
  if (context?.participant && !owns(context.participant) && !(peer && identity.aliases.includes(canonicalJid(context.participant)))) return null;
  if (context?.remoteJid && !owns(context.remoteJid)) return null;
  const mime = String(body.mimetype ?? '').toLowerCase(), kind = INBOUND_MIME.get(mime);
  const expectedKind = mediaKeys[0] === 'imageMessage' ? 'image' : mediaKeys[0] === 'documentMessage' ? 'document' : 'voice';
  const size = number(body.fileLength);
  if (kind !== expectedKind || !Number.isInteger(size) || size < 1 || size > MEDIA_LIMITS[kind]) return null;
  const duration = kind === 'voice' ? number(body.seconds) : 0;
  if (kind === 'voice' && (body.ptt !== true || !Number.isInteger(duration) || duration < 1 || duration > MEDIA_LIMITS.voiceSeconds)) return null;
  return { id: key.id, key: sha256(`${identity.account}\n${peer ? `${peer.account}\n` : ''}${key.id}`), kind, mime, size, duration,
    name: safeName(body.fileName, kind === 'image' ? `image-${key.id}` : kind === 'voice' ? `voice-${key.id}` : `document-${key.id}`) };
}

export function authenticateMediaMetadata(message, identity, now, pairedAt, peer = null) {
  return mediaEnvelope(message, identity, now, pairedAt, peer);
}
async function writeDownload(store, source, metadata) {
  directories(store);
  const temp = store.file(`attachments/incoming/.download-${crypto.randomUUID()}.tmp`), fd = fs.openSync(temp, 'wx', 0o600);
  let size = 0;
  try {
    const iterable = Buffer.isBuffer(source) ? [source] : source;
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function' && typeof iterable[Symbol.iterator] !== 'function') throw new Error('media downloader returned no byte stream');
    for await (const value of iterable) {
      const chunk = Buffer.from(value); size += chunk.length;
      if (size > metadata.size || size > MEDIA_LIMITS[metadata.kind]) throw new Error('download exceeded declared media size');
      if (fs.writeSync(fd, chunk, 0, chunk.length) !== chunk.length) throw new Error('media download write interrupted');
    }
    fs.fsyncSync(fd);
  } catch (error) { fs.closeSync(fd); fs.rmSync(temp, { force: true }); throw error; }
  fs.closeSync(fd);
  if (size !== metadata.size) { fs.rmSync(temp, { force: true }); throw new Error('download size did not match authenticated metadata'); }
  const opened = regularOpen(temp);
  try { return atomicCopyFromFd(store, opened.fd, { bucket: 'incoming', kind: metadata.kind, mime: metadata.mime,
    name: metadata.name, maximum: MEDIA_LIMITS[metadata.kind] }); }
  finally { fs.closeSync(opened.fd); fs.rmSync(temp, { force: true }); }
}

/** Authenticate metadata first, then invoke the injected Baileys downloader and return surrogate request text. */
export async function authenticatedMediaMessage(message, identity, now, pairedAt, peer, { store, download, transcribe } = {}) {
  const metadata = mediaEnvelope(message, identity, now, pairedAt, peer);
  if (!metadata || typeof download !== 'function' || !store) return null;
  const attachment = await writeDownload(store, await download(message, metadata), metadata);
  let detail = '';
  if (metadata.kind === 'voice') {
    const result = typeof transcribe === 'function' ? await transcribe(attachment.path, metadata) :
      { available: false, message: 'Voice transcription is unavailable; configure private offline whisper.cpp and ffmpeg paths.' };
    if (result?.available && typeof result.text === 'string' && result.text.trim() &&
        result.text.length <= MAX_INBOUND_TRANSCRIPT) {
      const transcript = store.file(`attachments/incoming/${attachment.digest}.transcript.txt`);
      fs.writeFileSync(transcript, result.text, { mode: 0o600 });
      detail = `\nAuthenticated instruction (local whisper.cpp transcript of this voice note; the paired phone's spoken note text, delivered without any caption):\n` +
        `Full private transcript (read completely): ${transcript}\n` +
        `Bounded transcript preview (start):\n${result.text.slice(0, 2200)}\nBounded transcript preview (end).`;
    } else detail = `\n${result?.message || 'Voice transcription returned no usable text.'}`;
  }
  const label = metadata.kind === 'voice' ? 'voice note' : metadata.kind;
  return { ...metadata, attachment, text: `WhatsApp ${label} received (remote; away mode unchanged).\nLocal attachment: ${attachment.path}\nMIME: ${attachment.mime}; bytes: ${attachment.size}.${detail}`.slice(0, MAX_TEXT) };
}
