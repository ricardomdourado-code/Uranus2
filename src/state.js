import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';

const DATA_DIR = resolve('./data');
const GROUPS_FILE = resolve('./data/groups.json');
const DELEGATES_FILE = resolve('./data/delegates.json');
const IGNORED_FILE = resolve('./data/ignored.json');
const RESOLVED_FILE = resolve('./data/resolved.json');

export const state = {
  analyzedChats: [],
  resolvedJids: new Set(),     // conversations moved to "Respondidas"
  repliedAt: {},               // { jid: epochMs } — baseline to detect new movement
  ignoredJids: new Set(),  // conversations moved to the "Geral" column
  lastRun: null,
  nextRun: null,
  connected: false,
  sseClients: new Set(),
  groups: [],        // [{ id, name, emoji, color, jids: [] }]
  delegates: {},     // { jid: assigneeName }
};

export async function loadPersistedData() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const g = await readFile(GROUPS_FILE, 'utf-8');
    state.groups = JSON.parse(g);
  } catch { state.groups = []; }
  try {
    const d = await readFile(DELEGATES_FILE, 'utf-8');
    state.delegates = JSON.parse(d);
  } catch { state.delegates = {}; }
  try {
    const i = await readFile(IGNORED_FILE, 'utf-8');
    state.ignoredJids = new Set(JSON.parse(i));
  } catch { state.ignoredJids = new Set(); }
  try {
    const r = await readFile(RESOLVED_FILE, 'utf-8');
    const parsed = JSON.parse(r);
    state.resolvedJids = new Set(parsed.resolved || []);
    state.repliedAt = parsed.repliedAt || {};
  } catch { state.resolvedJids = new Set(); state.repliedAt = {}; }
}

export async function saveIgnored() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(IGNORED_FILE, JSON.stringify([...state.ignoredJids], null, 2));
}

export async function saveResolved() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(RESOLVED_FILE, JSON.stringify({
    resolved: [...state.resolvedJids],
    repliedAt: state.repliedAt,
  }, null, 2));
}

export async function saveGroups() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(GROUPS_FILE, JSON.stringify(state.groups, null, 2));
}

export async function saveDelegates() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DELEGATES_FILE, JSON.stringify(state.delegates, null, 2));
}

export function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of state.sseClients) {
    client.write(msg);
  }
}
