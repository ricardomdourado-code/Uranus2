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
import { mkdirSync } from 'fs';
import EventEmitter from 'events';

// Ensure auth directory exists
mkdirSync(config.whatsapp.authDir, { recursive: true });

export const storeEvents = new EventEmitter();

// Simple in-memory store replacement
const store = {
  chats: new Map(),
  messages: new Map(),
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
        // Count unread (messages not from me)
        if (!msg.key?.fromMe) {
          const chat = this.chats.get(jid);
          chat.unreadCount = (chat.unreadCount || 0) + 1;
        }
      }
      const totalChats = this.chats.size;
      const totalMsgs = [...this.messages.values()].reduce((s, a) => s + a.length, 0);
      logger.info(`📊 Store acumulado: ${totalChats} conversas, ${totalMsgs} mensagens no total`);
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
      }
    });
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
    let name = chat.name || chat.subject || jidToReadable(jid);
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
