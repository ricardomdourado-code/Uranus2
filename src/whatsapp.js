import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import { config } from './config.js';
import { logger, baileysLogger } from './logger.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve as resolvePath } from 'path';
import EventEmitter from 'events';

// Ensure auth directory exists
mkdirSync(config.whatsapp.authDir, { recursive: true });

export const storeEvents = new EventEmitter();

// Where the synced history is persisted so it survives restarts.
const STORE_FILE = resolvePath('./data/store.json');
// Keep at most this many messages per chat on disk (analysis only uses ~10).
const MAX_PERSISTED_PER_CHAT = 50;

let saveTimer = null;

// Simple in-memory store replacement
const store = {
  chats: new Map(),
  messages: new Map(),
  contacts: new Map(), // jid -> { name, notify, verifiedName }

  /** Load persisted chats/messages from disk into memory (called on startup). */
  load() {
    try {
      if (!existsSync(STORE_FILE)) return;
      const raw = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
      for (const [id, chat] of Object.entries(raw.chats || {})) {
        this.chats.set(id, chat);
      }
      for (const [jid, msgs] of Object.entries(raw.messages || {})) {
        this.messages.set(jid, msgs);
      }
      for (const [id, contact] of Object.entries(raw.contacts || {})) {
        this.contacts.set(id, contact);
      }
      const totalMsgs = [...this.messages.values()].reduce((s, a) => s + a.length, 0);
      logger.info(`💾 Histórico carregado do disco: ${this.chats.size} conversas, ${totalMsgs} mensagens.`);
    } catch (err) {
      logger.warn({ err }, 'Não foi possível carregar o histórico salvo (começando vazio).');
    }
  },

  /** Persist current store to disk, debounced to avoid excessive writes. */
  scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      this.save();
    }, 5000);
  },

  save() {
    try {
      const chats = {};
      for (const [id, chat] of this.chats.entries()) chats[id] = chat;
      const messages = {};
      for (const [jid, msgs] of this.messages.entries()) {
        messages[jid] = msgs.slice(-MAX_PERSISTED_PER_CHAT);
      }
      const contacts = {};
      for (const [id, contact] of this.contacts.entries()) contacts[id] = contact;
      writeFileSync(STORE_FILE, JSON.stringify({ chats, messages, contacts }));
    } catch (err) {
      logger.warn({ err }, 'Falha ao salvar histórico no disco.');
    }
  },

  bind(ev) {
    ev.on('messaging-history.set', ({ chats: historicChats, messages: historicMessages, isLatest }) => {
      logger.info(`messaging-history.set: ${historicChats?.length || 0} chats, ${historicMessages?.length || 0} msgs, isLatest=${isLatest}`);
      for (const chat of (historicChats || [])) this.chats.set(chat.id, chat);
      for (const msg of (historicMessages || [])) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;
        if (!this.messages.has(jid)) this.messages.set(jid, []);
        const arr = this.messages.get(jid);
        if (!arr.find(m => m.key.id === msg.key.id)) arr.push(msg);
        // Auto-create chat entry from messages if not present
        if (!this.chats.has(jid)) {
          this.chats.set(jid, { id: jid, unreadCount: 0, name: null });
        }
        // Remember a human-readable name from the message's pushName
        if (!jid.endsWith('@g.us') && !msg.key?.fromMe && msg.pushName) {
          const chat = this.chats.get(jid);
          if (!chat.name) chat.name = msg.pushName;
        }
        // Count unread (messages not from me)
        if (!msg.key?.fromMe) {
          const chat = this.chats.get(jid);
          chat.unreadCount = (chat.unreadCount || 0) + 1;
        }
      }
      const totalChats = this.chats.size;
      const totalMsgs = [...this.messages.values()].reduce((s, a) => s + a.length, 0);
      logger.info(`📊 Store acumulado: ${totalChats} conversas, ${totalMsgs} mensagens no total`);
      this.scheduleSave();
      if (totalChats > 0 || totalMsgs > 0) {
        storeEvents.emit('history-ready', { chats: totalChats, messages: totalMsgs, isLatest });
      }
    });
    ev.on('chats.set', ({ chats }) => {
      for (const chat of (chats || [])) this.chats.set(chat.id, chat);
      if (this.chats.size > 0) storeEvents.emit('history-ready', { chats: this.chats.size });
    });
    ev.on('chats.upsert', (chats) => {
      for (const chat of (chats || [])) this.chats.set(chat.id, chat);
    });
    ev.on('chats.update', (updates) => {
      for (const update of (updates || [])) {
        const existing = this.chats.get(update.id) || {};
        this.chats.set(update.id, { ...existing, ...update });
      }
    });
    ev.on('messages.set', ({ messages }) => {
      for (const msg of (messages || [])) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;
        if (!this.messages.has(jid)) this.messages.set(jid, []);
        this.messages.get(jid).push(msg);
      }
    });
    ev.on('messages.upsert', ({ messages }) => {
      for (const msg of (messages || [])) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;
        if (!this.messages.has(jid)) this.messages.set(jid, []);
        const arr = this.messages.get(jid);
        if (!arr.find(m => m.key.id === msg.key.id)) arr.push(msg);
        if (arr.length > 500) arr.shift();
        // Track new incoming messages as unread on the chat entry
        if (!this.chats.has(jid)) this.chats.set(jid, { id: jid, unreadCount: 0, name: null });
        const chat = this.chats.get(jid);
        if (!jid.endsWith('@g.us') && !msg.key?.fromMe && msg.pushName && !chat.name) {
          chat.name = msg.pushName;
        }
        if (!msg.key?.fromMe) {
          chat.unreadCount = (chat.unreadCount || 0) + 1;
        }
      }
      this.scheduleSave();
    });
    ev.on('contacts.set', ({ contacts }) => {
      for (const c of (contacts || [])) {
        this.contacts.set(c.id, { name: c.name, notify: c.notify, verifiedName: c.verifiedName });
      }
    });
    ev.on('contacts.upsert', (contacts) => {
      for (const c of (contacts || [])) {
        this.contacts.set(c.id, { name: c.name, notify: c.notify, verifiedName: c.verifiedName });
      }
    });
    ev.on('contacts.update', (updates) => {
      for (const u of (updates || [])) {
        const existing = this.contacts.get(u.id) || {};
        this.contacts.set(u.id, { ...existing, ...u });
      }
    });
  },

  /** Best human-readable name for a JID: contact > stored chat name > number. */
  resolveName(jid) {
    const c = this.contacts.get(jid);
    if (c) return c.name || c.verifiedName || c.notify || null;
    return null;
  },
};

let sockInstance = null;

/**
 * Connect to WhatsApp Web via Baileys.
 * Returns the socket instance after the connection reaches "open" state.
 */
export async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.authDir);
  const { version } = await fetchLatestBaileysVersion();

  logger.info(`Conectando ao WhatsApp (Baileys v${version.join('.')})`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: baileysLogger,
    syncFullHistory: true,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  store.bind(sock.ev);

  sock.ev.on('creds.update', saveCreds);

  return new Promise((resolve, reject) => {
    // No hard timeout — first sync can take many minutes for large accounts
    let resolved = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('QR Code gerado. Escaneie com seu WhatsApp:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        sockInstance = sock;
        storeEvents.emit('socket-open');
        if (!resolved) {
          resolved = true;
          logger.info('WhatsApp conectado com sucesso! Aguardando sincronização do histórico...');
          resolve(sock);
        } else {
          logger.info('WhatsApp reconectado.');
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : undefined;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(`Conexão fechada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);

        if (shouldReconnect) {
          logger.info('Tentando reconectar em 5 segundos...');
          setTimeout(async () => {
            try {
              const newSock = await connectToWhatsApp();
              sockInstance = newSock;
            } catch (err) {
              logger.error({ err }, 'Falha ao reconectar');
            }
          }, 5000);
        } else {
          reject(new Error('WhatsApp desconectado (logout). Delete ./data/auth e reinicie.'));
        }
      }
    });
  });
}

/**
 * Returns the active socket instance (after connection).
 */
export function getSocket() {
  return sockInstance;
}

/**
 * Returns current store sizes for health checks.
 */
export function getStoreSize() {
  return { chats: store.chats.size, messages: store.messages.size };
}

/**
 * Load persisted history from disk into the in-memory store.
 * Call once at startup, before connecting.
 */
export function loadStore() {
  store.load();
}

/**
 * Force an immediate save of the store to disk (e.g. on shutdown).
 */
export function flushStore() {
  store.save();
}

/**
 * Decode a JID to get a readable name or number.
 */
function jidToReadable(jid) {
  const decoded = jidDecode(jid);
  if (!decoded) return jid;
  return decoded.user || jid;
}

/**
 * Determine chat type label.
 */
function getChatTypeLabel(jid) {
  if (jid.endsWith('@g.us')) return 'Grupo';
  if (jid.endsWith('@broadcast')) return 'Lista de Transmissão';
  return 'Contato';
}

/**
 * Retrieve all chats with unread count, last message, timestamp, and metadata.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @returns {Promise<Array>}
 */
export async function getAllChats(sock) {
  logger.info('Buscando todas as conversas...');

  // Wait a bit for store to sync chats
  await new Promise((r) => setTimeout(r, 2000));

  const chats = [];

  for (const [jid, chat] of store.chats.entries()) {
    if (!jid || jid === 'status@broadcast') continue;

    const isGroup = jid.endsWith('@g.us');
    // Prefer: saved chat/group subject > contact name > pushName captured on chat
    // > last resort the readable number/LID.
    let name = chat.name || chat.subject || store.resolveName(jid) || jidToReadable(jid);
    let participants = [];

    if (isGroup) {
      try {
        const meta = await sock.groupMetadata(jid).catch(() => null);
        if (meta) {
          name = meta.subject || name;
          participants = (meta.participants || []).map((p) => ({
            jid: p.id,
            number: jidToReadable(p.id),
            isAdmin: p.admin != null,
          }));
        }
      } catch {
        // ignore group metadata errors
      }
    }

    const lastMsg = chat.messages?.last?.message || null;
    const lastMsgText = extractMessageText(lastMsg);
    const unreadCount = chat.unreadCount || 0;
    const timestamp = chat.conversationTimestamp
      ? new Date(Number(chat.conversationTimestamp) * 1000)
      : null;

    chats.push({
      jid,
      name,
      type: getChatTypeLabel(jid),
      unreadCount,
      lastMessage: lastMsgText,
      lastMessageTime: timestamp,
      participants,
      isGroup,
      isMuted: chat.mute != null && chat.mute > 0,
      isPinned: chat.pinned != null && chat.pinned > 0,
    });
  }

  // Sort: pinned first, then by timestamp descending
  chats.sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    const ta = a.lastMessageTime?.getTime() || 0;
    const tb = b.lastMessageTime?.getTime() || 0;
    return tb - ta;
  });

  logger.info(`Total de conversas encontradas: ${chats.length}`);
  return chats;
}

/**
 * Fetch last N messages from a specific chat.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function getChatMessages(sock, jid, limit = 50) {
  try {
    const stored = store.messages.get(jid) || [];
    return formatMessages(stored.slice(-limit), jid);
  } catch (err) {
    logger.warn({ err, jid }, 'Erro ao carregar mensagens da conversa');
    const stored = store.messages.get(jid) || [];
    return formatMessages(stored.slice(-limit), jid);
  }
}

function formatMessages(messages, jid) {
  return messages.map((msg) => ({
    id: msg.key?.id,
    fromMe: msg.key?.fromMe || false,
    sender: msg.key?.participant || msg.key?.remoteJid || jid,
    senderName: msg.pushName || jidToReadable(msg.key?.participant || msg.key?.remoteJid || jid),
    text: extractMessageText(msg.message),
    timestamp: msg.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000)
      : null,
    type: getMessageType(msg.message),
  })).filter((m) => m.text || m.type !== 'unknown');
}

/**
 * Extract plain text from a WhatsApp message object.
 */
function extractMessageText(message) {
  if (!message) return '';

  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return `[Imagem] ${message.imageMessage.caption}`;
  if (message.videoMessage?.caption) return `[Vídeo] ${message.videoMessage.caption}`;
  if (message.documentMessage?.title) return `[Documento] ${message.documentMessage.title}`;
  if (message.audioMessage) return '[Áudio]';
  if (message.stickerMessage) return '[Figurinha]';
  if (message.locationMessage) return '[Localização]';
  if (message.contactMessage) return `[Contato] ${message.contactMessage.displayName || ''}`;
  if (message.pollCreationMessage) return `[Enquete] ${message.pollCreationMessage.name || ''}`;
  if (message.reactionMessage) return `[Reação] ${message.reactionMessage.text || ''}`;
  if (message.buttonsMessage?.contentText) return message.buttonsMessage.contentText;
  if (message.listMessage?.description) return message.listMessage.description;

  return '';
}

/**
 * Determine message type string.
 */
function getMessageType(message) {
  if (!message) return 'unknown';
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  if (message.documentMessage) return 'document';
  if (message.stickerMessage) return 'sticker';
  if (message.locationMessage) return 'location';
  if (message.contactMessage) return 'contact';
  if (message.pollCreationMessage) return 'poll';
  if (message.reactionMessage) return 'reaction';
  return 'unknown';
}
