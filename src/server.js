import express from 'express';
import cors from 'cors';
import { createRequire } from 'module';
import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { state, broadcast } from './state.js';
import { config } from './config.js';
import { logger } from './logger.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(process.cwd(), 'public')));

// --- REST API ---

// GET /api/status
app.get('/api/status', (req, res) => {
  const totalUnread = state.analyzedChats.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  res.json({
    connected: state.connected,
    lastRun: state.lastRun,
    nextRun: state.nextRun,
    totalChats: state.analyzedChats.length,
    totalUnread,
  });
});

// GET /api/report
app.get('/api/report', (req, res) => {
  res.json({
    chats: state.analyzedChats,
    resolvedJids: [...state.resolvedJids],
    lastRun: state.lastRun,
  });
});

// POST /api/resolve/:jid
app.post('/api/resolve/:jid', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  state.resolvedJids.add(jid);
  res.json({ ok: true, jid, resolved: true });
});

// DELETE /api/resolve/:jid
app.delete('/api/resolve/:jid', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  state.resolvedJids.delete(jid);
  res.json({ ok: true, jid, resolved: false });
});

// GET /api/analytics
app.get('/api/analytics', (req, res) => {
  const chats = state.analyzedChats;

  // Top senders by unreadCount
  const topSenders = [...chats]
    .sort((a, b) => (b.unreadCount || 0) - (a.unreadCount || 0))
    .slice(0, 10)
    .map((c) => ({ name: c.name, unreadCount: c.unreadCount || 0, type: c.type }));

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

  res.json({ topSenders, priorityDistribution, mostActiveGroups, hourlyVolume });
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

// --- Exported functions ---

export function initServer(port = 3000) {
  app.listen(port, () => {
    logger.info(`Dashboard disponível em http://localhost:${port}`);
  });
}

export function updateReportData(analyzedChats) {
  state.analyzedChats = analyzedChats;
  state.lastRun = new Date();

  // Track previous critical jids for new-critical detection
  const prevCriticalJids = new Set(
    (state._prevAnalyzedChats || [])
      .filter((c) => c.priority === 'CRITICA')
      .map((c) => c.jid)
  );

  const newCriticals = analyzedChats.filter(
    (c) => c.priority === 'CRITICA' && !prevCriticalJids.has(c.jid)
  );

  state._prevAnalyzedChats = analyzedChats;

  // Broadcast cycle-complete
  broadcast('cycle-complete', {
    chats: analyzedChats,
    resolvedJids: [...state.resolvedJids],
    lastRun: state.lastRun,
  });

  // Broadcast new-critical events
  for (const chat of newCriticals) {
    broadcast('new-critical', { name: chat.name, summary: chat.summary, jid: chat.jid });
  }
}
