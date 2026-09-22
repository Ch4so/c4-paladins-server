// C4 Paladins Draft Trainer — online server (Node + Socket.IO)
// Server-authoritative draft. Cross-platform (Windows/iOS/Android/Web all connect here).
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const STEP_MS = 28000, BONUS_MS = 60000, TICK = 250;

// ============================================================================
// C4 Account (Phase 1) — accounts + auth
//   AUTH_VERSION を上げると全トークンが無効化され、再ログインが必要になる。
//   本番では C4_SECRET と MONGODB_URI を Render の環境変数に設定すること。
// ============================================================================
const AUTH_VERSION = '26.9.21';                 // bump on release to force re-login
const SECRET = process.env.C4_SECRET || 'c4-dev-secret-set-C4_SECRET-in-prod';

// ---- storage: MongoDB Atlas if MONGODB_URI set, otherwise in-memory (dev only) ----
let accountsColl = null;
const memAccounts = new Map();                  // usernameLower -> account doc
async function initStore() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.log('[store] in-memory (no MONGODB_URI set — dev only, not persistent)'); return; }
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri);
  await client.connect();
  accountsColl = client.db('c4draft').collection('accounts');
  console.log('[store] MongoDB connected');
}
async function getAccount(key) { return accountsColl ? accountsColl.findOne({ _id: key }) : (memAccounts.get(key) || null); }
async function putAccount(doc) { if (accountsColl) await accountsColl.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true }); else memAccounts.set(doc._id, doc); }

// ---- auth helpers ----
function hashSecret(value, salt) { salt = salt || crypto.randomBytes(16).toString('hex'); const hash = crypto.scryptSync(value, salt, 32).toString('hex'); return { salt, hash }; }
function verifySecret(value, salt, hash) { try { const h = crypto.scryptSync(value, salt, 32).toString('hex'); return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)); } catch (e) { return false; } }
function signToken(username) { const body = Buffer.from(JSON.stringify({ u: username, v: AUTH_VERSION, t: Date.now() })).toString('base64url'); const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url'); return body + '.' + sig; }
function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== exp) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
  if (p.v !== AUTH_VERSION) return null;         // version bumped -> re-login required
  return p.u;
}
// 使用可能: 英字 / 数字 / 日本語(ひらがな・カタカナ・漢字) / ハングル。記号・特殊文字は不可。3〜16文字。
const validUsername = u => typeof u === 'string' && /^[A-Za-z0-9぀-ゟ゠-ヿ一-鿿㐀-䶿가-힣]{3,16}$/.test(u);
const validPassword = p => typeof p === 'string' && /^[A-Za-z0-9]{8,12}$/.test(p);
const genRecovery = () => crypto.randomBytes(6).toString('hex').toUpperCase();   // 12 hex chars

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('C4 Paladins Draft Trainer server is running.');
});
const io = new Server(httpServer, { cors: { origin: '*' } });

/** rooms: code -> { code, password|null, hostId, guestId, champions, maps, format, state, interval, votes } */
const rooms = new Map();

// ============================================================================
// Presence + Friends (Phase 2)
//   online:      usernameKey -> Set<socketId>   (a user may have several tabs)
//   socksByUser: usernameKey -> Set<socket>     (to push events to a user)
// ============================================================================
const online = new Map();
const socksByUser = new Map();
const keyOf = name => String(name || '').toLowerCase();
const isUserOnline = k => { const s = online.get(k); return !!(s && s.size); };
function emitToUser(key, ev, data) { const set = socksByUser.get(key); if (set) for (const s of set) s.emit(ev, data); }
const meAcc = socket => socket.data.username ? getAccount(keyOf(socket.data.username)) : null;
async function markOnline(socket) {
  const u = socket.data.username; if (!u) return;
  const k = keyOf(u), was = isUserOnline(k);
  if (!online.has(k)) online.set(k, new Set()); online.get(k).add(socket.id);
  if (!socksByUser.has(k)) socksByUser.set(k, new Set()); socksByUser.get(k).add(socket);
  if (!was) { const acc = await getAccount(k); if (acc) for (const fk of (acc.friends || [])) emitToUser(fk, 'friendPresence', { username: acc.username, online: true }); }
}
async function markOffline(socket) {
  const u = socket.data.username; if (!u) return;
  const k = keyOf(u);
  const s1 = online.get(k); if (s1) { s1.delete(socket.id); if (!s1.size) online.delete(k); }
  const s2 = socksByUser.get(k); if (s2) { s2.delete(socket); if (!s2.size) socksByUser.delete(k); }
  if (!isUserOnline(k)) { const acc = await getAccount(k); if (acc) for (const fk of (acc.friends || [])) emitToUser(fk, 'friendPresence', { username: acc.username, online: false }); }
}
async function resolveList(keys) {
  const out = [];
  for (const k of keys || []) { const a = await getAccount(k); if (a) out.push({ username: a.username, online: isUserOnline(k) }); }
  return out;
}
async function friendPayload(acc) {
  return { friends: await resolveList(acc.friends), incoming: await resolveList(acc.inReq), outgoing: await resolveList(acc.outReq) };
}
async function doAccept(a, b) {   // a accepts b (b was in a.inReq)
  a.inReq = (a.inReq || []).filter(k => k !== b._id); a.outReq = (a.outReq || []).filter(k => k !== b._id);
  b.outReq = (b.outReq || []).filter(k => k !== a._id); b.inReq = (b.inReq || []).filter(k => k !== a._id);
  if (!(a.friends || []).includes(b._id)) a.friends = [...(a.friends || []), b._id];
  if (!(b.friends || []).includes(a._id)) b.friends = [...(b.friends || []), a._id];
  await putAccount(a); await putAccount(b);
  emitToUser(a._id, 'friendUpdate', {}); emitToUser(b._id, 'friendUpdate', {});
}
function genRoomCode() { const ch = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let c; do { c = ''; for (let i = 0; i < 5; i++) c += ch[Math.floor(Math.random() * ch.length)]; } while (rooms.has(c)); return c; }
const pendingInvites = new Map(); // code -> { from, to }
const inviteGuard = new Map();    // "fromKey>toKey" -> code (blocks invite spam)
function clearInvite(code) { const pi = pendingInvites.get(code); if (pi) { pendingInvites.delete(code); inviteGuard.delete(pi.from + '>' + pi.to); } }

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
const curStep = room => { const s = room.state; return s && s.step >= 0 && s.step < s.seq.length ? s.seq[s.step] : null; };
function taken(room, n) { const s = room.state; return s.bans[1].includes(n) || s.bans[2].includes(n) || s.picks[1].includes(n) || s.picks[2].includes(n); }

function publicState(room) {
  const s = room.state;
  return { format: s.format, seq: s.seq, step: s.step, firstTeam: s.firstTeam,
    picks: s.picks, bans: s.bans, bonus: s.bonus, stepRemaining: s.stepRemaining,
    stepMax: s.stepMax, map: s.map, running: s.running, done: s.done, paused: !!room.paused };
}
const broadcast = room => io.to(room.code).emit('state', publicState(room));
const emitTimer = room => io.to(room.code).emit('timer', { stepRemaining: room.state.stepRemaining, bonus: room.state.bonus });
// Pre-draft lobby: host-chosen config + ready-check, mirrored live to both players.
function lobbyState(room) { return { phase: room.phase, config: room.config, ready: room.ready, code: room.code, players: { 1: !!room.hostId, 2: !!room.guestId }, invited: !!room.invited }; }
const broadcastLobby = room => io.to(room.code).emit('lobby', lobbyState(room));

// Pick a random map, avoiding the immediately-previous one so rematches feel fresh.
function pickMap(maps, prevName) {
  if (!maps.length) return { name: '(no map)', img: '' };
  if (maps.length === 1) return maps[0];
  let m;
  do { m = maps[Math.floor(Math.random() * maps.length)]; } while (prevName && m.name === prevName);
  return m;
}
function startDraft(room) {
  const maps = room.maps || [];
  const prevMap = room.state && room.state.map ? room.state.map.name : null;
  const cfg = room.config || { format: 'ranked', mapMode: 'auto', map: null };
  room.votes = { 1: false, 2: false }; room.paused = false; room.phase = 'draft';
  const map = (cfg.mapMode === 'manual' && cfg.map) ? cfg.map : pickMap(maps, prevMap);
  room.state = {
    format: cfg.format, seq: buildSequence(cfg.format), step: -1,
    firstTeam: Math.random() < 0.5 ? 1 : 2,   // 先攻/後攻は毎回ランダム（50/50）
    picks: { 1: [], 2: [] }, bans: { 1: [], 2: [] },
    bonus: { 1: BONUS_MS, 2: BONUS_MS }, stepRemaining: STEP_MS, stepMax: STEP_MS,
    map, running: true, done: false
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
  room.state.running = false; room.state.done = true; room.phase = 'done'; room.paused = false;
  room.votes = { 1: false, 2: false };
  clearInterval(room.interval); room.interval = null;
  broadcast(room);
}
function roomTick(room) {
  const s = room.state; if (!s || !s.running || s.done || room.paused) return;   // paused: freeze the clock
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
  if (!room.state || !room.state.running || !st || room.paused) return;   // no picks/bans while paused
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
  // ---- C4 Account (Phase 1) ----
  socket.on('signup', async (d, cb) => {
    try {
      const username = String((d && d.username) || '').trim();
      const password = String((d && d.password) || '');
      if (!validUsername(username)) return cb && cb({ ok: false, error: 'err_username_rule' });
      if (!validPassword(password)) return cb && cb({ ok: false, error: 'err_password_rule' });
      const key = username.toLowerCase();
      if (await getAccount(key)) return cb && cb({ ok: false, error: 'err_username_taken' });
      const pw = hashSecret(password), rec = genRecovery(), rh = hashSecret(rec);
      await putAccount({ _id: key, username, pwSalt: pw.salt, pwHash: pw.hash, recSalt: rh.salt, recHash: rh.hash, createdAt: Date.now(), friends: [], outReq: [], inReq: [] });
      socket.data.username = username; markOnline(socket);
      cb && cb({ ok: true, token: signToken(username), username, recovery: rec });
    } catch (e) { cb && cb({ ok: false, error: 'err_server' }); }
  });
  socket.on('login', async (d, cb) => {
    try {
      const username = String((d && d.username) || '').trim(), password = String((d && d.password) || '');
      const acc = await getAccount(username.toLowerCase());
      if (!acc || !verifySecret(password, acc.pwSalt, acc.pwHash)) return cb && cb({ ok: false, error: 'err_login_bad' });
      socket.data.username = acc.username; markOnline(socket);
      cb && cb({ ok: true, token: signToken(acc.username), username: acc.username });
    } catch (e) { cb && cb({ ok: false, error: 'err_server' }); }
  });
  socket.on('auth', (d, cb) => {                 // silent re-login via stored token
    const u = verifyToken(d && d.token);
    if (!u) return cb && cb({ ok: false });
    socket.data.username = u; markOnline(socket);
    cb && cb({ ok: true, username: u });
  });
  socket.on('resetPassword', async (d, cb) => {
    try {
      const username = String((d && d.username) || '').trim(), code = String((d && d.code) || '').trim().toUpperCase(), password = String((d && d.password) || '');
      if (!validPassword(password)) return cb && cb({ ok: false, error: 'err_newpass_rule' });
      const acc = await getAccount(username.toLowerCase());
      if (!acc || !verifySecret(code, acc.recSalt, acc.recHash)) return cb && cb({ ok: false, error: 'err_recover_bad' });
      const pw = hashSecret(password), rec = genRecovery(), rh = hashSecret(rec);
      acc.pwSalt = pw.salt; acc.pwHash = pw.hash; acc.recSalt = rh.salt; acc.recHash = rh.hash;
      await putAccount(acc);
      cb && cb({ ok: true, token: signToken(acc.username), username: acc.username, recovery: rec });
    } catch (e) { cb && cb({ ok: false, error: 'err_server' }); }
  });

  // ---- Friends (Phase 2) ----
  socket.on('friendList', async (cb) => {
    const acc = await meAcc(socket); if (!acc) return cb && cb({ ok: false, error: 'err_not_logged_in' });
    cb && cb({ ok: true, ...(await friendPayload(acc)) });
  });
  socket.on('friendRequest', async (d, cb) => {
    const acc = await meAcc(socket); if (!acc) return cb && cb({ ok: false, error: 'err_not_logged_in' });
    const tKey = keyOf(d && d.username);
    if (!tKey) return cb && cb({ ok: false, error: 'err_user_notfound' });
    if (tKey === acc._id) return cb && cb({ ok: false, error: 'err_friend_self' });
    const target = await getAccount(tKey); if (!target) return cb && cb({ ok: false, error: 'err_user_notfound' });
    if ((acc.friends || []).includes(tKey)) return cb && cb({ ok: false, error: 'err_already_friend' });
    if ((acc.outReq || []).includes(tKey)) return cb && cb({ ok: false, error: 'err_already_sent' });
    if ((acc.inReq || []).includes(tKey)) { await doAccept(acc, target); return cb && cb({ ok: true, accepted: true }); }
    acc.outReq = [...(acc.outReq || []), tKey]; target.inReq = [...(target.inReq || []), acc._id];
    await putAccount(acc); await putAccount(target);
    emitToUser(tKey, 'friendUpdate', {});
    cb && cb({ ok: true });
  });
  socket.on('friendAccept', async (d, cb) => {
    const acc = await meAcc(socket); if (!acc) return cb && cb({ ok: false, error: 'err_not_logged_in' });
    const fKey = keyOf(d && d.username);
    if (!(acc.inReq || []).includes(fKey)) return cb && cb({ ok: false, error: 'err_no_request' });
    const other = await getAccount(fKey); if (!other) return cb && cb({ ok: false, error: 'err_user_notfound' });
    await doAccept(acc, other); cb && cb({ ok: true });
  });
  socket.on('friendReject', async (d, cb) => {
    const acc = await meAcc(socket); if (!acc) return cb && cb({ ok: false, error: 'err_not_logged_in' });
    const fKey = keyOf(d && d.username);
    acc.inReq = (acc.inReq || []).filter(k => k !== fKey);
    const other = await getAccount(fKey); if (other) { other.outReq = (other.outReq || []).filter(k => k !== acc._id); await putAccount(other); emitToUser(fKey, 'friendUpdate', {}); }
    await putAccount(acc); cb && cb({ ok: true });
  });
  socket.on('friendCancel', async (d, cb) => {
    const acc = await meAcc(socket); if (!acc) return cb && cb({ ok: false, error: 'err_not_logged_in' });
    const fKey = keyOf(d && d.username);
    acc.outReq = (acc.outReq || []).filter(k => k !== fKey);
    const other = await getAccount(fKey); if (other) { other.inReq = (other.inReq || []).filter(k => k !== acc._id); await putAccount(other); emitToUser(fKey, 'friendUpdate', {}); }
    await putAccount(acc); cb && cb({ ok: true });
  });
  socket.on('friendRemove', async (d, cb) => {
    const acc = await meAcc(socket); if (!acc) return cb && cb({ ok: false, error: 'err_not_logged_in' });
    const fKey = keyOf(d && d.username);
    acc.friends = (acc.friends || []).filter(k => k !== fKey);
    const other = await getAccount(fKey); if (other) { other.friends = (other.friends || []).filter(k => k !== acc._id); await putAccount(other); emitToUser(fKey, 'friendUpdate', {}); }
    await putAccount(acc); cb && cb({ ok: true });
  });

  // ---- Invite to ONLINE MATCH (Phase 2) ----
  socket.on('invite', async (d, cb) => {
    const acc = await meAcc(socket); if (!acc) return cb && cb({ ok: false, error: 'err_not_logged_in' });
    const tKey = keyOf(d && d.username);
    if (!(acc.friends || []).includes(tKey)) return cb && cb({ ok: false, error: 'err_not_friend' });
    if (!isUserOnline(tKey)) return cb && cb({ ok: false, error: 'err_friend_offline' });
    const gk = acc._id + '>' + tKey;
    if (inviteGuard.has(gk)) return cb && cb({ ok: false, error: 'err_invite_pending' });
    const code = genRoomCode();
    const room = { code, hostId: socket.id, guestId: null,
      champions: (d.champions || []).slice(), maps: (d.maps || []).slice(),
      config: { format: d.format === 'casual' ? 'casual' : 'ranked', mapMode: 'auto', map: null },
      ready: { 1: false, 2: false }, phase: 'lobby', paused: false,
      state: null, interval: null, votes: { 1: false, 2: false }, invited: true };
    rooms.set(code, room); socket.join(code);
    pendingInvites.set(code, { from: acc._id, to: tKey }); inviteGuard.set(gk, code);
    broadcastLobby(room);   // inviter (host) sees the match lobby right away
    const target = await getAccount(tKey);
    emitToUser(tKey, 'inviteReceived', { from: acc.username, code });
    cb && cb({ ok: true, code, myTeam: 1, to: target ? target.username : '' });
    setTimeout(() => {
      const r = rooms.get(code);
      if (pendingInvites.get(code) && r && !r.guestId) {
        clearInvite(code); clearInterval(r.interval); rooms.delete(code);
        emitToUser(acc._id, 'inviteExpired', { username: target ? target.username : '', code });
        emitToUser(tKey, 'inviteCancelled', { code });
      }
    }, 60000);
  });
  socket.on('inviteDecline', async (d, cb) => {
    const acc = await meAcc(socket);
    const code = String((d && d.code) || '').toUpperCase();
    const pi = pendingInvites.get(code);
    if (pi) {
      emitToUser(pi.from, 'inviteDeclined', { username: acc ? acc.username : '', code });
      clearInvite(code);
      const r = rooms.get(code); if (r) { clearInterval(r.interval); rooms.delete(code); }
    }
    cb && cb({ ok: true });
  });

  // Host creates a room -> server generates the code, room waits in the lobby (config + ready-check).
  socket.on('createRoom', (data, cb) => {
    const code = genRoomCode();
    const room = {
      code, hostId: socket.id, guestId: null,
      champions: (data.champions || []).slice(), maps: (data.maps || []).slice(),
      config: { format: data.format === 'casual' ? 'casual' : 'ranked', mapMode: 'auto', map: null },
      ready: { 1: false, 2: false }, phase: 'lobby', paused: false,
      state: null, interval: null, votes: { 1: false, 2: false }
    };
    rooms.set(code, room); socket.join(code);
    cb && cb({ ok: true, code, myTeam: 1 });
    broadcastLobby(room);
  });

  socket.on('joinRoom', (data, cb) => {
    const room = rooms.get(String(data.code || '').toUpperCase());
    if (!room) return cb && cb({ ok: false, error: 'err_room_notfound' });
    if (room.guestId) return cb && cb({ ok: false, error: 'err_room_full' });
    if (room.phase !== 'lobby') return cb && cb({ ok: false, error: 'err_room_full' });
    room.guestId = socket.id; socket.join(room.code);
    clearInvite(room.code);   // if this room came from an invite, resolve it
    room.ready = { 1: false, 2: false };
    cb && cb({ ok: true, code: room.code, myTeam: 2 });
    io.to(room.code).emit('peerJoined', {});
    broadcastLobby(room);     // both in the lobby; ready-check decides when the draft starts
  });

  // Host adjusts the match config (format / map mode / chosen map) in the lobby.
  socket.on('setConfig', data => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    const c = room.config;
    if (data.format === 'casual' || data.format === 'ranked') c.format = data.format;
    if (data.mapMode === 'auto' || data.mapMode === 'manual') c.mapMode = data.mapMode;
    if (c.mapMode === 'auto') c.map = null;
    if (data.map && typeof data.map === 'object' && data.map.name) c.map = { name: String(data.map.name), img: String(data.map.img || '') };
    room.ready = { 1: false, 2: false };   // config changed -> both re-confirm
    broadcastLobby(room);
  });

  // Ready-check. When both players are present and ready, the draft begins.
  socket.on('setReady', data => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby') return;
    const team = room.hostId === socket.id ? 1 : 2;
    if (team === 1 && room.config.mapMode === 'manual' && !room.config.map) { room.ready[1] = false; broadcastLobby(room); return; }
    room.ready[team] = !!(data && data.ready);
    broadcastLobby(room);
    if (room.hostId && room.guestId && room.ready[1] && room.ready[2]) startDraft(room);
  });

  socket.on('action', data => {
    const room = roomOf(socket); if (!room) return;
    applyAction(room, room.hostId === socket.id ? 1 : 2, data.type, data.name);
  });

  // Pause / resume — host only, during a running draft.
  socket.on('pause', () => { const room = roomOf(socket); if (!room || room.hostId !== socket.id || !room.state || !room.state.running || room.state.done) return; room.paused = true; broadcast(room); });
  socket.on('resume', () => { const room = roomOf(socket); if (!room || room.hostId !== socket.id || !room.state || !room.state.running || room.state.done) return; room.paused = false; broadcast(room); });

  // NEXT (rematch) voting after a draft is done
  socket.on('next', () => {
    const room = roomOf(socket); if (!room || !room.state || !room.state.done) return;
    room.votes[room.hostId === socket.id ? 1 : 2] = true;
    io.to(room.code).emit('votes', room.votes);
    if (room.votes[1] && room.votes[2]) {
      if (room.config.mapMode === 'manual') { room.phase = 'mapselect'; room.votes = { 1: false, 2: false }; io.to(room.code).emit('mapselect', {}); }
      else startDraft(room);
    }
  });
  // Manual map mode: host picks the map for the next draft.
  socket.on('chooseMap', data => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id || room.phase !== 'mapselect') return;
    if (data && data.map && data.map.name) room.config.map = { name: String(data.map.name), img: String(data.map.img || '') };
    startDraft(room);
  });

  socket.on('leaveRoom', () => cleanup(socket));
  socket.on('disconnect', () => { cleanup(socket); markOffline(socket); });
});

function cleanup(socket) {
  const room = roomOf(socket); if (!room) return;
  clearInterval(room.interval);
  const pi = pendingInvites.get(room.code);       // inviter left before it was accepted
  if (pi) { emitToUser(pi.to, 'inviteCancelled', { code: room.code }); clearInvite(room.code); }
  socket.to(room.code).emit('peerLeft', {});   // notify the OTHER player only
  rooms.delete(room.code);
}

initStore().catch(e => console.error('[store] init failed:', e.message));
httpServer.listen(PORT, () => console.log(`C4 Paladins Draft server listening on :${PORT}`));
