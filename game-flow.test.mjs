import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
process.env.CHAOS_ROOM_TEST = '1';
const { handle, rooms, advanceExpired } = await import('../server.mjs');

async function call(path, body) {
  const req = new EventEmitter(); req.url = path; req.method = body === undefined ? 'GET' : 'POST'; req.headers = { host: 'localhost' };
  const response = new EventEmitter(); Object.assign(response, { status: 0, headers: {}, payload: '', writes: [], writeHead(status, headers) { this.status = status; this.headers = headers; }, write(chunk) { this.writes.push(String(chunk)); }, end(payload = '') { this.payload = payload; } });
  const pending = handle(req, response);
  if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  await pending;
  return { status: response.status, data: response.payload ? JSON.parse(response.payload) : null, response };
}
const stateFor = (code, id) => call(`/api/state?code=${code}&id=${id}`);

test('separate player event streams receive live updates from the same room and clean up on disconnect', async () => {
  const made = await call('/api/create', { name: 'Stream host' }), code = made.data.code;
  const players = [{ id: made.data.id, name: 'Stream host' }];
  for (const name of ['Stream two','Stream three','Stream four']) players.push((await call('/api/join',{code,name})).data);
  const first = await call(`/events?code=${code}&pid=${players[0].id}`);
  const second = await call(`/events?code=${code}&pid=${players[1].id}`);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(rooms.get(code).players[0].connected, true);
  await call('/api/start',{code,id:players[0].id});
  const before = [first.response.writes.length,second.response.writes.length];
  await call('/api/team-vote',{code,id:players[0].id,choice:1});
  assert.ok(first.response.writes.length > before[0]);
  assert.ok(second.response.writes.length > before[1]);
  const decode = response => JSON.parse(response.writes.at(-1).split('data: ')[1]);
  const hostView = decode(first.response), friendView = decode(second.response);
  assert.equal(hostView.players[0].voted,true);
  assert.equal(friendView.players[0].voted,true);
  assert.equal(hostView.myTeamVote,1);
  assert.equal(friendView.myTeamVote,null,'each stream keeps private player state scoped to its viewer');
  first.response.emit('close');
  assert.equal(rooms.get(code).players[0].connected,false);
  assert.equal(rooms.get(code).players[1].connected,true);
  second.response.emit('close');
  rooms.delete(code);
});

test('full four-player crew win keeps roles private and reconnects by saved session', async () => {
  const made = await call('/api/create', { name: 'Captain' });
  assert.equal(made.status, 200);
  const code = made.data.code, players = [{ id: made.data.id, name: 'Captain' }];
  for (const name of ['Wrench', 'Noodle', 'Comet']) {
    const joined = await call('/api/join', { code, name }); assert.equal(joined.status, 200);
    players.push({ id: joined.data.id, name });
  }
  assert.equal((await call('/api/start', { code, id: players[0].id })).status, 200);
  assert.equal((await call('/api/join', { code, name: 'Late friend' })).status, 409);
  const roles = await Promise.all(players.map(p => stateFor(code, p.id)));
  assert.equal(roles.filter(x => x.data.state.myRole === 'saboteur').length, 1);
  assert.ok(roles.every(x => x.data.state.players.every(p => !Object.hasOwn(p, 'role'))), 'active room must not expose roles in the public player list');
  const saboteur = players[roles.findIndex(x => x.data.state.myRole === 'saboteur')];
  for (const p of players) await call('/api/team-vote', { code, id: p.id, choice: 0 });
  assert.equal((await call('/api/action', { code, id: players.find(p => p.id !== saboteur.id).id, action: 'sabotage' })).status, 403, 'crew cannot submit a saboteur-only action');
  const reconnect = await stateFor(code, players[1].id);
  assert.ok(['crew', 'saboteur'].includes(reconnect.data.state.myRole), 'saved player session restores its private role');
  for (let round = 0; round < 4; round++) {
    if (round > 0) for (const p of players) assert.equal((await call('/api/team-vote', { code, id: p.id, choice: round % 2 })).status, 200);
    for (const p of players) assert.equal((await call('/api/action', { code, id: p.id, action: 'help' })).status, 200);
    if (round === 1) assert.equal((await call('/api/accuse', { code, id: players[0].id, target: saboteur.id })).status, 400, 'previously accused players cannot be targeted again');
    for (const p of players) {
      const target = round === 0 && p.id !== saboteur.id ? saboteur.id : null;
      assert.equal((await call('/api/accuse', { code, id: p.id, target })).status, 200);
    }
  }
  const finalState = await stateFor(code, players[0].id);
  assert.equal(finalState.data.state.phase, 'results');
  assert.equal(finalState.data.state.result.winner, 'crew');
  assert.equal(finalState.data.state.history.length, 4);
  assert.ok(finalState.data.state.scores.every(p => typeof p.score === 'number'));
  assert.ok(finalState.data.state.scores.filter(p => p.role === 'crew').some(p => p.score >= 8), 'correct crew accusations earn leaderboard points');
  rooms.delete(code);
});

test('phase deadlines auto-submit safe defaults so a disconnected player cannot stall a room', async () => {
  const made = await call('/api/create', { name: 'Timeout tester' }), code = made.data.code;
  const players = [{ id: made.data.id }];
  for (const name of ['One','Two','Three']) players.push((await call('/api/join',{code,name})).data);
  await call('/api/start',{code,id:players[0].id});
  const room = rooms.get(code);
  room.deadline = Date.now()-1;
  assert.equal(advanceExpired(room),true);
  assert.equal(room.phase,'actions');
  assert.equal(Object.keys(room.teamVotes).length,4);
  room.deadline = Date.now()-1;
  assert.equal(advanceExpired(room),true);
  assert.equal(room.phase,'accusation');
  room.deadline = Date.now()-1;
  assert.equal(advanceExpired(room),true);
  assert.equal(room.phase,'crisis');
  assert.equal(room.round,1);
  rooms.delete(code);
});

test('seven-player room assigns two hidden saboteurs and private sabotage can end the game', async () => {
  const made = await call('/api/create', { name: 'Skipper' }), code = made.data.code;
  const players = [{ id: made.data.id, name: 'Skipper' }];
  for (const name of ['A','B','C','D','E','F']) players.push((await call('/api/join', { code, name })).data);
  await call('/api/start', { code, id: players[0].id });
  const states = await Promise.all(players.map(p => stateFor(code, p.id)));
  assert.equal(states.filter(x => x.data.state.myRole === 'saboteur').length, 2);
  assert.ok(states.every(x => x.data.state.players.every(p => !Object.hasOwn(p, 'role'))));
  const pids = players.filter((p,i) => states[i].data.state.myRole === 'saboteur').map(p => p.id);
  for (let round = 0; round < 2; round++) {
    for (const p of players) await call('/api/team-vote', { code, id: p.id, choice: round === 0 ? 1 : 0 });
    for (const p of players) await call('/api/action', { code, id: p.id, action: pids.includes(p.id) ? 'sabotage' : 'hold' });
    if (round === 0) for (const p of players) await call('/api/accuse', { code, id: p.id, target: null });
  }
  const state = await stateFor(code, players[0].id);
  assert.equal(state.data.state.result.winner, 'saboteurs');
  rooms.delete(code);
});
