import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';

const DATA_DIR = resolve('./data');
const GROUPS_FILE = resolve('./data/groups.json');
const DELEGATES_FILE = resolve('./data/delegates.json');

export const state = {
  analyzedChats: [],
  resolvedJids: new Set(),
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
