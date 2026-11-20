// Optional, explicitly paired fallback. Tokens never enter queues or diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, readStoredRecord, queuedJobShape, writeJson, privateDirectory, sha256, epoch, validText, parseRequest, PREFIX, sameRoute, plainRecord,
  truncateText, outboundOrder, REMOTE_HELP } from './core.mjs';
import { MEDIA_LIMITS, inboundKind, inboundName, positiveDimension, stageInboundMedia, inboundMediaText } from './media.mjs';

// Telegram's Bot API serves downloads of at most 20 MB; every local limit is lower.
const FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const FILE_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;
const MEDIA_ATTEMPTS = 3;
const MEDIA_FAILURES_KEPT = 5;
// Media failures carry a stage from a closed vocabulary of lowercase words,
// HTTP statuses and Bot API error codes. Remote descriptions, URLs and tokens
// never become part of a stage, so stages are safe to persist, log and reply with.
const STAGE = /^[a-z][a-z0-9-]{0,47}$/;
// Known Bot API refusal descriptions, reduced to a closed reason; the remote text itself is never kept.
const REFUSALS = [[/file is too big/i, 'too-big'], [/temporarily unavailable/i, 'temporarily-unavailable'],
  [/file_id/i, 'invalid-file-id'], [/too many requests/i, 'rate-limited']];

/** A Telegram transport failure whose `stage` names where it happened and never carries secrets. */
export class TelegramFailure extends Error {
  constructor(message, stage) { super(message); this.stage = STAGE.test(stage ?? '') ? stage : 'unknown'; }
}
const timedOut = error => error?.name === 'TimeoutError';

// The person's reply after the final failed attempt says what actually happened:
// a download failure kept nothing, a content mismatch was refused, and only a
// failure after staging leaves the download retained.
function mediaFailedText(stage, retained) {
  if (/^(getfile|file-|download)/.test(stage)) return `I could not download that attachment from Telegram (${stage}), so nothing was saved here. Please resend it, or send the request as text.`;
  if (/^(size|content)-/.test(stage)) return `That attachment did not match what Telegram declared for it (${stage}), so it was refused and not kept. Please resend it, or send the request as text.`;
  return `I downloaded that attachment but could not prepare it locally (${stage}).${retained ? ' The download is retained privately for inspection.' : ''} Please resend it, or send the request as text.`;
}
function failureStage(phase, error) {
  if (typeof error?.stage === 'string' && STAGE.test(error.stage)) return error.stage;
  if (timedOut(error)) return `${phase}-timeout`;
  return phase === 'download' ? 'download-unknown' : phase === 'stage' ? 'stage-io' : 'describe-failed';
}

function tokenAt(file) {
  if (!path.isAbsolute(file)) throw new Error('Telegram token file must be absolute');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let token;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
        (stat.mode & 0o077) || stat.size > 1024 || fs.realpathSync(file) !== file) throw new Error('unsafe Telegram token file');
    token = fs.readFileSync(fd, 'utf8').trim();
  } finally { fs.closeSync(fd); }
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error('invalid Telegram token file');
  return token;
}
export function telegramConfig(store) {
  const config = readJson(store.file('telegram.json'));
  if (!config || config.enabled === false) return null;
  if (config.schema !== 'firstmate.telegram.v1' || !/^\d{1,20}$/.test(config.userId) ||
      config.chatId !== config.userId || !Number.isInteger(config.enabledAt) ||
      !Number.isInteger(config.fallbackAfterSeconds) || config.fallbackAfterSeconds < 30 || config.fallbackAfterSeconds > 3600) {
    throw new Error('invalid Telegram configuration');
  }
  const token = tokenAt(config.tokenFile);
  return { ...config, token, route: { transport: 'telegram', account: `telegram:${token.split(':')[0]}`,
    recipient: `telegram:${config.chatId}`, credentialDigest: sha256(token) } };
}
// Whether a fallback is explicitly configured, decided without reading the token
// file. Lifecycle keep-alive decisions use this so a transiently unreadable
// token cannot stop a configured fallback; delivery and its recovery remain the
// tick's concern, which already reports and retries such failures.
export function telegramConfigured(store) {
  try {
    const config = readJson(store.file('telegram.json'));
    return Boolean(config && config.enabled !== false);
  } catch { return false; }
}
export function telegramStore(store) {
  const scoped = Object.create(store);
  scoped.currentRoute = () => {
    const config = telegramConfig(store);
    if (!config) throw new Error('Telegram is not configured');
    return config.route;
  };
  return scoped;
}

export class TelegramClient {
  constructor(config, fetcher = fetch, { timeouts = {} } = {}) {
    this.config = config; this.fetcher = fetcher; this.timeouts = { request: 15000, download: 60000, ...timeouts };
  }
  async call(method, data) {
    const multipart = data instanceof FormData;
    let stage = 'network';
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.config.token}/${method}`, {
        method: 'POST', headers: multipart ? undefined : { 'content-type': 'application/json' },
        body: multipart ? data : JSON.stringify(data), signal: AbortSignal.timeout(this.timeouts.request), redirect: 'error' });
      const text = typeof response?.text === 'function' ? await response.text() : '';
      if (text.length > 2_000_000) { stage = 'oversized-response'; throw new Error('oversized'); }
      let result = null;
      try { result = JSON.parse(text); } catch { result = null; }
      if (!response.ok || result?.ok !== true) {
        const code = Number.isSafeInteger(result?.error_code) ? result.error_code : Number.isSafeInteger(response.status) ? response.status : 0;
        const reason = typeof result?.description === 'string' ? REFUSALS.find(([pattern]) => pattern.test(result.description))?.[1] : undefined;
        stage = `refused-${Math.abs(code)}${reason ? `-${reason}` : ''}`;
        throw new Error('refused');
      }
      return result.result;
    } catch (error) {
      if (timedOut(error)) stage = 'timeout';
      throw new TelegramFailure('Telegram request failed; details omitted', `${method.toLowerCase()}-${stage}`);
    }
  }
  updates(offset) { return this.call('getUpdates', { offset, timeout: 0, limit: 50, allowed_updates: ['message'] }); }
  /**
   * Stream one authenticated inbound file. The token-bearing download URL is
   * never returned, persisted or included in an error.
   */
  async download(fileId, maximum) {
    if (!FILE_ID.test(fileId ?? '') || !Number.isInteger(maximum) || maximum < 1) throw new TelegramFailure('invalid Telegram file request', 'file-request-invalid');
    const file = await this.call('getFile', { file_id: fileId });
    const unavailable = stage => new TelegramFailure('Telegram file unavailable or oversized', stage);
    if (typeof file?.file_path !== 'string' || !FILE_PATH.test(file.file_path) || file.file_path.split('/').includes('..')) throw unavailable('file-metadata-path');
    if (file.file_size == null) throw unavailable('file-metadata-size-missing');
    if (!Number.isInteger(file.file_size) || file.file_size < 1) throw unavailable('file-metadata-size-invalid');
    if (file.file_size > maximum) throw unavailable('file-metadata-size-over');
    const failed = stage => new TelegramFailure('Telegram download failed; details omitted', stage);
    let response;
    try {
      response = await this.fetcher(`https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`,
        { method: 'GET', signal: AbortSignal.timeout(this.timeouts.download), redirect: 'error' });
    } catch (error) { throw failed(timedOut(error) ? 'download-timeout' : 'download-network'); }
    if (!response?.ok) throw failed(`download-http-${Number.isSafeInteger(response?.status) ? Math.abs(response.status) : 0}`);
    if (!response.body) throw failed('download-empty');
    // Errors while the body streams are classified too, never passed through raw.
    const body = response.body;
    return (async function* stream() {
      try { for await (const chunk of body) yield chunk; }
      catch (error) { throw failed(timedOut(error) ? 'download-stream-timeout' : 'download-stream'); }
    })();
  }
  async send(text, attachment) {
    let result;
    if (attachment) {
      if (!Buffer.isBuffer(attachment.data) || attachment.data.length > 15 * 1024 * 1024 ||
          !attachment.data.length || !['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain', 'text/csv', 'application/json'].includes(attachment.mime) ||
          typeof attachment.name !== 'string' || path.basename(attachment.name) !== attachment.name || /[\x00-\x1f]/.test(attachment.name)) throw new Error('invalid Telegram attachment');
      const body = new FormData();
      body.set('chat_id', this.config.chatId);
      body.set('caption', truncateText(text, 1024));
      body.set('document', new Blob([attachment.data], { type: attachment.mime }), attachment.name);
      result = await this.call('sendDocument', body);
    } else result = await this.call('sendMessage', { chat_id: this.config.chatId, text, link_preview_options: { is_disabled: true } });
    if (!Number.isSafeInteger(result?.message_id) || String(result.chat?.id) !== this.config.chatId) throw new Error('unconfirmed Telegram send');
    return `TG_${result.message_id}`;
  }
}

export async function configureTelegram(store, tokenFile, userId, { fetcher = fetch, now = epoch() } = {}) {
  if (!/^\d{1,20}$/.test(userId)) throw new Error('use the exact private Telegram user ID');
  const token = tokenAt(tokenFile);
  const me = await new TelegramClient({ token }, fetcher).call('getMe', {});
  if (!me?.is_bot || String(me.id) !== token.split(':')[0]) throw new Error('Telegram bot identity mismatch');
  // Existing routes must not silently migrate to another bot or recipient.
  const pendingDir = store.file('telegram-pending');
  if (store.records('outbox').length || (fs.existsSync(pendingDir) && store.records('telegram-pending').length) ||
      fs.existsSync(store.file('run.lock'))) throw new Error('stop bridge and finish pending work before pairing Telegram');
  const previous = readJson(store.file('telegram.json'));
  if (previous && (previous.userId !== userId || tokenAt(previous.tokenFile).split(':')[0] !== String(me.id))) {
    throw new Error('retire the existing Telegram binding before selecting another bot or recipient');
  }
  writeJson(store.file('telegram.json'), { schema: 'firstmate.telegram.v1', enabled: true,
    tokenFile, userId, chatId: userId, enabledAt: previous?.enabledAt ?? now, fallbackAfterSeconds: 120,
    whatsappRoute: store.currentRoute() });
}

const MEDIA_FIELDS = ['voice', 'audio', 'photo', 'document', 'video', 'video_note', 'animation', 'sticker', 'contact', 'location', 'venue', 'poll', 'dice'];
// Exactly one supported media field, validated against the same limits and
// MIME allowlist WhatsApp media uses. Returns null for anything else.
function telegramMedia(message) {
  const fields = MEDIA_FIELDS.filter(name => message[name] != null);
  if (fields.length !== 1) return null;
  const field = fields[0], id = message.message_id;
  if (field === 'voice' || field === 'audio') {
    const body = message[field], mime = String(body.mime_type ?? (field === 'voice' ? 'audio/ogg' : '')).toLowerCase();
    if (inboundKind(mime) !== 'voice' || !FILE_ID.test(body.file_id ?? '') || !Number.isInteger(body.file_size) ||
        body.file_size < 1 || body.file_size > MEDIA_LIMITS.voice ||
        !Number.isInteger(body.duration) || body.duration < 1 || body.duration > MEDIA_LIMITS.voiceSeconds) return null;
    return { kind: 'voice', mime, fileId: body.file_id, size: body.file_size, duration: body.duration,
      name: inboundName(body.file_name, `voice-TG_${id}${mime.startsWith('audio/ogg') ? '.ogg' : ''}`) };
  }
  if (field === 'photo') {
    if (!Array.isArray(message.photo) || !message.photo.length || message.photo.length > 20) return null;
    const usable = message.photo.filter(size => FILE_ID.test(size?.file_id ?? '') && Number.isInteger(size.file_size) &&
      size.file_size >= 1 && size.file_size <= MEDIA_LIMITS.image);
    if (!usable.length) return null;
    const best = usable.reduce((a, b) => (b.file_size > a.file_size ? b : a));
    return { kind: 'image', mime: 'image/jpeg', fileId: best.file_id, size: best.file_size, duration: 0, name: `image-TG_${id}.jpg` };
  }
  if (field === 'document') {
    const body = message.document, mime = String(body.mime_type ?? '').toLowerCase(), kind = inboundKind(mime);
    if (!['image', 'document'].includes(kind) || !FILE_ID.test(body.file_id ?? '') || !Number.isInteger(body.file_size) ||
        body.file_size < 1 || body.file_size > MEDIA_LIMITS[kind]) return null;
    return { kind, mime, fileId: body.file_id, size: body.file_size, duration: 0, name: inboundName(body.file_name, `document-TG_${id}`) };
  }
  if (field === 'video' || field === 'video_note') {
    const body = message[field], mime = String(body.mime_type ?? 'video/mp4').toLowerCase();
    if (inboundKind(mime) !== 'video' || !FILE_ID.test(body.file_id ?? '') || !Number.isInteger(body.file_size) ||
        body.file_size < 1 || body.file_size > MEDIA_LIMITS.video ||
        !Number.isInteger(body.duration) || body.duration < 1 || body.duration > MEDIA_LIMITS.videoSeconds) return null;
    return { kind: 'video', mime, fileId: body.file_id, size: body.file_size, duration: body.duration,
      width: positiveDimension(body.width), height: positiveDimension(body.height),
      name: inboundName(body.file_name, `${field === 'video_note' ? 'video-note' : 'video'}-TG_${id}${
        mime === 'video/webm' ? '.webm' : mime === 'video/quicktime' ? '.mov' : '.mp4'}`) };
  }
  return null;
}

// The paired person in the paired private chat, inside the acceptance date window.
function fromPairedPerson(update, config, now) {
  const message = update?.message;
  return Number.isSafeInteger(update?.update_id) && Number.isSafeInteger(message?.message_id) &&
    message.chat?.type === 'private' && String(message.chat.id) === config.chatId &&
    String(message.from?.id) === config.userId && !message.from?.is_bot &&
    Number.isInteger(message.date) && message.date >= config.enabledAt && message.date >= now - 86400 && message.date <= now + 300;
}
const telegramKey = (route, messageId) => sha256(`telegram\n${JSON.stringify(route)}\n${messageId}`);

export function authenticatedTelegram(update, config, now = epoch()) {
  const message = update?.message;
  if (!fromPairedPerson(update, config, now) ||
      message.forward_origin || message.forward_date || message.sender_chat || message.via_bot) return null;
  const identity = { key: telegramKey(config.route, message.message_id),
    remoteId: `TG_${message.message_id}`, quotedId: message.reply_to_message ? `TG_${message.reply_to_message.message_id}` : null };
  if (message.text != null) {
    if (!validText(message.text) || message.text.startsWith(PREFIX)) return null;
    return { ...identity, text: message.text };
  }
  const media = telegramMedia(message);
  if (!media) return null;
  const caption = message.caption == null ? '' : message.caption;
  if (caption && (!validText(caption) || caption.startsWith(PREFIX))) return null;
  return { ...identity, text: '', caption, media };
}

// Content the person composed that has no media field above; anything else
// without text or media is a service event (pins, settings) and stays silent.
const OTHER_CONTENT = ['story', 'paid_media', 'checklist', 'game', 'invoice', 'giveaway'];
// Why a paired-person media message was refused, as a closed reason, or null for a service event.
function mediaRejection(message) {
  const fields = MEDIA_FIELDS.filter(name => message[name] != null);
  if (!fields.length) return OTHER_CONTENT.some(name => message[name] != null) ? 'unsupported' : null;
  if (fields.length !== 1) return 'unsupported';
  const field = fields[0], body = message[field];
  if (!['voice', 'audio', 'photo', 'document', 'video', 'video_note'].includes(field) || body === null || typeof body !== 'object') return 'unsupported';
  if (field === 'photo') {
    const sizes = Array.isArray(body) ? body.map(size => size?.file_size).filter(Number.isInteger) : [];
    return sizes.length && Math.min(...sizes) > MEDIA_LIMITS.image ? 'too-large' : 'unsupported';
  }
  const fallback = field === 'voice' ? 'audio/ogg' : field === 'video' || field === 'video_note' ? 'video/mp4' : '';
  const mime = String(body.mime_type ?? fallback).toLowerCase(), kind = inboundKind(mime);
  if (field === 'document') {
    if (mime.startsWith('audio/')) return 'audio-as-file';
    if (mime.startsWith('video/')) return 'video-as-file';
    if (!['image', 'document'].includes(kind)) return 'file-format';
  }
  if ((field === 'voice' || field === 'audio') && kind !== 'voice') return 'audio-format';
  if ((field === 'video' || field === 'video_note') && kind !== 'video') return 'video-format';
  if (Number.isInteger(body.file_size) && body.file_size > MEDIA_LIMITS[kind]) return 'too-large';
  if (field !== 'document' && Number.isInteger(body.duration)) {
    if (body.duration < 1) return 'too-short';
    if (body.duration > (kind === 'video' ? MEDIA_LIMITS.videoSeconds : MEDIA_LIMITS.voiceSeconds)) return 'too-long';
  }
  return 'unsupported';
}

/**
 * For an update that authenticatedTelegram refused, the closed reason to
 * explain once to the paired person, or null to stay silent: anyone else, a
 * message outside the date window, and our own prefixed text are never answered.
 */
export function pairedRejection(update, config, now = epoch()) {
  if (!fromPairedPerson(update, config, now) || authenticatedTelegram(update, config, now)) return null;
  const message = update.message;
  if (message.forward_origin || message.forward_date || message.sender_chat) return 'forwarded';
  if (message.via_bot) return 'via-bot';
  if (message.text != null) return typeof message.text === 'string' && message.text.startsWith(PREFIX) ? null : 'text-invalid';
  // Acceptable media can only have been refused for its caption.
  return telegramMedia(message) ? 'caption-invalid' : mediaRejection(message);
}

const megabytes = bytes => `${Math.round(bytes / (1024 * 1024))} MB`;
const REJECTIONS = Object.freeze({
  forwarded: 'Forwarded messages are not accepted, because only messages you send in this chat are authenticated. Send it directly instead.',
  'via-bot': 'Messages sent through another bot are not accepted. Send it directly instead.',
  'text-invalid': 'That message is empty, too long, or contains control characters.',
  'caption-invalid': 'That attachment caption is too long or contains control characters.',
  'audio-format': 'That audio format is not supported. Record a voice note, or send Ogg/Opus, MP3 or MP4 (M4A) audio.',
  'audio-as-file': 'Audio sent as a file is not accepted. Record a voice note, or send it as an audio track instead.',
  'video-format': 'That video format is not supported. Send an MP4, MOV or WebM clip.',
  'video-as-file': 'Video sent as a file is not accepted. Send it as a video instead.',
  'file-format': 'That file type is not supported. Send a photo, or a PDF, plain text, CSV or JSON file.',
  'too-large': `That attachment is over the local limit (voice ${megabytes(MEDIA_LIMITS.voice)}, images ${megabytes(MEDIA_LIMITS.image)}, ` +
    `files ${megabytes(MEDIA_LIMITS.document)}, video ${megabytes(MEDIA_LIMITS.video)}).`,
  'too-short': 'That recording is shorter than one second.',
  'too-long': `That recording is longer than the ${Math.round(MEDIA_LIMITS.voiceSeconds / 60)}-minute local limit.`,
  unsupported: 'That kind of message is not supported here. Send text, a voice note, a photo, a supported file, or a video clip.'
});
const rejectionText = reason => `Not accepted: ${REJECTIONS[reason] ?? REJECTIONS.unsupported} Nothing was forwarded to Firstmate.`;

export class TelegramDelegate {
  constructor({ store, adapter, clientFactory = config => new TelegramClient(config), clock = epoch, attachmentReader,
    notificationAllowed = () => true, command = async () => null, transcribe, video, log = () => {} }) {
    Object.assign(this, { store, adapter, clientFactory, clock, attachmentReader, notificationAllowed, command, transcribe, video, log });
    this.lastPoll = 0;
    this.lastMediaFailure = null;
  }
  // Download, stage and describe one pending media job in place, so the rest of
  // the ordinary note path sees surrogate text exactly like a WhatsApp attachment.
  // Returns false while the job must wait. Every failed attempt records and logs
  // its stage; after the final one the person is told once what happened, the
  // job (with its still-valid Telegram file id) moves to telegram-media-failed/
  // for inspection, and retention ages it out.
  async resolveMedia(job, file, client) {
    let phase = 'download', attachment;
    try {
      const metadata = { kind: job.media.kind, mime: job.media.mime, size: job.media.size, duration: job.media.duration,
        width: job.media.width ?? 0, height: job.media.height ?? 0, name: job.media.name };
      const source = await client.download(job.media.fileId, MEDIA_LIMITS[metadata.kind]);
      phase = 'stage';
      attachment = await stageInboundMedia(this.store, source, metadata);
      phase = 'describe';
      job.text = await inboundMediaText(this.store, attachment, metadata,
        { transcribe: this.transcribe, transport: 'Telegram', caption: job.caption ?? '', video: this.video });
      job.attachment = { digest: attachment.digest, path: attachment.path };
      delete job.media;
      writeJson(file, job);
      return true;
    } catch (error) {
      const at = this.clock(), stage = failureStage(phase, error);
      job.mediaAttempts = (job.mediaAttempts ?? 0) + 1;
      job.mediaFailures = [...(Array.isArray(job.mediaFailures) ? job.mediaFailures : []),
        { at, attempt: job.mediaAttempts, stage }].slice(-MEDIA_FAILURES_KEPT);
      const { kind, mime, size, duration } = job.media;
      this.log(`Telegram attachment ${job.remoteId} (${kind} ${mime}, ${size} bytes) failed at ${stage} (attempt ${job.mediaAttempts}/${MEDIA_ATTEMPTS})`);
      if (job.mediaAttempts >= MEDIA_ATTEMPTS) {
        const failure = { at, stage, kind, mime, size, duration, attempts: job.mediaAttempts };
        const retained = this.store.file('telegram-media-failed'); privateDirectory(retained);
        writeJson(path.join(retained, path.basename(file)), { ...job, failedAt: at, failure: { ...failure, staged: attachment?.path ?? null } });
        this.store.enqueue(mediaFailedText(stage, Boolean(attachment)), { kind: 'reply', session: '', id: `media-failed:${job.key}`, route: job.route, now: at });
        this.store.markIncoming(job.key, at, { operation: 'media-failed', route: job.route, failure });
        this.lastMediaFailure = { ...failure, remoteId: job.remoteId };
        fs.unlinkSync(file);
      } else {
        job.next = at + Math.min(300, 10 * 2 ** job.mediaAttempts);
        writeJson(file, job);
      }
      return false;
    }
  }
  // Tell the paired person once why a message of theirs was not accepted. Best
  // effort: an unqueueable explanation is logged, never allowed to stall intake.
  refuse(message, reason, config) {
    const key = telegramKey(config.route, message.message_id);
    if (this.store.incoming(key)) return;
    try {
      this.store.enqueue(rejectionText(reason), { kind: 'reply', session: '', id: `unsupported:${key}`, route: config.route, now: this.clock() });
      this.store.markIncoming(key, this.clock(), { operation: 'unsupported', route: config.route, reason });
      this.log(`Telegram message TG_${message.message_id} from the paired person was not accepted (${reason}); explained once`);
    } catch { this.log(`Telegram message TG_${message.message_id} was not accepted (${reason}); the explanation could not be queued`); }
  }
  async tick(whatsapp, snapshot) {
    let config;
    try { config = telegramConfig(this.store); }
    catch { writeJson(this.store.file('telegram-health.json'), { at: this.clock(), problem: 'Telegram configuration unavailable' }); return; }
    if (!config) return;
    const dir = this.store.file('telegram-pending'); privateDirectory(dir);
    const client = this.clientFactory(config);
    try {
      if (this.clock() - this.lastPoll >= 15) {
        this.lastPoll = this.clock();
        const cursorFile = this.store.file('telegram-cursor.json');
        // The cursor is derivable state: damaged or incompatible bytes are
        // quarantined and polling restarts at the server's oldest pending
        // update, with durable acceptance receipts preventing duplicates.
        const stored = readStoredRecord(this.store.root, cursorFile,
          { validate: value => Number.isInteger(value.offset) && plainRecord(value.route), reason: 'Telegram cursor failed structural validation' });
        const cursor = stored.record ?? { offset: 0, route: config.route };
        if (!sameRoute(cursor.route, config.route)) {
          if (cursor.route.account !== config.route.account || cursor.route.recipient !== config.route.recipient) throw new Error('Telegram cursor belongs to another peer');
          cursor.route = config.route; // Same verified bot/user token rotation preserves consumed update offset.
        }
        const updates = await client.updates(cursor.offset);
        if (!Array.isArray(updates) || updates.length > 50) throw new Error('invalid Telegram updates');
        for (const update of updates) {
          if (!Number.isSafeInteger(update?.update_id) || update.update_id < cursor.offset) continue;
          const incoming = authenticatedTelegram(update, config, this.clock());
          if (incoming && !this.store.incoming(incoming.key)) {
            if (this.store.records('telegram-pending').length >= 100) break;
            const file = path.join(dir, `${incoming.key}.json`);
            if (!readJson(file)) writeJson(file, { ...incoming, route: config.route, attempts: 0, next: 0 });
          } else if (!incoming) {
            const reason = pairedRejection(update, config, this.clock());
            if (reason) this.refuse(update.message, reason, config);
          }
          cursor.offset = update.update_id + 1;
          writeJson(cursorFile, cursor); // Accepted payload already durable before acknowledging server history.
        }
      }
      let mediaResolved = false;
      for (const name of this.store.records('telegram-pending').slice(0, 20)) {
        const file = path.join(dir, name), { record: job } = readStoredRecord(this.store.root, file);
        if (!job || !sameRoute(job.route, config.route) || job.next > this.clock()) continue;
        if (job.media) {
          // Downloads and local transcription are bounded but slow: one per tick.
          if (mediaResolved) continue;
          mediaResolved = true;
          if (!await this.resolveMedia(job, file, client)) continue;
        }
        try {
        const request = parseRequest(job.text);
        let response = job.response ?? await this.command(job.text, job.route);
        if (response == null && request.operation === 'note') {
          // The authenticated receipt supplies provenance to the unchanged inbox adapter.
          this.store.markIncoming(job.key, this.clock(), { operation: 'note', route: job.route });
          const quoted = this.store.sentByRemoteId(job.quotedId);
          const matched = quoted && sameRoute(quoted.deliveryRoute ?? quoted.route, job.route);
          let context = matched ? `\nReply to Firstmate: ${quoted.text}\n` : '\n';
          if (!job.body && matched && quoted.event?.kind === 'decision') {
            const current = await this.adapter.decisions();
            if (!current.decisions.some(event => event.task === quoted.event.task && event.key === quoted.event.key)) {
              job.response = 'That decision is no longer recorded as open. No approval was forwarded.';
              writeJson(file, job); continue;
            }
            context += `Exact recorded decision context: task=${quoted.event.task} key=${quoted.event.key}. Use Firstmate's normal decision procedure.\n`;
          }
          if (!matched && this.adapter.requests) context += this.adapter.requests.recentContext(job.route, { exclude: job.key });
          this.adapter.requests?.receive(job.key, { route: job.route, text: request.text, provenance: 'telegram' });
          job.body ??= `Telegram phone note (remote; away mode unchanged).${context}\n${request.text}`;
          writeJson(file, job);
          await this.adapter.note(job.key, job.body);
          response = `Received request ${job.key.slice(0, 8)}. Waiting for Firstmate to pick it up.`;
        } else if (response == null) {
          response = request.operation === 'help' ? REMOTE_HELP :
            await (this.adapter.summary ? this.adapter.summary(request.command ?? request.operation) : this.adapter.status());
        }
        job.response = response; writeJson(file, job);
        this.store.enqueue(response, { kind: 'reply', session: '', id: job.key, route: job.route, now: this.clock() });
        this.store.markIncoming(job.key, this.clock(), { operation: request.operation, route: job.route });
        fs.unlinkSync(file);
        } catch {
          job.attempts = (job.attempts ?? 0) + 1; job.next = this.clock() + Math.min(300, 2 ** Math.min(job.attempts, 8));
          writeJson(file, job);
        }
      }
      const offlineFile = this.store.file('telegram-offline.json');
      const offline = readStoredRecord(this.store.root, offlineFile,
        { validate: value => Number.isInteger(value.since), reason: 'Telegram offline marker failed structural validation' }).record ?? { since: this.clock() };
      if (whatsapp.connected) offline.since = this.clock();
      writeJson(offlineFile, offline);
      // Fallback delivery follows durable enqueue order, never hash order.
      // Damaged or shape-incompatible entries are quarantined, never sent blind.
      const jobs = this.store.records('outbox')
        .map(name => ({ name,
          ...readStoredRecord(this.store.root, this.store.file(`outbox/${name}`),
            { validate: queuedJobShape, reason: 'queued job failed structural validation' }) }))
        .map(entry => ({ name: entry.name, job: entry.record }))
        .filter(entry => entry.job)
        .sort((a, b) => outboundOrder(a.job, b.job));
      const waitingFamilies = new Set();
      for (const { name, job } of jobs) {
        if (job.next > this.clock()) {
          if (job.part?.family) waitingFamilies.add(job.part.family);
          continue;
        }
        if (job.part?.family && waitingFamilies.has(job.part.family)) continue;
        const file = this.store.file(`outbox/${name}`);
        const direct = job.route?.transport === 'telegram';
        if (direct ? !sameRoute(job.route, config.route) :
          (whatsapp.connected || this.clock() - offline.since < config.fallbackAfterSeconds ||
           !sameRoute(job.fallbackRoute, config.route) || !sameRoute(config.whatsappRoute, this.store.currentRoute()) ||
           (job.route && !sameRoute(job.route, this.store.currentRoute())))) continue;
        if (job.kind === 'alert' && (!snapshot.afk || job.session !== snapshot.session || !this.notificationAllowed(job, snapshot, this.clock()))) continue;
        // A damaged receipt also proves a completed send (writes are atomic);
        // the queue entry retires instead of duplicating the message.
        const delivered = readStoredRecord(this.store.root, this.store.file(`sent/${name}`));
        if (delivered.record || delivered.quarantined) { fs.unlinkSync(file); continue; }
        let remoteId;
        try {
          // An unavailable staged attachment is an ordinary retryable send
          // failure: persist the backoff like any failed send instead of
          // aborting the whole tick and hot-looping without progress.
          const attachment = job.attachment ? await this.attachmentReader?.(job) : undefined;
          if (job.attachment && !attachment) throw new Error('attachment unavailable');
          remoteId = await client.send(`${PREFIX}${job.text}`, attachment);
        }
        catch {
          job.attempts = (job.attempts ?? 0) + 1; job.next = this.clock() + Math.min(300, 2 ** Math.min(job.attempts, 8));
          writeJson(file, job); break;
        }
        writeJson(this.store.file(`sent/${name}`), { ...job, remoteId, delivered: this.clock(),
          deliveryTransport: 'telegram', deliveryRoute: config.route });
        fs.unlinkSync(file);
        break;
      }
      writeJson(this.store.file('telegram-health.json'), { at: this.clock(), problem: '', configured: true,
        ...(this.lastMediaFailure ? { lastMediaFailure: this.lastMediaFailure } : {}) });
    } catch { writeJson(this.store.file('telegram-health.json'), { at: this.clock(), problem: 'Telegram unavailable; durable requests and responses retained' }); }
  }
}
