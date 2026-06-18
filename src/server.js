import express from 'express';
import cors from 'cors';
import { createRequire } from 'module';
import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { state, broadcast } from './state.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { randomUUID } from 'crypto';
import { saveGroups, saveDelegates, saveIgnored, saveResolved } from './state.js';
import { getRecentMessages, getChatPhone, sendTextMessage, storeEvents } from './whatsapp.js';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json());
// Never cache HTML so dashboard updates always reach the browser immediately.
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(join(process.cwd(), 'public')));

// --- REST API ---

// GET /api/status
app.get('/api/status', (req, res) => {
  const active = state.analyzedChats.filter((c) => !state.ignoredJids.has(c.jid));
  const totalUnread = active.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  res.json({
    connected: state.connected,
    lastRun: state.lastRun,
    nextRun: state.nextRun,
    totalChats: active.length,
    totalUnread,
  });
});

// GET /api/report
app.get('/api/report', (req, res) => {
  res.json({
    chats: state.analyzedChats,
    resolvedJids: [...state.resolvedJids],
    ignoredJids: [...state.ignoredJids],
    lastRun: state.lastRun,
  });
});

// POST /api/ignore/:jid — move conversation to the "Geral" column
app.post('/api/ignore/:jid', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  state.ignoredJids.add(jid);
  await saveIgnored();
  res.json({ ok: true, jid, ignored: true });
});

// DELETE /api/ignore/:jid — restore conversation from "Geral"
app.delete('/api/ignore/:jid', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  state.ignoredJids.delete(jid);
  await saveIgnored();
  res.json({ ok: true, jid, ignored: false });
});

// POST /api/resolve/:jid — moves chat to "Respondidas" and records the moment,
// so any later incoming message brings it back to the panel by priority.
app.post('/api/resolve/:jid', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  state.resolvedJids.add(jid);
  state.repliedAt[jid] = Date.now();
  await saveResolved().catch(() => {});
  res.json({ ok: true, jid, resolved: true });
});

// DELETE /api/resolve/:jid
app.delete('/api/resolve/:jid', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  state.resolvedJids.delete(jid);
  delete state.repliedAt[jid];
  await saveResolved().catch(() => {});
  res.json({ ok: true, jid, resolved: false });
});

// GET /api/analytics
app.get('/api/analytics', (req, res) => {
  // Ignored ("Diversos") conversations must not skew the indicators.
  const chats = state.analyzedChats.filter((c) => !state.ignoredJids.has(c.jid));
  const diversosChats = state.analyzedChats.filter((c) => state.ignoredJids.has(c.jid));

  // Aggregate everyone in "Diversos" as a SINGLE group entry.
  const diversosAgg = diversosChats.length > 0
    ? {
        name: `Diversos (${diversosChats.length} conversas)`,
        unreadCount: diversosChats.reduce((s, c) => s + (c.unreadCount || 0), 0),
        type: 'Diversos',
        count: diversosChats.length,
      }
    : null;

  // Top senders by unreadCount
  let topSenders = [...chats]
    .sort((a, b) => (b.unreadCount || 0) - (a.unreadCount || 0))
    .slice(0, 10)
    .map((c) => ({ name: c.name, unreadCount: c.unreadCount || 0, type: c.type }));
  if (diversosAgg) topSenders = [...topSenders.slice(0, 9), diversosAgg];

  // Priority distribution
  const priorityDistribution = { CRITICA: 0, ALTA: 0, MEDIA: 0, BAIXA: 0 };
  for (const c of chats) {
    if (priorityDistribution[c.priority] !== undefined) {
      priorityDistribution[c.priority]++;
    }
  }

  // Most active groups
  const mostActiveGroups = chats
    .filter((c) => c.type === 'Grupo')
    .sort((a, b) => (b.unreadCount || 0) - (a.unreadCount || 0))
    .slice(0, 5)
    .map((c) => ({ name: c.name, unreadCount: c.unreadCount || 0 }));

  // Hourly volume: parse lastMessageTime for hour distribution
  const hourlyVolume = new Array(24).fill(0);
  for (const c of chats) {
    if (c.lastMessageTime) {
      // lastMessageTime may be a Date or string
      const d = new Date(c.lastMessageTime);
      if (!isNaN(d.getTime())) {
        hourlyVolume[d.getHours()] += c.unreadCount || 1;
      }
    }
  }

  res.json({ topSenders, priorityDistribution, mostActiveGroups, hourlyVolume, diversos: diversosAgg });
});

// GET /api/history — list report files
app.get('/api/history', async (req, res) => {
  try {
    const dir = config.reports.dir;
    const files = await readdir(dir);
    const reportFiles = files
      .filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 50)
      .map((f) => ({ filename: f }));
    res.json(reportFiles);
  } catch {
    res.json([]);
  }
});

// GET /api/history/:filename — return file contents
app.get('/api/history/:filename', async (req, res) => {
  try {
    const filename = basename(req.params.filename); // prevent path traversal
    const filePath = join(config.reports.dir, filename);
    const content = await readFile(filePath, 'utf-8');
    res.json({ filename, content });
  } catch (err) {
    res.status(404).json({ error: 'File not found' });
  }
});

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send a heartbeat comment to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  state.sseClients.add(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    state.sseClients.delete(res);
  });
});

// Groups API
app.get('/api/groups', (req, res) => {
  res.json({ groups: state.groups });
});

app.post('/api/groups', async (req, res) => {
  const { name, emoji, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const group = { id: randomUUID(), name, emoji: emoji || '📁', color: color || '#3b82f6', jids: [] };
  state.groups.push(group);
  await saveGroups();
  res.json({ ok: true, group });
});

app.delete('/api/groups/:id', async (req, res) => {
  const idx = state.groups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  state.groups.splice(idx, 1);
  await saveGroups();
  res.json({ ok: true });
});

app.post('/api/groups/:id/assign', async (req, res) => {
  const { jid } = req.body;
  const group = state.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'not found' });
  // Remove jid from all groups first
  state.groups.forEach(g => { g.jids = g.jids.filter(j => j !== jid); });
  group.jids.push(jid);
  await saveGroups();
  res.json({ ok: true });
});

app.delete('/api/groups/:id/assign/:jid', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const group = state.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'not found' });
  group.jids = group.jids.filter(j => j !== jid);
  await saveGroups();
  res.json({ ok: true });
});

// Delegates API
app.get('/api/delegates', (req, res) => {
  res.json({ delegates: state.delegates });
});

app.post('/api/delegate', async (req, res) => {
  const { jid, assignee } = req.body;
  if (!jid || !assignee) return res.status(400).json({ error: 'jid and assignee required' });
  state.delegates[jid] = assignee;
  await saveDelegates();
  res.json({ ok: true, jid, assignee });
});

// GET /api/messages/:jid — recent messages + metadata for the detail view
app.get('/api/messages/:jid', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const chat = state.analyzedChats.find((c) => c.jid === jid);
  const messages = getRecentMessages(jid, limit);
  res.json({
    jid,
    name: chat?.name || jid,
    type: chat?.type || 'Contato',
    phone: getChatPhone(jid),
    suggestedResponse: chat?.suggestedResponse || null,
    participants: chat?.participants || [],
    messages,
  });
});

// POST /api/summarize — summarize WHAT WAS DISCUSSED (not a reply draft)
const _openaiForSummary = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
app.post('/api/summarize', async (req, res) => {
  const { jid } = req.body || {};
  if (!jid) return res.status(400).json({ error: 'jid required' });
  const chat = state.analyzedChats.find((c) => c.jid === jid);
  const messages = getRecentMessages(jid, 40);

  if (!process.env.OPENAI_API_KEY) {
    return res.json({ summary: chat?.summary || 'Sem resumo disponível.' });
  }

  const convo = messages
    .map((m) => `${m.fromMe ? 'Ricardo' : (m.senderName || 'Contato')}: ${m.text}`)
    .join('\n');

  const prompt = `Resuma de forma objetiva e clara, em português, O QUE FOI TRATADO nesta conversa do WhatsApp (${chat?.name || jid}).
Não escreva uma resposta. Faça um resumo executivo em tópicos curtos: assunto principal, decisões/pendências e o que precisa de atenção.

Conversa:
${convo || '(sem mensagens recentes)'}`;

  try {
    const response = await _openaiForSummary.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    });
    res.json({ summary: (response.choices[0]?.message?.content || '').trim() });
  } catch (err) {
    logger.error({ err }, 'Erro ao resumir conversa');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate-reply — draft/refine a reply with AI using recent messages
const _openaiForReply = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
app.post('/api/generate-reply', async (req, res) => {
  const { jid, instruction } = req.body || {};
  if (!jid) return res.status(400).json({ error: 'jid required' });
  const chat = state.analyzedChats.find((c) => c.jid === jid);
  const messages = getRecentMessages(jid, 20);

  if (!process.env.OPENAI_API_KEY) {
    return res.json({ reply: chat?.suggestedResponse || 'Olá! Recebi sua mensagem e retorno em breve.' });
  }

  const convo = messages
    .map((m) => `${m.fromMe ? 'Ricardo' : (m.senderName || 'Contato')}: ${m.text}`)
    .join('\n');

  const prompt = `Você é assistente executivo de Ricardo Dourado (Uranus2).
Com base na conversa abaixo do WhatsApp, escreva uma resposta curta, profissional e cordial em português, na primeira pessoa, pronta para enviar.
${instruction ? `\nInstrução adicional do Ricardo: ${instruction}\n` : ''}
Conversa (${chat?.name || jid}):
${convo || '(sem mensagens recentes)'}

Responda APENAS com o texto da mensagem, sem aspas e sem comentários.`;

  try {
    const response = await _openaiForReply.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 400,
    });
    res.json({ reply: (response.choices[0]?.message?.content || '').trim() });
  } catch (err) {
    logger.error({ err }, 'Erro ao gerar resposta');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/:jid — send a message directly via WhatsApp (for groups/LID)
app.post('/api/send/:jid', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  try {
    await sendTextMessage(jid, text.trim());
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, jid }, 'Erro ao enviar mensagem');
    res.status(500).json({ error: err.message });
  }
});

// Generate email
const _openaiForEmail = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

app.post('/api/generate-email', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).json({ error: 'jid required' });
  const chat = state.analyzedChats.find(c => c.jid === jid);
  if (!chat) return res.status(404).json({ error: 'chat not found' });

  if (!process.env.OPENAI_API_KEY) {
    return res.json({
      subject: `Re: ${chat.name}`,
      body: `Prezado(a),\n\nEm referência à nossa conversa recente, gostaríamos de confirmar os pontos discutidos.\n\n${chat.summary || ''}\n\nAtenciosamente,\nRicardo Dourado | Uranus2`
    });
  }

  try {
    const prompt = `Você é assistente executivo de Ricardo Dourado da empresa Uranus2.
Com base nesta conversa do WhatsApp, escreva um e-mail profissional em português.

Conversa: ${chat.name}
Resumo: ${chat.summary || 'Sem resumo'}
Itens de ação: ${(chat.actionItems || []).join('; ') || 'Nenhum'}
Última mensagem: ${chat.lastMessage || ''}

Retorne JSON: { "subject": "assunto do email", "body": "corpo completo do email" }
O email deve ser formal, profissional, assinado como "Ricardo Dourado | Uranus2".
Responda APENAS o JSON, sem markdown.`;

    const response = await _openaiForEmail.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 800,
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || '{}');
    res.json({ subject: parsed.subject || `Re: ${chat.name}`, body: parsed.body || '' });
  } catch (err) {
    logger.error({ err }, 'Erro ao gerar email');
    res.status(500).json({ error: err.message });
  }
});

// TV page
app.get('/tv', (req, res) => {
  res.sendFile(join(process.cwd(), 'public', 'tv.html'));
});

// --- Exported functions ---

export function initServer(port = 3000) {
  app.listen(port, () => {
    logger.info(`Dashboard disponível em http://localhost:${port}`);
  });

  // Real-time: push live message activity to the dashboard, and keep the
  // in-memory report's lastMessage/unread in sync so it doesn't get stale.
  storeEvents.on('message-activity', (act) => {
    if (state.ignoredJids.has(act.jid)) return; // hidden chats stay hidden
    const existing = state.analyzedChats.find((c) => c.jid === act.jid);
    if (existing) {
      existing.lastMessage = act.text || existing.lastMessage;
      existing.lastMessageTime = act.timestamp;
      existing.unreadCount = act.unreadCount;
    }
    broadcast('message-activity', act);
  });
}

export function updateReportData(analyzedChats) {
  const prev = state._prevAnalyzedChats || [];

  // Track previous critical jids for new-critical detection
  const prevCriticalJids = new Set(
    prev.filter((c) => c.priority === 'CRITICA').map((c) => c.jid)
  );

  // "Segunda camada": MESCLA o resultado novo sobre o anterior em vez de
  // substituir. Conversas que sairam do top-80 deste ciclo continuam no painel
  // (camada base); as reanalisadas agora sobrescrevem suas versoes antigas.
  const merged = new Map();
  for (const c of prev) merged.set(c.jid, c);
  for (const c of analyzedChats) merged.set(c.jid, c);
  const mergedChats = [...merged.values()];

  state.analyzedChats = mergedChats;
  state.lastRun = new Date();

  const newCriticals = analyzedChats.filter(
    (c) => c.priority === 'CRITICA' && !prevCriticalJids.has(c.jid) && !state.ignoredJids.has(c.jid)
  );

  state._prevAnalyzedChats = mergedChats;

  // Broadcast cycle-complete
  broadcast('cycle-complete', {
    chats: mergedChats,
    resolvedJids: [...state.resolvedJids],
    ignoredJids: [...state.ignoredJids],
    lastRun: state.lastRun,
  });

  // Broadcast new-critical events
  for (const chat of newCriticals) {
    broadcast('new-critical', { name: chat.name, summary: chat.summary, jid: chat.jid });
  }
}
