import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const rooms = new Map();
const names = ['Reactor tantrum', 'Comet in the vents', 'The suspicious smoothie', 'Gravity went sideways'];
const crises = [
  { title: 'Reactor tantrum', icon: '⚛️', story: 'The reactor is coughing sparks. Someone has replaced the manual with a sandwich menu.', choices: ['Reroute the coolant', 'Give the reactor a pep talk'], damage: 2 },
  { title: 'Comet in the vents', icon: '☄️', story: 'A tiny comet is ricocheting through the air vents. The ship now has surprise winter.', choices: ['Seal the vent network', 'Lure it into the cargo bay'], damage: 2 },
  { title: 'The suspicious smoothie', icon: '🥤', story: 'The navigation computer drank a glowing smoothie and insists Mars is “just over there.”', choices: ['Reboot navigation', 'Ask the computer to draw a map'], damage: 2 },
  { title: 'Gravity went sideways', icon: '🪐', story: 'Everyone and one very confused sandwich are stuck to the ceiling.', choices: ['Reset the gravity coils', 'Use the emergency seatbelts'], damage: 3 },
];
const code = () => randomBytes(3).toString('hex').toUpperCase();
const safeName = (s) => String(s ?? '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 18);
const playerById = (room, id) => room.players.find(p => p.id === id);

function publicState(room, viewerId) {
  const me = playerById(room, viewerId);
  return {
    code: room.code, hostId: room.hostId, phase: room.phase, round: room.round,
    systems: room.systems, maxSystems: 8, crisis: room.round < 4 ? crises[room.round] : null,
    secondsLeft: room.deadline ? Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000)) : null,
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, ready: p.ready,
      voted: Boolean(room.teamVotes[p.id]), acted: Boolean(room.actions[p.id]),
      accused: room.accused.includes(p.id), role: room.phase === 'results' ? p.role : undefined })),
    myId: viewerId, myRole: room.phase === 'lobby' ? null : me?.role,
    myTeamVote: room.teamVotes[viewerId] ?? null, myAction: room.actions[viewerId] ?? null,
    myAccusation: room.accusationVotes[viewerId] ?? null,
    accusationEligible: room.players.filter(p => !room.accused.includes(p.id)).map(p => ({ id: p.id, name: p.name })),
    accusationCount: Object.keys(room.accusationVotes).length,
    event: room.event, history: room.history, scores: room.scores,
    result: room.result,
  };
}

function broadcast(room) {
  for (const p of room.players) for (const res of p.streams) {
    res.write(`event: state\ndata: ${JSON.stringify(publicState(room, p.id))}\n\n`);
  }
}

function end(room, winner, reason) {
  room.phase = 'results'; room.result = { winner, reason };
  room.scores = room.players.map(p => ({ id: p.id, name: p.name, role: p.role,
    score: (p.points || 0) + (winner === (p.role === 'saboteur' ? 'saboteurs' : 'crew') ? 5 : 0) }));
  room.deadline = null;
}

const phaseSeconds = { crisis: 45, actions: 20, accusation: 25 };
function setPhase(room, phase) { room.phase = phase; room.deadline = phaseSeconds[phase] ? Date.now() + phaseSeconds[phase] * 1000 : null; }

function tally(values, fallback = 0) {
  const counts = values.reduce((a, x) => { a[x] = (a[x] || 0) + 1; return a; }, {});
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter(k => counts[k] === max);
  return max === 0 || top.length !== 1 ? fallback : Number(top[0]);
}

function resolveCrisis(room) {
  const crisis = crises[room.round];
  const supported = Object.values(room.actions).filter(a => a === 'help').length;
  const sabotages = Object.entries(room.actions).filter(([id, a]) => a === 'sabotage' && playerById(room, id)?.role === 'saboteur').length;
  room.players.forEach(p => {
    const action = room.actions[p.id];
    if (p.role === 'saboteur' && action === 'sabotage') { room.badSabotages[p.id] = (room.badSabotages[p.id] || 0) + 1; p.points = (p.points || 0) + 2; }
    else if (action === 'help') p.points = (p.points || 0) + 1;
  });
  const teamChoice = tally(Object.values(room.teamVotes), 0);
  const responseBonus = teamChoice === (room.round % 2) ? 1 : 0;
  // Each two crew helpers repair one point. Sabotage removes an extra point, up to the crisis severity.
  const repairs = Math.floor(supported / 2) + responseBonus;
  const loss = Math.max(1, crisis.damage - repairs + Math.min(2, sabotages));
  room.systems = Math.max(0, room.systems - loss);
  room.event = { title: crisis.title, icon: crisis.icon, teamChoice, supported, repairs, loss, sabotages };
  room.history.push({ round: room.round + 1, ...room.event, systems: room.systems });
  setPhase(room, 'accusation'); room.accusationVotes = {};
  if (room.systems <= 0) end(room, 'saboteurs', 'The ship systems failed before the crew could stabilize them.');
}

function resolveAccusation(room) {
  const votes = Object.values(room.accusationVotes).filter(id => room.players.some(p => p.id === id && !room.accused.includes(id)));
  const counts = votes.reduce((a, id) => (a[id] = (a[id] || 0) + 1, a), {});
  const max = Math.max(0, ...Object.values(counts));
  const targets = Object.keys(counts).filter(id => counts[id] === max);
  const target = max && targets.length === 1 ? playerById(room, targets[0]) : null;
  if (target) {
    room.accused.push(target.id);
    if (target.role === 'saboteur') {
      room.systems = Math.min(8, room.systems + 1); room.goodAccusations = (room.goodAccusations || 0) + 1;
      for (const [id, vote] of Object.entries(room.accusationVotes)) if (vote === target.id && playerById(room,id)?.role === 'crew') playerById(room,id).points = (playerById(room,id).points || 0) + 2;
    }
    else room.systems = Math.max(0, room.systems - 1);
  }
  room.event = { ...room.event, accusation: target ? { name: target.name, correct: target.role === 'saboteur' } : { name: null, correct: null } };
  room.history[room.history.length - 1].accusation = room.event.accusation;
  if (room.systems <= 0) end(room, 'saboteurs', 'A wrong accusation drained the last system point.');
  else if (room.accused.length === room.players.filter(p => p.role === 'crew').length) end(room, 'saboteurs', 'The saboteurs avoided detection until the crew ran out of suspects.');
  else if (room.round === 3) end(room, 'crew', 'Four crises survived! The ship is still flying.');
  else {
    room.round += 1; setPhase(room, 'crisis'); room.teamVotes = {}; room.actions = {}; room.accusationVotes = {};
    room.event = null;
  }
}

function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') {
    try { const html = await readFile(path.join(ROOT, 'public', 'index.html')); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); }
    catch { res.writeHead(500); res.end('Game UI is missing.'); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') return respond(res, 200, { ok: true, rooms: rooms.size });
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const room = rooms.get((url.searchParams.get('code') || '').toUpperCase()), id = url.searchParams.get('id');
    if (!room || !playerById(room, id)) return respond(res, 404, { error: 'That room session was not found.' });
    return respond(res, 200, { state: publicState(room, id) });
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    const room = rooms.get((url.searchParams.get('code') || '').toUpperCase()), pid = url.searchParams.get('pid');
    const player = room && playerById(room, pid);
    if (!player) return respond(res, 404, { error: 'That room or player session was not found.' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(publicState(room, pid))}\n\n`);
    player.streams.add(res); player.connected = true; broadcast(room);
    // For SSE, the request completes immediately; track the lifetime of the response stream instead.
    res.on('close', () => { player.streams.delete(res); player.connected = player.streams.size > 0; broadcast(room); });
    return;
  }
  if (req.method !== 'POST') return respond(res, 404, { error: 'Not found' });
  let body = {};
  try { body = await new Promise((resolve, reject) => { let raw=''; req.on('data', c => { raw += c; if(raw.length > 6000) reject(new Error('Request too large')); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } }); }); }
  catch { return respond(res, 400, { error: 'Invalid request.' }); }
  if (url.pathname === '/api/create') {
    const name = safeName(body.name);
    if (!name) return respond(res, 400, { error: 'Enter a name first.' });
    let roomCode; do { roomCode = code(); } while (rooms.has(roomCode));
    const id = randomUUID();
    const room = { code: roomCode, hostId: id, phase: 'lobby', round: 0, systems: 8, deadline: null, players: [{ id, name, role: null, connected: true, ready: true, points: 0, streams: new Set() }], teamVotes: {}, actions: {}, accusationVotes: {}, accused: [], history: [], event: null, scores: [], result: null };
    room.goodAccusations = 0; room.badSabotages = {};
    rooms.set(roomCode, room); return respond(res, 200, { code: roomCode, id, state: publicState(room, id) });
  }
  if (url.pathname === '/api/join') {
    const room = rooms.get(String(body.code || '').toUpperCase()), name = safeName(body.name);
    if (!room) return respond(res, 404, { error: 'Room code not found. Check the code and try again.' });
    if (room.phase !== 'lobby') return respond(res, 409, { error: 'This game has already started.' });
    if (!name) return respond(res, 400, { error: 'Enter a name first.' });
    if (room.players.length >= 8) return respond(res, 409, { error: 'This room is full (8 players max).' });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return respond(res, 409, { error: 'That name is already in this room.' });
    const id = randomUUID(); room.players.push({ id, name, role: null, connected: false, ready: true, points: 0, streams: new Set() });
    broadcast(room); return respond(res, 200, { code: room.code, id, state: publicState(room, id) });
  }
  const room = rooms.get(String(body.code || '').toUpperCase());
  const player = room && playerById(room, body.id);
  if (!room || !player) return respond(res, 404, { error: 'Your room session expired. Rejoin with the room code.' });
  if (url.pathname === '/api/start') {
    if (player.id !== room.hostId) return respond(res, 403, { error: 'Only the host can start the game.' });
    if (room.phase !== 'lobby') return respond(res, 409, { error: 'The game has already started.' });
    if (room.players.length < 4) return respond(res, 409, { error: 'At least 4 players are needed.' });
    const roles = [...Array(room.players.length >= 7 ? 2 : 1).fill('saboteur'), ...Array(room.players.length - (room.players.length >= 7 ? 2 : 1)).fill('crew')];
    for (let i = roles.length - 1; i > 0; i--) { const j = randomInt(i + 1); [roles[i], roles[j]] = [roles[j], roles[i]]; }
    room.players.forEach((p, i) => { p.role = roles[i]; }); room.round = 0; setPhase(room, 'crisis');
    broadcast(room); return respond(res, 200, { state: publicState(room, player.id) });
  }
  if (url.pathname === '/api/team-vote') {
    if (room.phase !== 'crisis') return respond(res, 409, { error: 'Team voting is closed.' });
    if (![0,1].includes(body.choice)) return respond(res, 400, { error: 'Pick one of the response options.' });
    room.teamVotes[player.id] = body.choice;
    if (Object.keys(room.teamVotes).length === room.players.length) setPhase(room, 'actions');
  } else if (url.pathname === '/api/action') {
    if (room.phase !== 'actions') return respond(res, 409, { error: 'Private actions are not open.' });
    if (!['help','hold','sabotage'].includes(body.action)) return respond(res, 400, { error: 'Choose a valid private action.' });
    if (body.action === 'sabotage' && player.role !== 'saboteur') return respond(res, 403, { error: 'That action is not available to your role.' });
    if (body.action === 'hold' && player.role === 'saboteur') return respond(res, 403, { error: 'Saboteurs can help or sabotage.' });
    room.actions[player.id] = body.action;
    if (Object.keys(room.actions).length === room.players.length) resolveCrisis(room);
  } else if (url.pathname === '/api/accuse') {
    if (room.phase !== 'accusation') return respond(res, 409, { error: 'Accusations are not open.' });
    if (room.accusationVotes[player.id]) return respond(res, 409, { error: 'You already voted.' });
    if (body.target && (!room.players.some(p => p.id === body.target) || room.accused.includes(body.target))) return respond(res, 400, { error: 'That player is not an eligible suspect.' });
    room.accusationVotes[player.id] = body.target || 'skip';
    if (Object.keys(room.accusationVotes).length === room.players.length) resolveAccusation(room);
  } else return respond(res, 404, { error: 'Not found' });
  broadcast(room); return respond(res, 200, { state: publicState(room, player.id) });
}

const server = http.createServer((req, res) => { handle(req, res).catch(() => respond(res, 500, { error: 'The game hit a snag. Please try again.' })); });
function advanceExpired(room) {
  if (!room.deadline || Date.now() < room.deadline || room.phase === 'results' || room.phase === 'lobby') return false;
  if (room.phase === 'crisis') {
    room.players.forEach(p => { if (!(p.id in room.teamVotes)) room.teamVotes[p.id] = 0; });
    setPhase(room, 'actions');
  } else if (room.phase === 'actions') {
    room.players.forEach(p => { if (!(p.id in room.actions)) room.actions[p.id] = 'help'; });
    resolveCrisis(room);
  } else if (room.phase === 'accusation') {
    room.players.forEach(p => { if (!(p.id in room.accusationVotes)) room.accusationVotes[p.id] = 'skip'; });
    resolveAccusation(room);
  }
  return true;
}
const timer = setInterval(() => { for (const room of rooms.values()) { const changed = advanceExpired(room); if (changed || room.phase !== 'lobby') broadcast(room); } }, 1000);
timer.unref();
if (process.env.CHAOS_ROOM_TEST !== '1') server.listen(PORT, '0.0.0.0', () => console.log(`CHAOS ROOM running at http://localhost:${PORT}`));

export { server, rooms, crises, publicState, resolveCrisis, resolveAccusation, end, handle, advanceExpired };
