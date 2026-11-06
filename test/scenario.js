// 서버 종류와 상관없이 같은 시나리오로 검증한다 (노트북 서버 / Netlify 함수 모두 이 파일을 사용)
const assert = require('assert');
const SP = require('../public/shared.js');

function rnd(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
const keys = ['yellow', 'green', 'red', 'blue', 'white'];

async function run(base, { password = 'testpw', push }) {
  const rand = rnd(7);
  const randChips = (n = 5) => Array.from({ length: n }, () => keys[Math.floor(rand() * 5)]);
  const adminTok = {};
  async function call(p, body, tok, method) {
    const r = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || '') },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  // 진행자는 반마다 따로 로그인한다. 아래 도우미는 '두 반 모두에게 같은 동작'을 편하게 하기 위한 것이다.
  let mergedNow = false; // 두 반이 합쳐진 뒤에는 찾는·여는반 진행자 화면 하나로 진행
  const act1 = async (a, scope) => { const r = await call('/api/admin/action', a, adminTok[scope]); if (r.status !== 200) throw new Error(a.type + ': ' + r.body.error); return r.body; };
  const state1 = async (scope) => (await call('/api/admin/state', null, adminTok[scope])).body;
  const combine = (f, k) => Object.assign({}, f, {
    participants: [...f.participants, ...k.participants], submissions: { ...f.submissions, ...k.submissions }, bonus: { ...f.bonus, ...k.bonus },
    labels: { ...f.labels, ...k.labels }, history: [...f.history, ...k.history].sort((x, y) => x.id - y.id), open: f.open && k.open,
  });
  const state = async () => (mergedNow ? state1('find') : combine(await state1('find'), await state1('kku')));
  const scopeOf = (a) => (a.pool ? a.pool : a.pid ? String(a.pid).split('-')[0] : null);
  const A = async (a) => {
    const sc = scopeOf(a);
    if (mergedNow) await act1(a, 'find');
    else if (sc) await act1(a, sc);
    else if (['saveSettings', 'setPassword', 'resetScoreTable'].includes(a.type)) await act1(a, 'find'); // 공유 설정은 한 번만
    else { await act1(a, 'find'); await act1(a, 'kku'); }
    return state();
  };
  const AErr = async (a) => {
    const sc = mergedNow ? 'find' : scopeOf(a) || 'find';
    const r = await call('/api/admin/action', a, adminTok[sc]); assert.notStrictEqual(r.status, 200, a.type + ' should fail'); return r.body.error;
  };

  // 로그인
  assert.strictEqual((await call('/api/admin/login', { password: 'nope' })).status, 401);
  assert.strictEqual((await call('/api/me', null, 'garbage.token')).status, 401);
  assert.strictEqual((await call('/api/admin/login', { password, scope: 'find' })).body.scope, 'find');
  adminTok.find = (await call('/api/admin/login', { password, scope: 'find' })).body.token;
  adminTok.kku = (await call('/api/admin/login', { password, scope: 'kku' })).body.token;
  let S = await state();
  assert.strictEqual(S.push, push, 'push 모드 안내');
  assert.strictEqual((await state1('kku')).scope, 'kku');
  assert.strictEqual(S.participants.length, 0, '명단은 비어 있는 상태로 시작');
  console.log('OK 초기 상태: 빈 명단 (계급은 출석한 사람 기준으로 자동 배정)');

  // 명단 입력 -> 나이순 자동 배정 (찾는·여는 4/14/나머지, 꾸는 3/10/나머지)
  const mk = (pre, n) => Array.from({ length: n }, (_, i) => `${pre}${i + 1}, ${2007 + (i % 3)}-0${1 + (i % 9)}-1${i % 9}, 2024-0${3 + (i % 2) * 6}`).join('\n');
  await A({ type: 'importPeople', pool: 'find', text: mk('찾', 34) });
  S = await A({ type: 'importPeople', pool: 'kku', text: mk('꾸', 26) });
  assert.strictEqual(S.participants.filter((p) => p.name).length, 60);
  const tcount = (pool, t) => S.participants.filter((p) => p.pool === pool && p.present !== false && p.t0 === t).length;
  assert.deepStrictEqual([0, 1, 2].map((t) => tcount('find', t)), [4, 14, 16]);
  assert.deepStrictEqual([0, 1, 2].map((t) => tcount('kku', t)), [3, 10, 13]);
  const keyOf = (p) => SP.dateKey(p.birth) * 1000000 + SP.dateKey(p.enroll);
  for (const pool of ['find', 'kku']) {
    const g = S.participants.filter((p) => p.pool === pool);
    for (const a of g) for (const b of g) if (a.t0 < b.t0) assert(keyOf(a) <= keyOf(b), '나이 많은 사람이 더 높은 계급이어야 함');
  }
  S = await A({ type: 'importPeople', pool: 'find', text: mk('찾', 34) }); // 같은 명단을 또 붙여넣어도 중복 추가 안 됨
  assert.strictEqual(S.participants.length, 60);
  console.log('OK 명단 입력 -> 나이순 초기 계급 자동 배정 (찾여 4/14/16, 꾸 3/10/13), 중복 입력 무시');

  // 출석 체크: 네모 2명이 결석해도 네모·세모 인원은 유지되고 동그라미만 줄어든다
  const topFind = S.participants.filter((p) => p.pool === 'find' && p.t0 === 0).slice(0, 2);
  for (const p of topFind) S = await A({ type: 'setPresent', pid: p.id, present: false });
  assert.deepStrictEqual([0, 1, 2].map((t) => tcount('find', t)), [4, 14, 14]);
  // 결석자는 로그인할 수 없다
  assert.strictEqual((await call('/api/login', { name: topFind[0].name, pin: topFind[0].pin })).status, 401);
  // 현장에서 추가하면 (나이가 가장 어린 사람이면) 동그라미가 늘어난다
  S = await A({ type: 'addPerson', pool: 'find', name: '신입', birth: '2012-01-01', enroll: '2026-03' });
  assert.deepStrictEqual([0, 1, 2].map((t) => tcount('find', t)), [4, 14, 15]);
  S = await A({ type: 'removePerson', pid: S.participants.find((p) => p.name === '신입').id });
  for (const p of topFind) S = await A({ type: 'setPresent', pid: p.id, present: true });
  assert.deepStrictEqual([0, 1, 2].map((t) => tcount('find', t)), [4, 14, 16]);
  console.log('OK 출석 체크: 결석해도 네모·세모 인원 유지, 추가/삭제/출석 복귀');

  // 참가자 로그인 (동시에 60명)
  const peopleAll = S.participants.filter((p) => p.name);
  const tokens = {};
  await Promise.all(peopleAll.map(async (p) => {
    const r = await call('/api/login', { name: p.name, pin: p.pin });
    assert.strictEqual(r.status, 200, p.name); tokens[p.id] = r.body.token;
  }));
  const bad = await call('/api/login', { name: peopleAll[0].name, pin: peopleAll[0].pin === '00' ? '01' : '00' });
  assert.strictEqual(bad.status, 401);
  // 타 참가자 토큰으로 관리자 API 접근 불가
  assert.strictEqual((await call('/api/admin/state', null, tokens[peopleAll[0].id])).status, 401);
  console.log('OK 이름+PIN 로그인 60명 (동시), 참가자 토큰으로 관리자 접근 차단');

  // 로그인 실패 제한
  const victim = peopleAll[1];
  let locked = false;
  for (let i = 0; i < 12 && !locked; i++) {
    const wrong = String((Number(victim.pin) + 1 + i) % 100).padStart(2, '0');
    const r = await call('/api/login', { name: victim.name, pin: wrong });
    if (r.status === 429) locked = true;
  }
  assert(locked, '반복 실패하면 잠시 막혀야 함');
  console.log('OK 로그인 반복 실패 시 잠금');

  // 닫혀 있을 때 제출 불가
  assert.strictEqual((await call('/api/submit', { chips: ['red'] }, tokens[peopleAll[0].id])).status, 409);

  // 라운드 1: 58명이 동시에 제출 (2명 미제출), 보너스
  await A({ type: 'open' });
  const expectedBase = {};
  const submitters = peopleAll.slice(0, 58);
  const chipsFor = Object.fromEntries(submitters.map((p) => [p.id, randChips(5)]));
  chipsFor[peopleAll[0].id] = ['yellow', 'yellow', 'yellow', 'yellow', 'yellow'];
  const results = await Promise.all(submitters.map((p) => call('/api/submit', { chips: chipsFor[p.id] }, tokens[p.id])));
  results.forEach((r) => assert.strictEqual(r.status, 200));
  for (const p of submitters) expectedBase[p.id] = SP.calcScore(chipsFor[p.id], SP.DEFAULT_TABLE).total;
  S = await state();
  assert.strictEqual(Object.keys(S.submissions).length, 58, '동시 제출 58건 모두 저장돼야 함');
  console.log('OK 58명 동시 제출 -> 유실 없이 모두 저장');
  assert.strictEqual((await call('/api/submit', { chips: randChips(6) }, tokens[peopleAll[0].id])).status, 400, '6개는 거부');
  assert.strictEqual((await call('/api/submit', { chips: ['purple'] }, tokens[peopleAll[0].id])).status, 400);
  // 본인 제출 내용 조회 / 수정 재제출
  const mine = (await call('/api/me', null, tokens[peopleAll[2].id])).body;
  assert.deepStrictEqual(mine.submission.chips, chipsFor[peopleAll[2].id]);
  const redo = ['yellow', 'yellow', 'yellow', 'yellow', 'yellow'];
  await call('/api/submit', { chips: redo }, tokens[peopleAll[3].id]); expectedBase[peopleAll[3].id] = 40;
  await A({ type: 'setBonus', pid: peopleAll[5].id, n: 2 });
  S = await A({ type: 'close' });
  assert.strictEqual(S.open, false); assert.strictEqual(S.history.length, 2, '반마다 기록이 하나씩');

  const byId = Object.fromEntries(S.participants.map((p) => [p.id, p]));
  for (const id of Object.keys(expectedBase)) {
    const p = byId[id];
    assert.strictEqual(p.base, expectedBase[id], id);
    assert.strictEqual(p.score, expectedBase[id] + (id === peopleAll[5].id ? 6 : 0));
  }
  const countTier = (pool, t) => S.participants.filter((p) => p.pool === pool && p.name && p.cls === t).length;
  // 점수가 높은 사람이 더 낮은 계급에 있으면 안 되고, 같은 점수는 공동 순위. 동점이 경계에 걸리면 인원이 정원과 다를 수 있다.
  for (const pool of ['find', 'kku']) {
    const grp = S.participants.filter((p) => p.pool === pool && p.name);
    for (const a of grp) for (const b of grp) {
      if (a.score > b.score) assert(a.cls <= b.cls && a.rank < b.rank, '점수 순서와 계급/순위가 어긋남');
      if (a.score === b.score) assert.strictEqual(a.rank, b.rank, '동점은 공동 순위');
    }
    assert.strictEqual([0, 1, 2].reduce((n, t) => n + countTier(pool, t), 0), grp.length);
  }
  const findSorted = S.participants.filter((p) => p.pool === 'find').sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < findSorted.length; i++) assert(findSorted[i - 1].score >= findSorted[i].score);
  assert.strictEqual(S.history.reduce((a, h) => a + h.summary.missing, 0), 2);
  assert.deepStrictEqual(S.submissions, {}, '마감하면 제출 목록이 비워짐');
  console.log('OK 라운드1 마감: 점수 계산·보너스·계급 인원·순위·미제출 처리', JSON.stringify(S.history[0].summary));

  // 참가자 화면 데이터
  const me = (await call('/api/me', null, tokens[peopleAll[3].id])).body;
  assert.strictEqual(me.round, 1); assert.strictEqual(me.me.hasResult, true); assert.strictEqual(me.push, push);
  assert(me.me.rank >= 1 && me.me.groupSize > 0);
  assert.strictEqual(me.submission, null, '마감 후에는 제출 입력 상태가 아님');
  assert(!JSON.stringify(me).includes('"pin"'), '다른 정보 노출 없음');

  // 되돌리기
  S = await A({ type: 'undo' });
  assert.strictEqual(S.open, true); assert.strictEqual(S.history.length, 0);
  assert(S.participants.filter((p) => p.name).every((p) => p.rank === null && p.score === 0));
  assert.strictEqual(Object.keys(S.submissions).length, 58);
  const mine2 = (await call('/api/me', null, tokens[peopleAll[3].id])).body;
  assert.deepStrictEqual(mine2.submission.chips, redo, '되돌린 뒤 내 제출 내용 복원');
  console.log('OK 마지막 집계 되돌리기 (제출 내용 보존)');

  // 규칙 개정: 점수표 수정 후 마감
  const newTable = JSON.parse(JSON.stringify(SP.DEFAULT_TABLE)); newTable.yellow[4] = 100; newTable.white[0] = 5;
  S = await A({ type: 'saveSettings', patch: { scoreTable: newTable } });
  assert.strictEqual(S.settings.scoreTable.yellow[4], 100);
  S = await A({ type: 'close' });
  assert.strictEqual(S.participants.find((p) => p.id === peopleAll[0].id).base, 100, '노랑 5개 = 100 (개정된 점수표)');
  // 순위 변화: 첫 집계에는 직전 순위가 없다
  assert(S.participants.filter((p) => p.name && p.rank != null).every((p) => p.prevRank === null), '첫 집계: prevRank 없음');
  const rank1 = Object.fromEntries(S.participants.filter((p) => p.name).map((p) => [p.id, p.rank]));
  assert.strictEqual(S.history[0].table.yellow[4], 100);
  console.log('OK 점수표 편집 -> 마감 시 새 점수표 적용');
  assert((await AErr({ type: 'saveSettings', patch: { scoreTable: { yellow: [1, 'x', 3, 4, 5] } } })).includes('점수표'));

  // 라운드 2 + 칩 개수 변경
  await A({ type: 'open' });
  S = await A({ type: 'saveSettings', patch: { maxChips: 6 } });
  assert.strictEqual(S.settings.scoreTable.red.length, 6);
  assert.strictEqual((await call('/api/submit', { chips: Array(6).fill('red') }, tokens[peopleAll[1].id])).status, 200);
  S = await A({ type: 'close' });
  assert.strictEqual(S.history.length, 4); assert.strictEqual(S.round, 2);
  assert(S.participants.filter((p) => p.name && p.rank != null && rank1[p.id] != null).every((p) => p.prevRank === rank1[p.id]), '두 번째 집계: prevRank = 첫 집계 순위');
  assert(SP.rankDelta(5, 3) === 2 && SP.rankDelta(3, 5) === -2 && SP.rankDelta(4, 4) === 0 && SP.rankDelta(null, 4) === null, 'rankDelta');
  { const q = S.participants.find((p) => p.name && p.prevRank != null);
    const m = (await call('/api/me', null, tokens[q.id])).body;
    assert.strictEqual(m.me.prevRank, q.prevRank); assert.strictEqual(m.me.rank, q.rank); }
  S = await A({ type: 'undo' });
  assert(S.participants.filter((p) => p.name && rank1[p.id] != null).every((p) => p.rank === rank1[p.id] && p.prevRank === null), '되돌리면 순위·직전순위 복원');
  assert.strictEqual(S.open, true, '되돌리면 집계가 다시 열림');
  S = await A({ type: 'close' });
  assert(S.participants.filter((p) => p.name && p.rank != null && rank1[p.id] != null).every((p) => p.prevRank === rank1[p.id]));
  console.log('OK 순위 변화: 첫 집계 없음, 이후 직전 순위, 되돌리기 복원');

  // 게임 종료: 열린 집계가 있으면 불가, 종료하면 잠김, 참가자 화면에 최종 결과, 종료 취소로 재개
  await A({ type: 'open' });
  assert((await AErr({ type: 'endGame' })).includes('열려'), '집계가 열려 있으면 종료 불가');
  S = await A({ type: 'close' });
  const histLen = S.history.length, roundsDone = S.round;
  S = await A({ type: 'endGame' });
  assert(S.ended && S.ended.round === S.round, '종료 상태');
  assert(JSON.stringify(S).indexOf('journeys') === -1, '진행자 화면에 journeys 원본은 넣지 않음');
  for (const t of ['open', 'undo', 'removePerson', 'addPerson', 'importPeople', 'setPresent', 'setClass', 'setRound']) {
    assert((await AErr({ type: t, pid: peopleAll[0].id, pool: 'find', text: 'x', name: 'x', present: false, tier: 0, round: 1 })).includes('종료'), t + ' 잠겨야 함');
  }
  assert((await AErr({ type: 'endGame' })).includes('이미'), '중복 종료 불가');
  { const q = S.participants.find((p) => p.name && p.rank != null);
    const m = (await call('/api/me', null, tokens[q.id])).body;
    assert(m.ended && m.final, '참가자 화면에 최종 결과');
    assert.strictEqual(m.final.journey.length, roundsDone + 1, '시작 + 라운드 수만큼 이동 기록');
    assert.strictEqual(m.final.journey[0].r, 0); assert.strictEqual(m.final.journey[m.final.journey.length - 1].tier, q.cls);
    assert.strictEqual(m.final.tierCounts.reduce((a, b) => a + b, 0), m.final.groupSize);
    assert.strictEqual((await call('/api/submit', { chips: ['red'] }, tokens[q.id])).status, 409, '종료 후 제출 불가'); }
  S = await A({ type: 'reopenGame' });
  assert.strictEqual(S.ended, null);
  assert.strictEqual((await call('/api/me', null, tokens[peopleAll[3].id])).body.ended, null);
  S = await A({ type: 'open' }); S = await A({ type: 'close' }); // 종료 취소 후 다시 진행 가능
  assert.strictEqual(S.history.length, histLen + 2);
  S = await A({ type: 'endGame' }); S = await A({ type: 'resetGame' });
  assert.strictEqual(S.ended, null, '게임 초기화하면 종료 상태도 풀림');
  console.log('OK 게임 종료: 열린 집계 중 불가, 종료 후 잠금, 참가자 최종 결과, 종료 취소 후 재개, 초기화');
  console.log('OK 라운드2, 칩 최대 개수 변경(6개)');

  // 이전 라운드 제출이 다음 라운드로 새어 들어오지 않음
  await A({ type: 'open' });
  S = await state();
  assert.deepStrictEqual(S.submissions, {}, '새 라운드는 빈 상태로 시작');
  await A({ type: 'close' });

  // 동점 처리: 공동 순위 + 경계에 걸친 동점자는 원래 계급 유지(정원 조정)
  await A({ type: 'resetGame' });
  await A({ type: 'saveSettings', patch: { scoreTable: SP.DEFAULT_TABLE, maxChips: 5 } });
  S = await state();
  const kku = S.participants.filter((p) => p.pool === 'kku' && p.name); // 꾸는: 네모 3 / 세모 10 / 동그라미 13
  const ids = { 0: kku.filter((p) => p.t0 === 0), 1: kku.filter((p) => p.t0 === 1), 2: kku.filter((p) => p.t0 === 2) };
  assert.deepStrictEqual([ids[0].length, ids[1].length, ids[2].length], [3, 10, 13]);
  // 1라운드: 전원 점수가 서로 다르게 (동점 없음) -> 기존 계급과 같은 순서가 되도록 계급 순으로 높은 점수 부여
  const high = ['yellow', 'yellow', 'yellow', 'yellow', 'yellow'], mid = ['green', 'green', 'green', 'green', 'green'], low = ['white'];
  const submitAll = async (chipsFor) => {
    await A({ type: 'open' });
    S = await state();
    const pin = Object.fromEntries(S.participants.map((p) => [p.id, p.pin]));
    for (const p of kku) {
      const t = (await call('/api/login', { name: p.name, pin: pin[p.id] })).body.token;
      await call('/api/submit', { chips: chipsFor(p) }, t);
    }
    return A({ type: 'close' });
  };
  S = await submitAll((p) => (p.t0 === 0 ? high : p.t0 === 1 ? mid : low));
  assert(S.participants.filter((p) => p.pool === 'kku' && p.name).every((p) => p.cls === p.t0), '점수 순서대로면 계급 유지');
  // 2라운드: 네모 3명 + 세모 2명이 같은 점수 -> 순위 1~5 모두 공동 1위, 네모/세모 경계(3칸)에 걸침 -> 각자 원래 계급 유지, 네모 3 세모 13 그대로
  // 이어서 동그라미 중 1명이 같은 점수가 되면 (세모/동그라미 경계) 원래 동그라미 유지
  const tieSet = [...ids[0], ids[1][0], ids[1][1]];
  S = await submitAll((p) => (tieSet.some((q) => q.id === p.id) ? high : p.t0 === 1 ? mid : low));
  const f = (id) => S.participants.find((p) => p.id === id);
  assert(tieSet.every((p) => f(p.id).rank === 1 && f(p.id).tied), '동점자는 공동 1위');
  assert(ids[0].every((p) => f(p.id).cls === 0), '네모 출신 동점자는 네모 유지');
  assert(ids[1].slice(0, 2).every((p) => f(p.id).cls === 1), '세모 출신 동점자는 세모 유지');
  // 3라운드: 세모 출신 5명이 네모 출신 3명과 같은 점수로 동점 (전부 상위 8명) -> 네모 3칸 경계에 걸침. 세모 출신 5명은 세모 유지, 네모는 네모 유지
  const tie2 = [...ids[0], ...ids[1].slice(0, 5)];
  S = await submitAll((p) => (tie2.some((q) => q.id === p.id) ? high : p.t0 === 1 ? mid : low));
  assert(ids[0].every((p) => f(p.id).cls === 0) && ids[1].slice(0, 5).every((p) => f(p.id).cls === 1), '경계에 걸친 동점자는 원래 계급 유지');
  const cnt0 = S.participants.filter((p) => p.pool === 'kku' && p.name && p.cls === 0).length;
  assert.strictEqual(cnt0, 3);
  // 동그라미 출신 1명이 단독 1위가 되면 네모로 올라가고, 나머지 13명(네모 3 + 세모 10)은 공동 2위로 모두 원래 계급 유지 -> 인원이 4/10/12 로 조정됨
  const climber = ids[2][0];
  S = await submitAll((p) => (p.id === climber.id ? high : p.t0 === 2 ? low : mid));
  assert.strictEqual(f(climber.id).cls, 0); assert.strictEqual(f(climber.id).rank, 1); assert(!f(climber.id).tied);
  assert(ids[0].every((p) => f(p.id).cls === 0 && f(p.id).rank === 2 && f(p.id).tied));
  assert(ids[1].every((p) => f(p.id).cls === 1));
  assert.deepStrictEqual([0, 1, 2].map((t) => S.participants.filter((p) => p.pool === 'kku' && p.name && p.cls === t).length), [4, 10, 12]);
  console.log('OK 동점 처리 (공동 순위, 경계 동점자는 원래 계급 유지)');

  // 참가자가 직접 입력하는 보너스 칩 (진행자가 입력한 값이 있으면 그 값이 우선, 미제출이면 이전 값 유지)
  await A({ type: 'open' });
  const [b0, b1, b2, b3, b4] = kku;
  const sub = (p, chips, bonus) => call('/api/submit', { chips, bonus }, tokens[p.id]);
  assert.strictEqual((await sub(b0, ['white'], 2)).status, 200);
  assert.strictEqual((await call('/api/me', null, tokens[b0.id])).body.submission.bonus, 2);
  assert.strictEqual((await sub(b1, ['white'], 3)).status, 200);
  assert.strictEqual((await sub(b2, [], 1)).status, 200, '보너스 칩만 있어도 제출 가능');
  assert.strictEqual((await sub(b3, ['white'], 11)).status, 400, '최대 개수 초과는 거부');
  assert.strictEqual((await sub(b3, ['white'], -1)).status, 400);
  assert.strictEqual((await sub(b3, ['white'], 1.5)).status, 400);
  assert.strictEqual((await sub(b4, [], 0)).status, 400, '칩도 보너스도 없으면 거부');
  await A({ type: 'setBonus', pid: b1.id, n: 1 }); // 진행자가 고친 값이 우선
  S = await state();
  assert.strictEqual(S.bonus[b0.id], 2); assert.strictEqual(S.bonus[b1.id], 1); assert.strictEqual(S.bonus[b2.id], 1);
  await A({ type: 'setChips', pid: b0.id, chips: ['white', 'white'] }); // 진행자가 칩을 대신 입력해도 참가자의 보너스 칩은 유지
  S = await A({ type: 'close' });
  const g = (p) => S.participants.find((x) => x.id === p.id);
  assert.strictEqual(g(b0).bonusN, 2); assert.strictEqual(g(b0).score, SP.calcScore(['white', 'white'], SP.DEFAULT_TABLE).total + 6);
  assert.strictEqual(g(b1).bonusN, 1); assert.strictEqual(g(b1).score, 1 + 3);
  assert.strictEqual(g(b2).bonusN, 1); assert.strictEqual(g(b2).score, 0 + 3);
  await A({ type: 'open' }); S = await A({ type: 'close' }); // 아무도 제출하지 않은 라운드: 이전 칩과 보너스 칩이 그대로
  assert.strictEqual(g(b0).bonusN, 2); assert.strictEqual(g(b0).score, SP.calcScore(['white', 'white'], SP.DEFAULT_TABLE).total + 6);
  console.log('OK 참가자 보너스 칩 입력: 검증, 진행자 수정 우선, 미제출 시 이전 값 유지');

  // 이후 인원 검증은 동점이 없어야 정확히 정원대로 나뉜다: 전원 칩 1개 + 보너스 칩을 서로 다르게 줘서 점수를 모두 다르게 만든다
  const distinctRound = async () => {
    await A({ type: 'open' });
    S = await state();
    const named = S.participants.filter((p) => p.name);
    for (let i = 0; i < named.length; i++) {
      await A({ type: 'setChips', pid: named[i].id, chips: ['white'] });
      await A({ type: 'setBonus', pid: named[i].id, n: ((i * 7) % named.length) + 1 });
    }
    S = await A({ type: 'close' });
    assert.strictEqual(new Set(S.participants.filter((p) => p.name).map((p) => p.score)).size, named.length);
    return S;
  };

  // 반 통합 / 인원 직접 설정 / 배정된 아이디 삭제 방지
  // 두 반 합치기: 한쪽만 누르면 합쳐지지 않고, 취소할 수 있고, 둘 다 누르면 합쳐진다
  await act1({ type: 'open' }, 'find');
  assert((await call('/api/admin/action', { type: 'setMergeReady', ready: true }, adminTok.find)).status === 400, '집계가 열려 있으면 합치기 불가');
  await act1({ type: 'close' }, 'find');
  await act1({ type: 'setMergeReady', ready: true }, 'find');
  { const k = await state1('kku');
    assert(!k.merge.done && !k.merge.mine && k.merge.other.ready, '상대가 합치기를 눌렀다는 표시');
    assert((await call('/api/admin/action', { type: 'open' }, adminTok.find)).status === 400, '합치기를 눌러 둔 반은 집계를 열 수 없음');
    await act1({ type: 'setMergeReady', ready: false }, 'find');
    assert(!(await state1('kku')).merge.other.ready, '취소하면 풀림'); }
  await act1({ type: 'setMergeReady', ready: true }, 'find');
  assert(!(await state1('find')).merge.done, '한쪽만 누르면 합쳐지지 않음');
  const roundBefore = Math.max((await state1('find')).round, (await state1('kku')).round);
  await act1({ type: 'setMergeReady', ready: true }, 'kku');
  mergedNow = true;
  { const f = await state1('find'), k = await state1('kku');
    assert(f.merge.done && k.merge.done, '둘 다 누르면 합쳐짐');
    assert(f.settings.merged && !f.readOnly && k.readOnly, '합친 뒤 꾸는반은 보기 전용');
    assert.strictEqual(f.round, roundBefore, '라운드 번호는 이어짐');
    assert.strictEqual(k.participants.length, f.participants.length, '꾸는반 화면에서도 전체가 보임');
    assert((await call('/api/admin/action', { type: 'open' }, adminTok.kku)).status === 400, '보기 전용 화면에서는 진행 불가'); }
  S = await distinctRound();
  assert.strictEqual(S.round, roundBefore + 1, '통합 첫 라운드는 이어서');
  assert(S.history.filter((h) => h.group === 'all').length >= 1);
  assert.deepStrictEqual([0, 1, 2].map((t) => S.participants.filter((p) => p.name && p.present !== false && p.cls === t).length), [7, 24, 29]);
  console.log('OK 반 통합: 전체 7/24/29 로 재편');
  // 게임 시작 후 늦게 온 사람은 맨 아래 계급에서 시작하고, 삭제는 막히며, 결석 처리는 된다
  S = await A({ type: 'addPerson', pool: 'find', name: '지각생', birth: '2005-01-01', enroll: '2020-03' });
  const late = S.participants.find((p) => p.name === '지각생');
  assert.strictEqual(late.cls, 2, '늦게 온 사람은 나이가 많아도 맨 아래 계급에서 시작');
  S = await A({ type: 'setPresent', pid: late.id, present: false });
  assert.strictEqual(S.participants.filter((p) => p.name && p.present !== false).length, 60);
  // 게임 중에도 삭제할 수 있다 (지난 기록에는 이름이 남는다)
  S = await A({ type: 'addPerson', pool: 'kku', name: '임시', birth: '2010-01-01', enroll: '2026-03' });
  const temp = S.participants.find((p) => p.name === '임시');
  S = await A({ type: 'removePerson', pid: temp.id });
  assert(!S.participants.some((p) => p.id === temp.id));
  assert.strictEqual(S.participants.filter((p) => p.name && p.present !== false).length, 60);
  // 이름을 고친다
  const target = S.participants.find((p) => p.name === '찾1');
  S = await A({ type: 'updateParticipant', pid: target.id, fields: { name: '찾일', birth: '2007', enroll: '2024-03' } });
  assert.strictEqual(S.participants.find((p) => p.id === target.id).name, '찾일');
  S = await A({ type: 'updateParticipant', pid: target.id, fields: { name: '찾1' } });
  await A({ type: 'saveSettings', patch: { sizeOverride: { all: [8, 28, 24] } } });
  S = await distinctRound();
  assert.deepStrictEqual([0, 1, 2].map((t) => S.participants.filter((p) => p.name && p.present !== false && p.cls === t).length), [8, 28, 24]);
  console.log('OK 계급 인원 직접 설정');

  // 비밀번호 변경 (환경변수 지정이면 거부)
  const pwRes = await call('/api/admin/action', { type: 'setPassword', password: 'newpw1234' }, adminTok.find);
  if (S.passwordFromEnv) assert.strictEqual(pwRes.status, 400);
  else { assert.strictEqual(pwRes.status, 200); assert.strictEqual((await call('/api/admin/state', null, adminTok.find)).status, 401); }
  console.log('OK 비밀번호 변경 동작 (환경변수:', !!S.passwordFromEnv, ')');
}

module.exports = { run };
