// PocketMeet — signaling server.
// It ONLY relays WebRTC handshake messages so peers can find each other.
// Actual audio/video/chat travel peer-to-peer and are encrypted end-to-end
// (DTLS-SRTP for media, DTLS for the chat data channel). The server never
// sees your media or your messages.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms: Map<roomCode, Map<peerId, ws>>
const rooms = new Map();
const MAX_PER_ROOM = 8;

const send = (ws, msg) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

function leaveRoom(ws) {
  const peers = rooms.get(ws.room);
  if (!peers) return;
  peers.delete(ws.id);
  for (const [, c] of peers) send(c, { type: 'peer-left', id: ws.id });
  if (peers.size === 0) rooms.delete(ws.room);
  ws.room = null;
}

wss.on('connection', (ws) => {
  ws.id = randomUUID().slice(0, 8);
  ws.room = null;
  ws.name = 'Guest';

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join': {
        const room = String(msg.room || '').trim();
        if (!room) return send(ws, { type: 'error', error: 'no-room' });
        if (ws.room) leaveRoom(ws);

        ws.name = String(msg.name || 'Guest').slice(0, 40);
        ws.room = room;

        if (!rooms.has(room)) rooms.set(room, new Map());
        const peers = rooms.get(room);

        if (peers.size >= MAX_PER_ROOM) {
          return send(ws, { type: 'error', error: 'room-full' });
        }

        // Tell the newcomer who's already here (they will send the offers).
        const existing = [...peers.entries()].map(([id, c]) => ({ id, name: c.name }));
        send(ws, { type: 'joined', self: { id: ws.id, name: ws.name }, peers: existing });

        // Announce the newcomer to everyone already in the room.
        for (const [, c] of peers) send(c, { type: 'peer-joined', id: ws.id, name: ws.name });

        peers.set(ws.id, ws);
        break;
      }

      case 'signal': {
        // Relay an SDP offer/answer or an ICE candidate to one specific peer.
        const peers = rooms.get(ws.room);
        if (!peers) return;
        const target = peers.get(msg.to);
        if (!target) return;
        send(target, { type: 'signal', from: ws.id, data: msg.data });
        break;
      }

      case 'leave':
        leaveRoom(ws);
        break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  PocketMeet running →  http://localhost:${PORT}\n`);
});
