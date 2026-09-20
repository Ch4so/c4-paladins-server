// C4 Paladins Draft Trainer — online server (Node + Socket.IO)
// Server-authoritative draft: holds room state, runs the timer, validates turns.
// Cross-platform: any client (Windows/iOS/Android/web) connecting to this URL can play together.
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const STEP_MS = 28000, BONUS_MS = 60000, TICK = 250;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('C4 Paladins Draft Trainer server is running.');
});
const io = new Server(httpServer, { cors: { origin: '*' } });

/** rooms: code -> { code, password, hostId, guestId, champions:[names], maps:[{name,img}], state, interval } */
const rooms = new Map();
const genCode = () => { let c; do { c = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (rooms.has(c)); return c; };

function buildSequence(fmt) {
  const q = [], P = (t, s) => q.push({ type: t, side: s });
  if (fmt === 'ranked') {
    ['A','B','A','B'].forEach(s => P('ban', s));
    ['A','B','B','A','A','B'].forEach(s => P('pick', s));
    ['A','B','A','B'].forEach(s => P('ban', s));
    ['A','B','B','A'].forEach(s => P('pick', s));
  } else ['A','B','B','A','A','B','B','A','A','B'].forEach(s => P('pick', s));
  return q;
}
const teamOf = (room, side) => side === 'A' ? room.state.firstTeam : (3 - room.state.firstTeam);
const curStep = room => { const s = room.state; return (s.step >= 0 && s.step < s.seq.length) ? s.seq[s.step] : null; };
function taken(room, n) { const s = room.state; return s.bans[1].includes(n) || s.bans[2].includes(n) || s.picks[1].includes(n) || s.picks[2].includes(n); }

function publicState(room) {
  const s = room.state;
  return { format: s.format, seq: s.seq, step: s.step, firstTeam: s.firstTeam,
    picks: s.picks, bans: s.bans, bonus: s.bonus, stepRemaining: s.stepRemaining,
    stepMax: s.stepMax, map: s.map, running: s.running, done: s.done };
}
const broadcast = room => io.to(room.code).emit('state', publicState(room));
const emitTimer = room => io.to(room.code).emit('timer', { stepRemaining: room.state.stepRemaining, bonus: room.state.bonus });

function startDraft(room, format) {
  const maps = room.maps || [];
  room.state = {
    format, seq: buildSequence(format), step: -1,
    firstTeam: Math.random() < 0.5 ? 1 : 2,
    picks: { 1: [], 2: [] }, bans: { 1: [], 2: [] },
    bonus: { 1: BONUS_MS, 2: BONUS_MS }, stepRemaining: STEP_MS, stepMax: STEP_MS,
    map: maps.length ? maps[Math.floor(Math.random() * maps.length)] : { name: '(no map)', img: '' },
    running: true, done: false
  };
  clearInterval(room.interval);
  room.interval = setInterval(() => roomTick(room), TICK);
  advance(room);
}
function advance(room) {
  const s = room.state; s.step++;
  const st = curStep(room);
  if (!st) { finish(room); return; }
  s.stepMax = STEP_MS; s.stepRemaining = STEP_MS;
  broadcast(room);
}
function finish(room) {
  room.state.running = false; room.state.done = true;
  clearInterval(room.interval); room.interval = null;
  broadcast(room);
}
function roomTick(room) {
  const s = room.state; if (!s.running || s.done) return;
  const st = curStep(room); if (!st) return;
  const team = teamOf(room, st.side);
  if (s.stepRemaining > 0) s.stepRemaining -= TICK;
  else { s.bonus[team] -= TICK; if (s.bonus[team] <= 0) { s.bonus[team] = 0; forceAuto(room, team); return; } }
  emitTimer(room);
}
function forceAuto(room, team) {
  const st = curStep(room); if (!st) return;
  const pool = room.champions.filter(n => !taken(room, n));
  if (!pool.length) { advance(room); return; }
  const n = pool[Math.floor(Math.random() * pool.length)];
  (st.type === 'ban' ? room.state.bans[team] : room.state.picks[team]).push(n);
  advance(room);
}
function applyAction(room, team, type, name) {
  const st = curStep(room);
  if (!room.state.running || !st) return false;
  if (st.type !== type) return false;
  if (teamOf(room, st.side) !== team) return false;
  if (!room.champions.includes(name) || taken(room, name)) return false;
  (type === 'ban' ? room.state.bans[team] : room.state.picks[team]).push(name);
  advance(room);
  return true;
}
function roomOf(socket) {
  for (const room of rooms.values()) if (room.hostId === socket.id || room.guestId === socket.id) return room;
  return null;
}

io.on('connection', socket => {
  socket.on('createRoom', (data, cb) => {
    try {
      const code = genCode();
      const room = { code, password: String(data.password || ''), hostId: socket.id, guestId: null,
        champions: (data.champions || []).slice(), maps: (data.maps || []).slice(),
        format: data.format === 'casual' ? 'casual' : 'ranked', state: null, interval: null };
      rooms.set(code, room);
      socket.join(code);
      cb && cb({ ok: true, code, myTeam: 1 });
      socket.emit('lobby', { msg: `ルーム作成: コード ${code} — 相手の参加を待っています…`, code });
    } catch (e) { cb && cb({ ok: false, error: 'サーバーエラー' }); }
  });

  socket.on('joinRoom', (data, cb) => {
    const room = rooms.get(String(data.code || '').toUpperCase());
    if (!room) return cb && cb({ ok: false, error: 'ルームが見つかりません' });
    if (room.guestId) return cb && cb({ ok: false, error: 'ルームは満員です' });
    if (room.password !== String(data.password || '')) return cb && cb({ ok: false, error: 'パスワードが違います' });
    room.guestId = socket.id;
    socket.join(room.code);
    cb && cb({ ok: true, code: room.code, myTeam: 2 });
    io.to(room.code).emit('peerJoined', {});
    startDraft(room, room.format);   // both present -> begin
  });

  socket.on('action', data => {
    const room = roomOf(socket); if (!room) return;
    const team = room.hostId === socket.id ? 1 : 2;
    applyAction(room, team, data.type, data.name);
  });

  socket.on('leaveRoom', () => cleanup(socket, true));
  socket.on('disconnect', () => cleanup(socket, false));
});

function cleanup(socket, intentional) {
  const room = roomOf(socket); if (!room) return;
  clearInterval(room.interval);
  io.to(room.code).emit('peerLeft', { intentional });
  rooms.delete(room.code);
}

httpServer.listen(PORT, () => console.log(`C4 Paladins Draft server listening on :${PORT}`));
