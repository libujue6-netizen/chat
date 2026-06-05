const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── In-memory store ──────────────────────────────────────────────────────────
// rooms[roomId] = { id, name, desc, mode, visibility, hostNick, createdAt, members:{nick->ws}, messages:[{id,sender,enc,type,time}] }
const rooms = {};

// ── Helpers ──────────────────────────────────────────────────────────────────
function genId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function broadcastRoom(roomId, payload, exceptWs = null) {
  const room = rooms[roomId];
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const [, ws] of Object.entries(room.members)) {
    if (ws !== exceptWs && ws.readyState === 1) ws.send(data);
  }
}

function roomPublicInfo(room) {
  return {
    id: room.id,
    name: room.name,
    desc: room.desc,
    mode: room.mode,
    visibility: room.visibility,
    hostNick: room.hostNick,
    memberCount: Object.keys(room.members).length,
    createdAt: room.createdAt,
  };
}

function memberList(room) {
  return Object.keys(room.members).map(nick => ({
    nick,
    isHost: nick === room.hostNick,
  }));
}

// ── REST API ─────────────────────────────────────────────────────────────────

// GET /api/lobby — public rooms list
app.get('/api/lobby', (req, res) => {
  const list = Object.values(rooms)
    .filter(r => r.visibility === 'public')
    .map(roomPublicInfo);
  res.json(list);
});

// POST /api/rooms — create room
app.post('/api/rooms', (req, res) => {
  const { name, desc, mode, visibility, hostNick } = req.body;
  if (!name || !hostNick) return res.status(400).json({ error: '缺少必填字段' });

  const id = genId();
  rooms[id] = {
    id,
    name: name.slice(0, 30),
    desc: (desc || '').slice(0, 100),
    mode: mode === 'destroy' ? 'destroy' : 'keep',
    visibility: visibility === 'hidden' ? 'hidden' : 'public',
    hostNick,
    createdAt: Date.now(),
    members: {},       // nick -> ws
    messages: [],      // encrypted history
  };

  res.json({ roomId: id });
});

// GET /api/rooms/:id — room info + history (history only for 'keep' rooms)
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在或已销毁' });

  res.json({
    ...roomPublicInfo(room),
    messages: room.mode === 'keep' ? room.messages : [],
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
// Protocol: each message is JSON with an `event` field.
//
// Client → Server events:
//   join        { event, roomId, nick }
//   message     { event, roomId, nick, enc, type, time }
//   destroy     { event, roomId, nick }
//   kick        { event, roomId, nick, target }
//   leave       { event, roomId, nick }
//
// Server → Client events:
//   joined      { event, members, messages }
//   member_join { event, nick, members }
//   member_leave{ event, nick, members }
//   message     { event, id, sender, enc, type, time }
//   destroyed   { event, by }
//   kicked      { event, target }
//   error       { event, message }

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentNick = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── join ──────────────────────────────────────────────────────────────
    if (msg.event === 'join') {
      const room = rooms[msg.roomId];
      if (!room) {
        ws.send(JSON.stringify({ event: 'error', message: '房间不存在或已销毁' }));
        return;
      }
      const nick = (msg.nick || '偷闲者').slice(0, 20);

      // If nick already connected, replace old ws
      if (room.members[nick]) {
        try { room.members[nick].close(); } catch {}
      }

      room.members[nick] = ws;
      currentRoom = msg.roomId;
      currentNick = nick;

      // Send current state to joiner
      ws.send(JSON.stringify({
        event: 'joined',
        room: roomPublicInfo(room),
        members: memberList(room),
        messages: room.mode === 'keep' ? room.messages : [],
      }));

      // Notify others
      broadcastRoom(msg.roomId, {
        event: 'member_join',
        nick,
        members: memberList(room),
      }, ws);
    }

    // ── message ───────────────────────────────────────────────────────────
    else if (msg.event === 'message') {
      const room = rooms[msg.roomId];
      if (!room) return;

      const record = {
        id: uuidv4(),
        sender: msg.nick,
        enc: msg.enc,       // ciphertext — server never sees plaintext
        type: msg.type || 'text',
        time: msg.time || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      };

      if (room.mode === 'keep') room.messages.push(record);

      // Broadcast to everyone including sender
      const payload = JSON.stringify({ event: 'message', ...record });
      for (const [, memberWs] of Object.entries(room.members)) {
        if (memberWs.readyState === 1) memberWs.send(payload);
      }
    }

    // ── destroy ───────────────────────────────────────────────────────────
    else if (msg.event === 'destroy') {
      const room = rooms[msg.roomId];
      if (!room) return;
      if (msg.nick !== room.hostNick) {
        ws.send(JSON.stringify({ event: 'error', message: '只有房主可以销毁房间' }));
        return;
      }
      broadcastRoom(msg.roomId, { event: 'destroyed', by: msg.nick });
      delete rooms[msg.roomId];
    }

    // ── kick ──────────────────────────────────────────────────────────────
    else if (msg.event === 'kick') {
      const room = rooms[msg.roomId];
      if (!room || msg.nick !== room.hostNick) return;
      const targetWs = room.members[msg.target];
      if (targetWs) {
        targetWs.send(JSON.stringify({ event: 'kicked' }));
        try { targetWs.close(); } catch {}
        delete room.members[msg.target];
        broadcastRoom(msg.roomId, { event: 'member_leave', nick: msg.target, members: memberList(room) });
      }
    }

    // ── leave ─────────────────────────────────────────────────────────────
    else if (msg.event === 'leave') {
      handleLeave(msg.roomId, msg.nick);
    }
  });

  ws.on('close', () => {
    if (currentRoom && currentNick) handleLeave(currentRoom, currentNick);
  });

  function handleLeave(roomId, nick) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.members[nick] === ws) delete room.members[nick];

    const remaining = Object.keys(room.members).length;

    if (remaining === 0 && room.mode === 'destroy') {
      delete rooms[roomId];
      return;
    }

    broadcastRoom(roomId, {
      event: 'member_leave',
      nick,
      members: memberList(room),
    });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`半日闲 running on http://localhost:${PORT}`);
});
