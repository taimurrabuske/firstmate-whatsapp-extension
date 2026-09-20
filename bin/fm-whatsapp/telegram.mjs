// Optional, explicitly paired fallback. Tokens never enter queues or diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, privateDirectory, sha256, epoch, validText, parseRequest, PREFIX, sameRoute } from './core.mjs';

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
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }
  async call(method, data) {
    const multipart = data instanceof FormData;
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.config.token}/${method}`, {
        method: 'POST', headers: multipart ? undefined : { 'content-type': 'application/json' },
        body: multipart ? data : JSON.stringify(data), signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw new Error('unavailable');
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('oversized');
      const result = JSON.parse(text);
      if (result.ok !== true) throw new Error('refused');
      return result.result;
    } catch { throw new Error('Telegram request failed; details omitted'); }
  }
  updates(offset) { return this.call('getUpdates', { offset, timeout: 0, limit: 50, allowed_updates: ['message'] }); }
  async send(text, attachment) {
    let result;
    if (attachment) {
      if (!Buffer.isBuffer(attachment.data) || attachment.data.length > 15 * 1024 * 1024 ||
          !attachment.data.length || !['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain', 'text/csv', 'application/json'].includes(attachment.mime) ||
          typeof attachment.name !== 'string' || path.basename(attachment.name) !== attachment.name || /[\x00-\x1f]/.test(attachment.name)) throw new Error('invalid Telegram attachment');
      const body = new FormData();
      body.set('chat_id', this.config.chatId);
      body.set('caption', text.slice(0, 1024));
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

export function authenticatedTelegram(update, config, now = epoch()) {
  const message = update?.message;
  if (!Number.isSafeInteger(update?.update_id) || !Number.isSafeInteger(message?.message_id) ||
      message.chat?.type !== 'private' || String(message.chat.id) !== config.chatId ||
      String(message.from?.id) !== config.userId || message.from?.is_bot ||
      message.forward_origin || message.forward_date || message.sender_chat || message.via_bot ||
      !Number.isInteger(message.date) || message.date < config.enabledAt || message.date < now - 86400 || message.date > now + 300 ||
      !validText(message.text) || message.text.startsWith(PREFIX)) return null;
  return { key: sha256(`telegram\n${JSON.stringify(config.route)}\n${message.message_id}`), text: message.text,
    remoteId: `TG_${message.message_id}`, quotedId: message.reply_to_message ? `TG_${message.reply_to_message.message_id}` : null };
}

export class TelegramDelegate {
  constructor({ store, adapter, clientFactory = config => new TelegramClient(config), clock = epoch, attachmentReader,
    notificationAllowed = () => true, command = async () => null }) {
    Object.assign(this, { store, adapter, clientFactory, clock, attachmentReader, notificationAllowed, command });
    this.lastPoll = 0;
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
        let cursor = readJson(cursorFile, { offset: 0, route: config.route });
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
          }
          cursor.offset = update.update_id + 1;
          writeJson(cursorFile, cursor); // Accepted payload already durable before acknowledging server history.
        }
      }
      for (const name of this.store.records('telegram-pending').slice(0, 20)) {
        const file = path.join(dir, name), job = readJson(file);
        if (!sameRoute(job.route, config.route) || job.next > this.clock()) continue;
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
          response = request.operation === 'help' ? 'Send your request directly. Shortcuts: status, pending, blocked, decisions, last result, more.' :
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
      const offline = readJson(offlineFile, { since: this.clock() });
      if (whatsapp.connected) offline.since = this.clock();
      writeJson(offlineFile, offline);
      for (const name of this.store.records('outbox')) {
        const file = this.store.file(`outbox/${name}`), job = readJson(file);
        if (job.next > this.clock()) continue;
        const direct = job.route?.transport === 'telegram';
        if (direct ? !sameRoute(job.route, config.route) :
          (whatsapp.connected || this.clock() - offline.since < config.fallbackAfterSeconds ||
           !sameRoute(job.fallbackRoute, config.route) || !sameRoute(config.whatsappRoute, this.store.currentRoute()) ||
           (job.route && !sameRoute(job.route, this.store.currentRoute())))) continue;
        if (job.kind === 'alert' && (!snapshot.afk || job.session !== snapshot.session || !this.notificationAllowed(job, snapshot, this.clock()))) continue;
        if (readJson(this.store.file(`sent/${name}`))) { fs.unlinkSync(file); continue; }
        const attachment = job.attachment ? await this.attachmentReader?.(job) : undefined;
        if (job.attachment && !attachment) throw new Error('attachment unavailable');
        let remoteId;
        try { remoteId = await client.send(`${PREFIX}${job.text}`, attachment); }
        catch {
          job.attempts = (job.attempts ?? 0) + 1; job.next = this.clock() + Math.min(300, 2 ** Math.min(job.attempts, 8));
          writeJson(file, job); break;
        }
        writeJson(this.store.file(`sent/${name}`), { ...job, remoteId, delivered: this.clock(),
          deliveryTransport: 'telegram', deliveryRoute: config.route });
        fs.unlinkSync(file);
        break;
      }
      writeJson(this.store.file('telegram-health.json'), { at: this.clock(), problem: '', configured: true });
    } catch { writeJson(this.store.file('telegram-health.json'), { at: this.clock(), problem: 'Telegram unavailable; durable requests and responses retained' }); }
  }
}
