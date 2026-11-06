// 반별로 따로 진행 / 두 반 합치기 / 보기 전용 / 동시에 저장해도 유실 없음 검증 (노트북 서버·Netlify 함수 모두 이 파일을 사용)
const assert = require('assert');

async function runPools(base, { password = 'testpw' }) {
  async function call(p, body, tok) {
    const r = await fetch(base + p, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || '') },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  const tok = {};
  for (const sc of ['find', 'kku']) tok[sc] = (await call('/api/admin/login', { password, scope: sc })).body.token;
  const A = async (sc, a) => { const r = await call('/api/admin/action', a, tok[sc]); if (r.status !== 200) throw new Error(`${sc} ${a.type}: ${r.body.error}`); return r.body; };
  const E = async (sc, a) => { const r = await call('/api/admin/action', a, tok[sc]); assert.notStrictEqual(r.status, 200, `${sc} ${a.type} 는 거부돼야 함`); return r.body.error; };
  const St = async (sc) => (await call('/api/admin/state', null, tok[sc])).body;

  const mk = (pre, n) => Array.from({ length: n }, (_, i) => `${pre}${i + 1}, ${2007 + (i % 3)}-0${1 + (i % 9)}-1${i % 9}, 2024-03`).join('\n');
  await A('find', { type: 'importPeople', pool: 'find', text: mk('찾', 12) });
  await A('kku', { type: 'importPeople', pool: 'kku', text: mk('꾸', 9) });
  const sf = await St('find'), sk = await St('kku');
  assert(sf.participants.length === 12 && sf.participants.every((p) => p.pool === 'find'), '찾여 화면에는 찾여 사람만');
  assert(sk.participants.length === 9 && sk.participants.every((p) => p.pool === 'kku'), '꾸 화면에는 꾸 사람만');
  assert(/다른 반|내 반/.test(await E('find', { type: 'importPeople', pool: 'kku', text: '침입자' })), '남의 반 명단은 못 건드림');
  assert(/다른 반/.test(await E('kku', { type: 'removePerson', pid: sf.participants[0].id })), '남의 반 사람 삭제 불가');
  assert(/다른 반/.test(await E('kku', { type: 'setPresent', pid: sf.participants[0].id, present: false })));
  const tokens = {};
  for (const p of [...sf.participants, ...sk.participants]) tokens[p.id] = (await call('/api/login', { name: p.name, pin: p.pin })).body.token;
  const people = { find: sf.participants, kku: sk.participants };
  const chips = ['green', 'green', 'red', 'blue', 'white'];
  const submitAll = async (sc, f) => { for (const p of people[sc]) { const r = await call('/api/submit', { chips: f(p), bonus: 0 }, tokens[p.id]); assert.strictEqual(r.status, 200, sc + ' ' + p.id + ' submit: ' + JSON.stringify(r.body)); } };
  const varied = (p) => (Number(p.id.split('-')[1]) % 3 === 0 ? ['yellow', 'yellow', 'yellow', 'yellow', 'yellow'] : Number(p.id.split('-')[1]) % 3 === 1 ? chips : ['white']);
  console.log('OK 반 구분: 진행자 화면에는 내 반만 보이고, 다른 반 사람·명단은 건드릴 수 없음');

  // 찾여만 먼저 라운드 1을 연다: 꾸는 아무 영향 없음
  await A('find', { type: 'open' });
  assert((await call('/api/me', null, tokens[people.find[0].id])).body.open === true);
  assert((await call('/api/me', null, tokens[people.kku[0].id])).body.open === false, '꾸는반 참가자는 아직 집계 전');
  assert.strictEqual((await call('/api/submit', { chips: ['red'] }, tokens[people.kku[0].id])).status, 409, '꾸는반은 제출 불가');
  assert.strictEqual((await St('kku')).open, false);
  await submitAll('find', varied);
  assert.strictEqual(Object.keys((await St('find')).submissions).length, 12);
  assert.strictEqual(Object.keys((await St('kku')).submissions).length, 0, '꾸 화면에는 찾여 제출이 안 보임');
  await A('find', { type: 'close' });
  let f = await St('find'), k = await St('kku');
  assert(f.round === 1 && f.history.length === 1 && k.round === 0 && k.history.length === 0, '찾여만 1라운드');
  assert(k.participants.every((p) => p.rank === null), '꾸는반 순위는 그대로');
  console.log('OK 반별 독립 진행: 찾여가 1라운드를 마쳐도 꾸는반은 집계 전');

  // 꾸는반은 2라운드까지 진행 (되돌리기도 내 반만)
  for (let r = 0; r < 2; r++) { await A('kku', { type: 'open' }); await submitAll('kku', varied); await A('kku', { type: 'close' }); }
  k = await St('kku'); f = await St('find');
  assert(k.round === 2 && k.history.length === 2 && f.round === 1 && f.history.length === 1);
  await A('kku', { type: 'undo' });
  assert((await St('kku')).open === true && (await St('kku')).history.length === 1 && (await St('find')).history.length === 1, '꾸 되돌리기는 찾여에 영향 없음');
  await A('kku', { type: 'close' });
  assert((await call('/api/me', null, tokens[people.find[0].id])).body.round === 1);
  assert((await call('/api/me', null, tokens[people.kku[0].id])).body.round === 2);
  console.log('OK 꾸는반은 2라운드, 찾여는 1라운드 (되돌리기도 반별)');

  // 두 진행자가 같은 순간에 마감/시작을 눌러도 둘 다 반영된다 (저장 충돌 시 자동 재시도)
  for (let i = 0; i < 4; i++) {
    await Promise.all([A('find', { type: 'open' }), A('kku', { type: 'open' })]);
    await Promise.all([submitAll('find', varied), submitAll('kku', varied)]);
    const before = [(await St('find')).history.length, (await St('kku')).history.length];
    await Promise.all([A('find', { type: 'close' }), A('kku', { type: 'close' })]);
    f = await St('find'); k = await St('kku');
    assert(f.open === false && k.open === false, '둘 다 마감돼야 함');
    assert.deepStrictEqual([f.history.length, k.history.length], [before[0] + 1, before[1] + 1], '기록이 하나도 사라지지 않아야 함');
    assert(f.participants.every((p) => p.rank !== null) && k.participants.every((p) => p.rank !== null));
  }
  console.log('OK 동시 마감 4회: 두 진행자의 작업이 서로 덮어쓰지 않음');
  const rf = f.round, rk = k.round;

  // 합치기: 집계 중이면 불가 / 한쪽만 누르면 대기 / 취소 / 둘 다 누르면 통합
  await A('kku', { type: 'open' });
  assert(/마감/.test(await E('kku', { type: 'setMergeReady', ready: true })));
  await A('kku', { type: 'close' });
  await A('find', { type: 'setMergeReady', ready: true });
  assert((await St('kku')).merge.other.ready === true);
  assert(/합치기/.test(await E('find', { type: 'open' })), '합치기를 누른 반은 집계 시작 불가');
  assert(/합치기/.test(await E('find', { type: 'undo' })));
  await A('find', { type: 'setMergeReady', ready: false });
  await A('find', { type: 'open' }); await A('find', { type: 'close' }); // 취소하면 다시 진행 가능
  await A('find', { type: 'setMergeReady', ready: true });
  assert((await St('find')).merge.done === false, '한쪽만 눌러서는 합쳐지지 않음');
  const roundMax = Math.max((await St('find')).round, (await St('kku')).round);
  await A('kku', { type: 'setMergeReady', ready: true });
  f = await St('find'); k = await St('kku');
  assert(f.merge.done && k.merge.done && f.settings.merged);
  assert(!f.readOnly && k.readOnly, '꾸 화면은 보기 전용');
  assert(f.participants.length === 21 && k.participants.length === 21, '두 화면 모두 전체를 보여줌');
  assert.strictEqual(f.round, roundMax, '라운드 번호 이어짐');
  assert(/보기 전용/.test(await E('kku', { type: 'open' })));
  assert(/보기 전용/.test(await E('kku', { type: 'saveSettings', patch: { maxChips: 4 } })));
  assert.strictEqual((await call('/api/me', null, tokens[people.kku[0].id])).body.round, roundMax, '꾸 참가자도 통합 라운드를 따라감');
  console.log('OK 합치기: 양쪽이 눌러야 통합, 꾸는반은 보기 전용, 라운드 번호 이어짐');

  // 통합 첫 라운드: 순위는 전체 기준이고 순위 변화는 표시하지 않음, 둘째 라운드부터 표시
  await A('find', { type: 'open' });
  for (const p of [...people.find, ...people.kku]) assert.strictEqual((await call('/api/submit', { chips: varied(p), bonus: 0 }, tokens[p.id])).status, 200);
  await A('find', { type: 'close' });
  f = await St('find');
  assert.strictEqual(f.round, roundMax + 1);
  assert(f.participants.every((p) => p.groupSize === 21), '순위는 21명 전체 기준');
  assert(f.participants.every((p) => p.prevRank === null), '통합 첫 집계에는 순위 변화를 표시하지 않음');
  const ent = f.history[f.history.length - 1];
  assert(ent.group === 'all' && ent.round === roundMax + 1);
  assert(f.history.some((h) => h.group === 'find') && f.history.some((h) => h.group === 'kku'), '통합 화면에서도 통합 전 기록이 보임');
  await A('find', { type: 'open' });
  for (const p of [...people.find, ...people.kku]) await call('/api/submit', { chips: p.id.endsWith('1') ? ['yellow', 'yellow', 'yellow', 'yellow', 'yellow'] : varied(p), bonus: 0 }, tokens[p.id]);
  f = await A('find', { type: 'close' });
  assert(f.participants.some((p) => p.prevRank !== null), '둘째 통합 집계부터 순위 변화 표시');
  // 통합 직후 되돌리기: 통합 전 기록은 건드리지 않음
  f = await A('find', { type: 'undo' });
  await A('find', { type: 'close' });
  console.log('OK 통합 후 진행: 전체 순위, 첫 통합 집계는 순위 변화 없음, 되돌리기 정상');

  // 종료: 통합 후 종료하면 전체 기준 최종 결과, 사람별 이동 기록은 통합 전 라운드 번호와 이어짐
  f = await A('find', { type: 'endGame' });
  assert(f.ended);
  assert((await St('kku')).ended, '꾸 화면에도 종료 표시');
  const mf = (await call('/api/me', null, tokens[people.find[0].id])).body, mkk = (await call('/api/me', null, tokens[people.kku[0].id])).body;
  assert(mf.ended && mf.final && mkk.ended && mkk.final);
  const rounds = (m) => m.final.journey.map((e) => e.r);
  assert.deepStrictEqual(rounds(mf)[0], 0);
  assert(rounds(mf).includes(rf) && rounds(mkk).includes(rk), '자기 반의 통합 전 라운드가 기록에 있음');
  assert(rounds(mf).includes(roundMax + 1) && rounds(mkk).includes(roundMax + 1), '통합 후 라운드가 기록에 있음');
  assert.strictEqual(mf.final.groupSize, 21);
  await A('find', { type: 'reopenGame' });
  console.log('OK 통합 후 종료: 전체 기준 최종 결과와 라운드별 이동 기록');

  // 초기화: 꾸 화면은 전체 초기화 불가, 찾여 화면에서만 가능 (통합도 풀림)
  assert(/보기 전용|찾는·여는반/.test(await E('kku', { type: 'resetAll' })));
  f = await A('find', { type: 'resetGame' });
  assert(!f.settings.merged && f.round === 0 && f.history.length === 0, '게임 초기화로 통합이 풀림');
  assert((await St('kku')).participants.length === 9 && !(await St('kku')).readOnly, '꾸 화면이 다시 내 반 화면으로');
  await A('find', { type: 'resetAll' });
  assert.strictEqual((await St('find')).participants.length, 0);
  console.log('OK 초기화: 통합 해제, 전체 초기화는 찾여 화면에서만');
}

module.exports = { runPools };
