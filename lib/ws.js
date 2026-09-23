'use strict';
const WebSocket = require('ws');

const clients = new Set();

function attach(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // 房间：连接时 ?e=<slug> 指定场次，缺省 default
    try {
      const u = new URL(req.url, 'http://x');
      ws.room = u.searchParams.get('e') || 'default';
    } catch { ws.room = 'default'; }
    ws.send(JSON.stringify({ type: 'hello' }));
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  // 30s 心跳，清理死连接
  setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) { clients.delete(ws); ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000).unref();
}

// 向指定场次房间广播
function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && (ws.room || 'default') === (room || 'default')) {
      try { ws.send(msg); } catch { /* ignore */ }
    }
  }
}

function clientCount() {
  return clients.size;
}

module.exports = { attach, broadcast, clientCount };
