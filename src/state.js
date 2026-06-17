export const state = {
  analyzedChats: [],
  resolvedJids: new Set(),
  lastRun: null,
  nextRun: null,
  connected: false,
  sseClients: new Set(),
};

export function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of state.sseClients) {
    client.write(msg);
  }
}
