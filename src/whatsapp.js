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
  // lid -> { name, phone, linkedJid } — persisted separately, enriched over time
  lidNames: new Map(),

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
      for (const [lid, info] of Object.entries(raw.lidNames || {})) {
        this.lidNames.set(lid, info);
      }
      const totalMsgs = [...this.messages.values()].reduce((s, a) => s + a.length, 0);
      logger.info(`💾 Histórico carregado do disco: ${this.chats.size} conversas, ${totalMsgs} mensagens, ${this.lidNames.size} LIDs resolvidos.`);
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
      const lidNames = {};
      for (const [lid, info] of this.lidNames.entries()) lidNames[lid] = info;
      writeFileSync(STORE_FILE, JSON.stringify({ chats, messages, contacts, lidNames }));
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
          // Persist pushName for @lid JIDs found in history
          const senderJid = msg.key?.participant || jid;
          if (senderJid && senderJid.endsWith('@lid') && msg.pushName) {
            this.recordLidPushName(senderJid, msg.pushName);
          }
          if (jid.endsWith('@lid') && msg.pushName) {
            this.recordLidPushName(jid, msg.pushName);
          }
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

        // Handle message deletions (revoke): WhatsApp sends a protocolMessage of
        // type REVOKE (0) referencing the deleted message's key. Remove it from
        // the store so the panel matches the original conversation.
        const proto = msg.message?.protocolMessage;
        if (proto && (proto.type === 0 || proto.type === 'REVOKE') && proto.key?.id) {
          const targetJid = proto.key.remoteJid || jid;
          const targetArr = this.messages.get(targetJid);
          if (targetArr) {
            const idx = targetArr.findIndex(m => m.key?.id === proto.key.id);
            if (idx !== -1) targetArr.splice(idx, 1);
          }
          this.scheduleSave();
          storeEvents.emit('message-activity', {
            jid: targetJid, revoked: true, msgId: proto.key.id,
            isGroup: targetJid.endsWith('@g.us'), timestamp: Date.now(),
          });
          continue; // don't store the protocol message itself
        }

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
          // For @lid senders, persist their pushName so they resolve by name.
          const senderJid = msg.key?.participant || jid;
          if (senderJid && senderJid.endsWith('@lid') && msg.pushName) {
            store.recordLidPushName(senderJid, msg.pushName);
          }
          // Same for individual @lid chats
          if (jid.endsWith('@lid') && msg.pushName) {
            store.recordLidPushName(jid, msg.pushName);
          }
        }

        // Real-time: notify listeners so the dashboard updates instantly,
        // before the next GPT cycle runs.
        storeEvents.emit('message-activity', {
          jid,
          name: chat.name || store.resolveName(jid) || null,
          fromMe: !!msg.key?.fromMe,
          text: resolveMentionsInText(extractMessageText(msg.message)),
          unreadCount: chat.unreadCount || 0,
          timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
          isGroup: jid.endsWith('@g.us'),
        });
      }
      this.scheduleSave();
    });
    ev.on('messages.update', (updates) => {
      let changed = false;
      for (const u of (updates || [])) {
        const jid = u.key?.remoteJid;
        const id = u.key?.id;
        if (!jid || !id) continue;
        // Only act on an EXPLICIT revoke protocolMessage. We must NOT treat a
        // null/missing message (common in status/delivery/read updates) as a
        // deletion — doing so wrongly wipes legitimate messages.
        const proto = u.update?.message?.protocolMessage;
        const isRevoke = proto && (proto.type === 0 || proto.type === 'REVOKE') && proto.key?.id;
        if (isRevoke) {
          const targetId = proto.key.id;
          const arr = this.messages.get(jid);
          if (arr) {
            const idx = arr.findIndex(m => m.key?.id === targetId);
            if (idx !== -1) { arr.splice(idx, 1); changed = true; }
          }
          storeEvents.emit('message-activity', {
            jid, revoked: true, msgId: targetId,
            isGroup: jid.endsWith('@g.us'), timestamp: Date.now(),
          });
        }
      }
      if (changed) this.scheduleSave();
    });
    ev.on('contacts.set', ({ contacts }) => {
      for (const c of (contacts || [])) {
        this.contacts.set(c.id, { name: c.name, notify: c.notify, verifiedName: c.verifiedName, lid: c.lid });
        // If a contact entry has a .lid field, register it in lidNames too.
        if (c.lid) {
          const existing = this.lidNames.get(c.lid) || {};
          this.lidNames.set(c.lid, { ...existing, name: c.name || c.notify || existing.name, linkedJid: c.id });
        }
        // If this IS a @lid entry and has a name, store it
        if (c.id && c.id.endsWith('@lid') && (c.name || c.notify)) {
          const existing = this.lidNames.get(c.id) || {};
          this.lidNames.set(c.id, { ...existing, name: c.name || c.notify || c.verifiedName || existing.name });
        }
      }
    });
    ev.on('contacts.upsert', (contacts) => {
      for (const c of (contacts || [])) {
        this.contacts.set(c.id, { name: c.name, notify: c.notify, verifiedName: c.verifiedName, lid: c.lid });
        if (c.lid) {
          const existing = this.lidNames.get(c.lid) || {};
          this.lidNames.set(c.lid, { ...existing, name: c.name || c.notify || existing.name, linkedJid: c.id });
        }
        if (c.id && c.id.endsWith('@lid') && (c.name || c.notify)) {
          const existing = this.lidNames.get(c.id) || {};
          this.lidNames.set(c.id, { ...existing, name: c.name || c.notify || c.verifiedName || existing.name });
        }
      }
    });
    ev.on('contacts.update', (updates) => {
      for (const u of (updates || [])) {
        const existing = this.contacts.get(u.id) || {};
        this.contacts.set(u.id, { ...existing, ...u });
        if (u.lid) {
          const ex2 = this.lidNames.get(u.lid) || {};
          this.lidNames.set(u.lid, { ...ex2, name: u.name || u.notify || ex2.name, linkedJid: u.id });
        }
      }
    });
  },

  /** Best human-readable name for a JID: contact > stored chat name > number. */
  resolveName(jid) {
    // Direct contact lookup
    const c = this.contacts.get(jid);
    if (c) return c.name || c.verifiedName || c.notify || null;
    // @lid fallback
    if (jid && jid.endsWith('@lid')) {
      const lid = this.lidNames.get(jid);
      return lid?.name || null;
    }
    return null;
  },

  /** Record a pushName seen in a message for a @lid JID. */
  recordLidPushName(lid, pushName) {
    if (!lid || !lid.endsWith('@lid') || !pushName) return;
    const existing = this.lidNames.get(lid);
    // Only update if we don't already have a better (contact-sourced) name
    if (!existing || !existing.name) {
      this.lidNames.set(lid, { ...existing, name: pushName });
      _nameIndex = null; // invalidate cache
    }
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
    syncFullHistory: config.whatsapp.syncFullHistory,
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
          // After 60s (enough for initial sync), try to resolve unknown @lid names
          setTimeout(() => resolveUnknownLids(sock).catch(() => {}), 60000);
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

// --- Name index: maps a sender JID (and its bare number) to a display name ---
// Built from the pushName attached to every stored message, merged with the
// synced contacts. Cached briefly so we don't rescan on every call.
let _nameIndex = null;
let _nameIndexAt = 0;

function buildNameIndex() {
  const idx = new Map();
  const put = (jid, name) => {
    if (!jid || !name) return;
    if (!idx.has(jid)) idx.set(jid, name);
    // Also index by bare number so "@123..." text mentions resolve.
    const num = jidToReadable(jid);
    if (num && !idx.has(num)) idx.set(num, name);
  };
  // Layer 1: explicit LID name map (most resolved source)
  for (const [lid, info] of store.lidNames.entries()) {
    if (info?.name) put(lid, info.name);
    // If we know the linked @s.whatsapp.net JID, index by that too
    if (info?.linkedJid && info?.name) put(info.linkedJid, info.name);
  }
  // Layer 2: synced contacts (agenda names)
  for (const [id, c] of store.contacts.entries()) {
    const name = c?.name || c?.verifiedName || c?.notify;
    if (name) put(id, name);
    // cross-link via .lid field
    if (c?.lid && name) put(c.lid, name);
  }
  // Layer 3: pushNames seen in messages
  for (const msgs of store.messages.values()) {
    for (const msg of msgs) {
      if (msg.key?.fromMe) continue;
      const sender = msg.key?.participant || msg.key?.remoteJid;
      if (sender && msg.pushName) put(sender, msg.pushName);
    }
  }
  return idx;
}

/**
 * Attempt to resolve any @lid JIDs that still lack a name using Baileys'
 * internal USyncQuery. This is best-effort — runs after connection is stable.
 * Called once from connectToWhatsApp after the socket opens.
 */
async function resolveUnknownLids(sock) {
  const unresolved = [];
  for (const [lid] of store.lidNames.entries()) {
    const info = store.lidNames.get(lid);
    if (!info?.name) unresolved.push(lid);
  }
  // Also find @lid JIDs that have no lidNames entry at all
  for (const [jid] of store.chats.entries()) {
    if (jid.endsWith('@lid') && !store.lidNames.has(jid)) unresolved.push(jid);
  }
  for (const msgs of store.messages.values()) {
    for (const msg of msgs) {
      const s = msg.key?.participant || msg.key?.remoteJid;
      if (s && s.endsWith('@lid') && !store.lidNames.has(s)) unresolved.push(s);
    }
  }
  const unique = [...new Set(unresolved)].slice(0, 50); // cap to avoid flooding
  if (unique.length === 0) return;
  logger.info(`🔍 Tentando resolver ${unique.length} LID(s) desconhecidos...`);
  let resolved = 0;
  for (const lid of unique) {
    try {
      // Baileys exposes sock.query for raw IQ — try business contact query
      const result = await sock.onWhatsApp(lid).catch(() => null);
      if (result && result[0]) {
        const r = result[0];
        const name = r.verifiedName || r.name || null;
        const phone = r.jid ? jidToReadable(r.jid) : null;
        const existing = store.lidNames.get(lid) || {};
        store.lidNames.set(lid, { ...existing, name: name || existing.name, phone: phone || existing.phone, linkedJid: r.jid || existing.linkedJid });
        if (name || phone) { resolved++; _nameIndex = null; }
      }
    } catch {
      // silently skip unresolvable LIDs
    }
    // small delay to avoid rate-limiting
    await new Promise(r => setTimeout(r, 200));
  }
  if (resolved > 0) {
    logger.info(`✅ ${resolved} LID(s) resolvidos via USyncQuery`);
    store.scheduleSave();
  }
}

function nameIndex() {
  const now = Date.now();
  if (!_nameIndex || now - _nameIndexAt > 60000) {
    _nameIndex = buildNameIndex();
    _nameIndexAt = now;
  }
  return _nameIndex;
}

/** Best human-readable name for any participant/sender JID. */
export function resolveJidName(jid) {
  if (!jid) return null;
  const idx = nameIndex();
  return idx.get(jid) || idx.get(jidToReadable(jid)) || store.resolveName(jid) || null;
}

// Replace "@<number>" mentions inside message text with "@<name>" when known.
function resolveMentionsInText(text) {
  if (!text || text.indexOf('@') === -1) return text;
  const idx = nameIndex();
  return text.replace(/@(\d{5,})/g, (full, num) => {
    const name = idx.get(num) || idx.get(num + '@s.whatsapp.net') || idx.get(num + '@lid');
    return name ? '@' + name : full;
  });
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
export async function getAllChats(sock, options = {}) {
  const { activeDays = 7, max = 80 } = options;
  logger.info('Buscando todas as conversas...');

  // Wait a bit for store to sync chats
  await new Promise((r) => setTimeout(r, 2000));

  const cutoff = activeDays > 0 ? Date.now() - activeDays * 24 * 60 * 60 * 1000 : 0;

  // First pass: lightweight list with real last-message time (no group metadata yet).
  const candidates = [];
  for (const [jid, chat] of store.chats.entries()) {
    if (!jid || jid === 'status@broadcast') continue;

    const msgs = store.messages.get(jid) || [];
    // Messages arrive out of order — pick the chronologically newest one.
    let lastMsg = null;
    for (const m of msgs) {
      if (!lastMsg || (Number(m.messageTimestamp) || 0) >= (Number(lastMsg.messageTimestamp) || 0)) {
        lastMsg = m;
      }
    }
    const lastTs = lastMsg?.messageTimestamp
      ? Number(lastMsg.messageTimestamp) * 1000
      : (chat.conversationTimestamp ? Number(chat.conversationTimestamp) * 1000 : 0);
    const unreadCount = chat.unreadCount || 0;

    // Keep only chats active within the window OR with unread messages.
    if (cutoff > 0 && lastTs < cutoff && unreadCount === 0) continue;

    candidates.push({ jid, chat, lastTs, unreadCount, lastMsg });
  }

  // Sort by recency and cap, so we only enrich/analyze the most relevant ones.
  candidates.sort((a, b) => b.lastTs - a.lastTs);
  const totalActive = candidates.length;
  const selected = max > 0 ? candidates.slice(0, max) : candidates;
  logger.info(`${store.chats.size} conversas no total | ${totalActive} ativas (últimos ${activeDays}d / não lidas) | analisando ${selected.length}`);

  const chats = [];
  for (const { jid, chat, lastTs, unreadCount, lastMsg } of selected) {
    const isGroup = jid.endsWith('@g.us');
    // For individual chats, fall back to the most recent pushName found in the
    // stored messages — this resolves raw numbers / @lid identifiers to the
    // sender's WhatsApp display name.
    let pushNameFromMsgs = null;
    if (!isGroup) {
      const msgs = store.messages.get(jid) || [];
      // Scan newest-first; prefer non-fromMe but fall back to any message with pushName
      let anyPushName = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].pushName) {
          if (!msgs[i].key?.fromMe) {
            pushNameFromMsgs = msgs[i].pushName;
            break;
          } else if (!anyPushName) {
            anyPushName = msgs[i].pushName;
          }
        }
      }
      if (!pushNameFromMsgs) pushNameFromMsgs = anyPushName;
    }
    const rawFallback = jidToReadable(jid);
    const isLid = jid.endsWith('@lid');
    const friendlyFallback = isLid ? `Contato (${rawFallback.slice(-6)})` : rawFallback;
    let name = chat.name || chat.subject || store.resolveName(jid) || pushNameFromMsgs || friendlyFallback;
    let participants = [];

    if (isGroup) {
      try {
        const meta = await sock.groupMetadata(jid).catch(() => null);
        if (meta) {
          name = meta.subject || name;
          participants = (meta.participants || []).map((p) => ({
            jid: p.id,
            number: jidToReadable(p.id),
            name: resolveJidName(p.id) || null,
            isAdmin: p.admin != null,
          }));
        }
      } catch {
        // ignore group metadata errors
      }
    }

    const lastMsgText = resolveMentionsInText(extractMessageText(lastMsg?.message));
    const timestamp = lastTs ? new Date(lastTs) : null;

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
    return formatMessages(recentSorted(jid, limit), jid);
  } catch (err) {
    logger.warn({ err, jid }, 'Erro ao carregar mensagens da conversa');
    return formatMessages(recentSorted(jid, limit), jid);
  }
}

/**
 * Read recent messages for a chat directly from the store (no socket needed).
 * Used by the dashboard detail view.
 */
export function getRecentMessages(jid, limit = 20) {
  return formatMessages(recentSorted(jid, limit), jid);
}

/**
 * Return the most recent `limit` stored messages for a chat, sorted
 * chronologically (oldest -> newest). Messages arrive out of order (history
 * sync + realtime), so we must sort by timestamp before slicing — otherwise
 * the panel shows them in arrival order, not conversation order.
 */
function recentSorted(jid, limit) {
  const stored = (store.messages.get(jid) || []).slice();
  stored.sort((a, b) => {
    const ta = Number(a.messageTimestamp) || 0;
    const tb = Number(b.messageTimestamp) || 0;
    return ta - tb;
  });
  return limit > 0 ? stored.slice(-limit) : stored;
}

/**
 * Epoch (ms) of the most recent INCOMING (not fromMe) message in a chat.
 * Returns 0 if none. Used to detect new movement after a reply.
 */
export function getLastIncomingTime(jid) {
  const msgs = store.messages.get(jid) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!msgs[i].key?.fromMe && msgs[i].messageTimestamp) {
      return Number(msgs[i].messageTimestamp) * 1000;
    }
  }
  return 0;
}

/**
 * Check whether any of the most recent messages in a chat mention the owner
 * by name (e.g. "@ricardo", "Ricardo"). Used to pull conversations back out of
 * the "Diversos" column when the user is directly addressed.
 * @param {string} jid
 * @param {string[]} names - candidate names/aliases to look for
 * @param {number} limit - how many recent messages to scan
 */
export function chatMentionsOwner(jid, names = [], limit = 30) {
  const stored = store.messages.get(jid) || [];
  const recent = stored.slice(-limit);
  // Build word-boundary regexes for each name token (first name, full name…).
  const needles = names
    .flatMap((n) => [n, ...n.split(/\s+/)])
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length >= 3);
  if (needles.length === 0) return false;

  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    if (msg.key?.fromMe) continue; // a message I sent doesn't "mention" me
    const text = (extractMessageText(msg.message) || '').toLowerCase();
    if (!text) continue;
    for (const needle of needles) {
      // Match "@ricardo" or the name as a standalone word.
      if (text.includes('@' + needle) || new RegExp(`\\b${escapeRegex(needle)}\\b`).test(text)) {
        return true;
      }
    }
  }
  return false;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Best-effort phone number (digits only) for a chat, for building wa.me links.
 * Returns null for groups and @lid identifiers (no usable phone number).
 */
export function getChatPhone(jid) {
  if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.includes('@lid')) {
    return null;
  }
  const decoded = jidDecode(jid);
  const user = decoded?.user || jid.split('@')[0];
  const digits = (user || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
}

/**
 * Send a text message to a chat via the active socket.
 */
export async function sendTextMessage(jid, text, mentions = [], quotedId = null) {
  const sock = getSocket();
  if (!sock) throw new Error('WhatsApp não conectado');
  const content = mentions && mentions.length > 0 ? { text, mentions } : { text };
  const options = {};
  if (quotedId) {
    const quoted = getRawMessage(jid, quotedId);
    if (quoted) options.quoted = quoted;
  }
  await sock.sendMessage(jid, content, options);
}

/** Forward a stored message to another chat. */
export async function forwardMessage(srcJid, msgId, destJid) {
  const sock = getSocket();
  if (!sock) throw new Error('WhatsApp não conectado');
  const original = getRawMessage(srcJid, msgId);
  if (!original) throw new Error('Mensagem original não encontrada');
  await sock.sendMessage(destJid, { forward: original });
}

/**
 * Mark a chat as read on WhatsApp: send read receipts for its recent incoming
 * messages and clear the local unread counter.
 */
/** Returns the full LID name map as a plain object (for the admin panel). */
export function getLidNames() {
  const out = {};
  for (const [lid, info] of store.lidNames.entries()) out[lid] = info;
  return out;
}

/** Manually set (override) a name for a LID or any JID. */
export function setContactName(jid, name) {
  if (!jid) return;
  if (jid.endsWith('@lid')) {
    const existing = store.lidNames.get(jid) || {};
    store.lidNames.set(jid, { ...existing, name });
  } else {
    const existing = store.contacts.get(jid) || {};
    store.contacts.set(jid, { ...existing, name });
  }
  _nameIndex = null;
  store.scheduleSave();
}

export async function markChatRead(jid) {
  const sock = getSocket();
  if (!sock) throw new Error('WhatsApp não conectado');
  const msgs = store.messages.get(jid) || [];
  const keys = msgs
    .filter((m) => !m.key?.fromMe && m.key?.id)
    .slice(-20)
    .map((m) => m.key);
  if (keys.length > 0) {
    await sock.readMessages(keys);
  }
  const chat = store.chats.get(jid);
  if (chat) chat.unreadCount = 0;
}

/**
 * Send a media message (image / video / audio / document) from a base64 payload.
 * @param {string} jid
 * @param {{ base64: string, mimetype: string, kind: string, filename?: string, caption?: string, ptt?: boolean }} media
 */
export async function sendMediaMessage(jid, media) {
  const sock = getSocket();
  if (!sock) throw new Error('WhatsApp não conectado');
  const { base64, mimetype, kind, filename, caption, ptt } = media;
  if (!base64) throw new Error('Arquivo vazio');
  const buffer = Buffer.from(base64, 'base64');

  let content;
  if (kind === 'image') {
    content = { image: buffer, mimetype: mimetype || 'image/jpeg', caption: caption || undefined };
  } else if (kind === 'video') {
    content = { video: buffer, mimetype: mimetype || 'video/mp4', caption: caption || undefined };
  } else if (kind === 'audio') {
    content = { audio: buffer, mimetype: mimetype || 'audio/mp4', ptt: ptt !== false };
  } else {
    content = {
      document: buffer,
      mimetype: mimetype || 'application/octet-stream',
      fileName: filename || 'arquivo',
      caption: caption || undefined,
    };
  }
  await sock.sendMessage(jid, content);
}

function formatMessages(messages, jid) {
  return messages.map((msg) => {
    const senderJid = msg.key?.participant || msg.key?.remoteJid || jid;
    return {
      id: msg.key?.id,
      fromMe: msg.key?.fromMe || false,
      sender: senderJid,
      senderName: resolveJidName(senderJid) || msg.pushName || jidToReadable(senderJid),
      text: resolveMentionsInText(extractMessageText(msg.message)),
      timestamp: msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000)
        : null,
      type: getMessageType(msg.message),
    };
  }).filter((m) => m.text || m.type !== 'unknown');
}

/** Look up the raw stored message object by chat + message id (for reply/forward). */
export function getRawMessage(jid, id) {
  const msgs = store.messages.get(jid) || [];
  return msgs.find((m) => m.key?.id === id) || null;
}

/**
 * Unwrap WhatsApp "container" messages (ephemeral / view-once / caption wrappers)
 * to get at the real inner message. Without this, media inside these wrappers is
 * invisible to extractMessageText/getMessageType and gets filtered out.
 */
function unwrapMessage(message) {
  if (!message) return message;
  let m = message;
  let guard = 0;
  while (m && guard++ < 5) {
    if (m.ephemeralMessage?.message) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage?.message) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2?.message) { m = m.viewOnceMessageV2.message; continue; }
    if (m.viewOnceMessageV2Extension?.message) { m = m.viewOnceMessageV2Extension.message; continue; }
    if (m.documentWithCaptionMessage?.message) { m = m.documentWithCaptionMessage.message; continue; }
    if (m.editedMessage?.message) { m = m.editedMessage.message; continue; }
    break;
  }
  return m;
}

/**
 * Extract plain text from a WhatsApp message object. Media always gets a
 * descriptive label (even without caption) so it never renders blank/disappears.
 */
function extractMessageText(rawMessage) {
  const message = unwrapMessage(rawMessage);
  if (!message) return '';

  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage) {
    const cap = message.imageMessage.caption;
    return cap ? `📷 [Foto] ${cap}` : '📷 [Foto]';
  }
  if (message.videoMessage) {
    const cap = message.videoMessage.caption;
    return cap ? `🎥 [Vídeo] ${cap}` : '🎥 [Vídeo]';
  }
  if (message.documentMessage) {
    const name = message.documentMessage.fileName || message.documentMessage.title || 'arquivo';
    const cap = message.documentMessage.caption;
    return cap ? `📎 [Documento] ${name} — ${cap}` : `📎 [Documento] ${name}`;
  }
  if (message.audioMessage) return message.audioMessage.ptt ? '🎤 [Mensagem de voz]' : '🎵 [Áudio]';
  if (message.stickerMessage) return '[Figurinha]';
  if (message.locationMessage) return '📍 [Localização]';
  if (message.liveLocationMessage) return '📍 [Localização ao vivo]';
  if (message.contactMessage) return `👤 [Contato] ${message.contactMessage.displayName || ''}`;
  if (message.contactsArrayMessage) return `👤 [Contatos] ${message.contactsArrayMessage.displayName || ''}`;
  if (message.pollCreationMessage) return `📊 [Enquete] ${message.pollCreationMessage.name || ''}`;
  if (message.pollCreationMessageV3) return `📊 [Enquete] ${message.pollCreationMessageV3.name || ''}`;
  if (message.reactionMessage) return `[Reação] ${message.reactionMessage.text || ''}`;
  if (message.buttonsMessage?.contentText) return message.buttonsMessage.contentText;
  if (message.buttonsResponseMessage?.selectedDisplayText) return message.buttonsResponseMessage.selectedDisplayText;
  if (message.listMessage?.description) return message.listMessage.description;
  if (message.listResponseMessage?.title) return message.listResponseMessage.title;
  if (message.templateButtonReplyMessage?.selectedDisplayText) return message.templateButtonReplyMessage.selectedDisplayText;
  if (message.protocolMessage) return ''; // system messages (revoke, etc.) — ignore

  return '';
}

/**
 * Determine message type string.
 */
function getMessageType(rawMessage) {
  const message = unwrapMessage(rawMessage);
  if (!message) return 'unknown';
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  if (message.documentMessage) return 'document';
  if (message.stickerMessage) return 'sticker';
  if (message.locationMessage || message.liveLocationMessage) return 'location';
  if (message.contactMessage || message.contactsArrayMessage) return 'contact';
  if (message.pollCreationMessage || message.pollCreationMessageV3) return 'poll';
  if (message.reactionMessage) return 'reaction';
  if (message.protocolMessage) return 'unknown';
  return 'unknown';
}
