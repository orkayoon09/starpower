// 예전 버전(아이디를 미리 만들어 두던 방식)으로 저장된 데이터가 새 방식에서 정상 동작하는지: node test/migrate.js
const assert = require('assert');
const { makeGame, freshCore } = require('../lib/game.js');

const core = freshCore('pw');
// 예전 데이터를 흉내 낸다: schema 없음, 예전 정원, 이름 없는 빈 아이디, present/started 필드 없음
delete core.settings.schema;
core.settings.pools.find.counts = [4, 16, 14];
core.settings.pools.kku.counts = [3, 13, 10];
core.nextId = undefined;
core.participants = [
  { id: 'find-0-1', pool: 'find', t0: 0, n: 1, name: '김하늘', pin: '11', birth: '2007-01-01', enroll: '2024-03', cls: 0, rank: null, groupSize: null, prevCls: 0, change: 'none', chips: [], base: 0, bonusN: 0, score: 0, missing: false },
  { id: 'find-0-2', pool: 'find', t0: 0, n: 2, name: '', pin: '', birth: '', enroll: '', cls: 0, rank: null, groupSize: null, prevCls: 0, change: 'none', chips: [], base: 0, bonusN: 0, score: 0, missing: false },
  { id: 'find-2-1', pool: 'find', t0: 2, n: 1, name: '이도윤', pin: '22', birth: '2009-05-05', enroll: '2025-03', cls: 2, rank: null, groupSize: null, prevCls: 2, change: 'none', chips: [], base: 0, bonusN: 0, score: 0, missing: false },
];
const g = makeGame({ core, history: {}, subs: {} });
assert.strictEqual(core.settings.schema, 2);
assert.deepStrictEqual(core.settings.pools.find.counts, [4, 14, 0]);
assert.strictEqual(core.participants.length, 2, '이름 없는 빈 아이디는 정리됨');
assert(core.participants.every((p) => p.present === true && p.started === false));
g.adminAction({ type: 'addPerson', pool: 'find', name: '박서준', birth: '2008-01-01', enroll: '2024-03' });
assert(core.participants.every((p) => p.t0 === 0), '인원이 네모 정원보다 적으면 모두 네모');
assert(core.participants.find((p) => p.name === '김하늘'));
// 다시 만들어도(요청마다 makeGame 이 새로 만들어짐) 결과가 같다
makeGame({ core, history: {}, subs: {} });
assert.strictEqual(core.participants.length, 3);
console.log('OK 예전 데이터 이전: 빈 아이디 정리, 정원 새 기본값, 이름 있는 참가자 유지');

// 1.x 데이터(반 구분 없이 라운드 하나만 있던 구조)는 반별 진행 구조로 바뀌고 진행 상황만 초기화된다
{
  const old = freshCore('pw');
  delete old.games; delete old.merge; delete old.nextHist;
  Object.assign(old, { round: 3, open: true, bonus: { x: 1 }, tallyCount: 3, ended: null });
  old.settings.merged = true;
  old.participants = [
    { id: 'find-1', pool: 'find', t0: 1, n: 1, name: '김하늘', pin: '11', birth: '2007-01-01', enroll: '2024-03', cls: 0, rank: 2, prevRank: 3, groupSize: 5, prevCls: 1, change: 'up', chips: ['red'], base: 5, bonusN: 1, score: 8, missing: false, present: true, started: true },
  ];
  const og = makeGame({ core: old, history: {}, subs: {} });
  assert(old.games && ['find', 'kku', 'all'].every((k) => old.games[k].round === 0 && !old.games[k].open), '반별 진행 상태가 새로 생김');
  assert(!('round' in old) && !('open' in old), '예전 전역 필드는 정리됨');
  assert.strictEqual(old.settings.merged, false);
  assert.strictEqual(old.participants[0].rank, null, '순위는 초기화');
  assert.strictEqual(old.participants[0].name, '김하늘', '명단은 유지');
  assert.strictEqual(og.adminView({}, 'find').round, 0);
  // 예전 2자리 PIN 은 그대로 로그인되고, 다른 칸을 고칠 때도 막히지 않는다. 새 PIN 은 4자리만 허용한다.
  assert(og.findLogin('김하늘', '11'), '예전 2자리 PIN 로그인 유지');
  og.adminAction({ type: 'updateParticipant', pid: old.participants[0].id, fields: { birth: '2007-02-02' } }, 'find');
  assert.strictEqual(old.participants[0].pin, '11');
  assert.throws(() => og.adminAction({ type: 'updateParticipant', pid: old.participants[0].id, fields: { pin: '12' } }, 'find'), /4자리/);
  og.adminAction({ type: 'updateParticipant', pid: old.participants[0].id, fields: { pin: '1234' } }, 'find');
  assert(og.findLogin('김하늘', '1234') && !og.findLogin('김하늘', '11'));
  console.log('OK 1.x 데이터 이전: 반별 진행 구조로 바뀌고 명단은 유지, 예전 2자리 PIN 호환');
}

// 점수표에서 나올 수 있는 가장 낮은 점수 (결과 화면 히스토그램에서 낮은 구간을 합치는 기준)
const SP = require('../public/shared.js');
assert.strictEqual(SP.minPossibleScore(SP.DEFAULT_TABLE, 5), 7);
console.log('OK 최저 가능 점수 7 (칩 5개, 기본 점수표)');
