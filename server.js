// C4 Paladins Draft Trainer — online server (Node + Socket.IO)
// Server-authoritative draft. Cross-platform (Windows/iOS/Android/Web all connect here).
const http = require('http');
const { Server } = require('socket.io');
const PORT = process.env.PORT || 3000;
const STEP_MS = 28000, BONUS_MS = 60000, TICK = 250;
const httpServer = http.createServer((req, res) => {
res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
res.end('C4 Paladins Draft Trainer server is running.');
});
const io = new Server(httpServer, { cors: { origin: '*' } });
const rooms = new Map();
function buildSequence(fmt) {
const q = [], P = (t, s) => q.push({ type: t, side: s });
if (fmt === 'ranked') {
P('ban','A');P('ban','B');P('ban','A');P('ban','B');
P('pick','A');P('pick','B');P('pick','B');P('pick','A');P('pick','A');P('pick','B');
P('ban','A');P('ban','B');P('ban','A');P('ban','B');
P('pick','A');P('pick','B');P('pick','B');P('pick','A');
} else { ['A','B','B','A','A','B','B','A','A','B'].forEach(s => P('pick', s)); }
return q;
}
const teamOf = (room, side) => side === 'A' ? room.state.firstTeam : (3 - room.state.firstTeam);
const curStep = room => { const s = room.state; return s && s.step >= 0 && s.step < s.seq.length ? s.seq[s.step] : null; };
function taken(room, n) { const s = room.state; return s.bans[1].includes(n) || s.bans[2].includes(n) || s.picks[1].includes(n) || s.picks[2].includes(n); }
function publicState(room) {
const s = room.state;
return { format: s.format, seq: s.seq, step: s.step, firstTeam: s.firstTeam, picks: s.picks, bans: s.bans, bonus: s.bonus, stepRemaining: s.stepRemaining, stepMax: s.stepMax, map: s.map, running: s.running, done: s.done };
}
const broadcast = room => io.to(room.code).emit('state', publicState(room));
const emitTimer = room => io.to(room.code).emit('timer', { stepRemaining: room.state.stepRemaining, bonus: room.state.bonus });
function startDraft(room) {
const maps = room.maps || [];
room.votes = { 1: false, 2: false };
room.state = {
format: room.format, seq: buildSequence(room.format), step: -1,
firstTeam: Math.random() < 0.5 ? 1 : 2,
picks: { 1: [], 2: [] }, bans: { 1: [], 2: [] },
bonus: { 1: BONUS_MS, 2: BONUS_MS }, stepRemaining: STEP_MS, stepMax: STEP_MS,
map: maps.length ? maps[Math.floor(Math.random() * maps.length)] : { name: 'none', img: '' },
running: true, done: false
};
clearInterval(room.interval);
room.interval = setInterval(() => roomTick(room), TICK);
advance(room);
}
function advance(room) {
const s = room.state; s.step++;
if (!curStep(room)) { finish(room); return; }
s.stepMax = STEP_MS; s.stepRemaining = STEP_MS;
broadcast(room);
}
function finish(room) {
room.state.running = false; room.state.done = true;
room.votes = { 1: false, 2: false };
clearInterval(room.interval); room.interval = null;
broadcast(room);
}
function roomTick(room) {
const s = room.state; if (!s || !s.running || s.done) return;
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
if (!room.state || !room.state.running || !st) return;
if (st.type !== type || teamOf(room, st.side) !== team) return;
if (!room.champions.includes(name) || taken(room, name)) return;
(type === 'ban' ? room.state.bans[team] : room.state.picks[team]).push(name);
advance(room);
}
function roomOf(socket) {
for (const room of rooms.values()) if (room.hostId === socket.id || room.guestId === socket.id) return room;
return null;
}
io.on('connection', socket => {
socket.on('createRoom', (data, cb) => {
const code = String(data.code || '').toUpperCase();
if (!/^[A-Z0-9]{5}$/.test(code)) return cb && cb({ ok: false, error: 'invalid code' });
if (rooms.has(code)) return cb && cb({ ok: false, error: 'そのコードは使用中です。再生成してください' });
const room = {
code, password: data.requirePassword ? String(data.password || '') : null,
hostId: socket.id, guestId: null,
champions: (data.champions || []).slice(), maps: (data.maps || []).slice(),
format: data.format === 'casual' ? 'casual' : 'ranked',
state: null, interval: null, votes: { 1: false, 2: false }
};
rooms.set(code, room); socket.join(code);
cb && cb({ ok: true, code, myTeam: 1, requirePassword: room.password !== null });
});
socket.on('joinRoom', (data, cb) => {
const room = rooms.get(String(data.code || '').toUpperCase());
if (!room) return cb && cb({ ok: false, error: 'ルームが見つかりません' });
if (room.guestId) return cb && cb({ ok: false, error: 'ルームは満員です' });
if (room.password !== null && room.password !== String(data.password || '')) return cb && cb({ ok: false, error: 'パスワードが違います' });
room.guestId = socket.id; socket.join(room.code);
cb && cb({ ok: true, code: room.code, myTeam: 2 });
io.to(room.code).emit('peerJoined', {});
startDraft(room);
});
socket.on('action', data => {
const room = roomOf(socket); if (!room) return;
applyAction(room, room.hostId === socket.id ? 1 : 2, data.type, data.name);
});
socket.on('next', () => {
const room = roomOf(socket); if (!room || !room.state || !room.state.done) return;
room.votes[room.hostId === socket.id ? 1 : 2] = true;
io.to(room.code).emit('votes', room.votes);
if (room.votes[1] && room.votes[2]) startDraft(room);
});
socket.on('leaveRoom', () => cleanup(socket));
socket.on('disconnect', () => cleanup(socket));
});
function cleanup(socket) {
const room = roomOf(socket); if (!room) return;
clearInterval(room.interval);
socket.to(room.code).emit('peerLeft', {});
rooms.delete(room.code);
}
httpServer.listen(PORT, () => console.log('C4 Paladins Draft server on ' + PORT));
