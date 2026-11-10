// 이상 징후 알림(부정행위 의심)과 집계 중이 아닐 때 점수 수정: node test/alerts.js
const assert = require('assert');
const { makeGame, freshCore } = require('../lib/game.js');

const core = freshCore('pw');
const history = {}, subs = {};
const game = () => makeGame({ core, history, subs });
const act = (a) => game().adminAction(a, 'find');
const alerts = () => game().adminView({}, 'find').alerts;
const by = (n) => core.participants.find((p) => p.name === n);
const NAMES = ['A', 'B', 'C', 'D', 'E', 'F'];
const Y5 = Array(5).fill('yellow'), G5 = Array(5).fill('green');

// 찾여 6명, 정원 네모 1 / 세모 1 / 동그라미 4. 나이순: A 네모, B 세모, 나머지 동그라미
act({ type: 'importPeople', pool: 'find', text: NAMES.map((n, i) => `${n}, ${2005 + i}-01-01, 24-1`).join('\n') });
act({ type: 'saveSettings', patch: { sizeOverride: { find: [1, 1, 4] } } });
assert.deepStrictEqual(NAMES.map((n) => by(n).cls), [0, 1, 2, 2, 2, 2]);
const submit = (map) => { for (const n of NAMES) act({ type: 'setChips', pid: by(n).id, chips: map[n] || ['white'] }); };
const types = (list) => list.map((a) => a.type + ':' + a.name).sort();

// ---- 높은 점수: 네모가 아닌 계급이 보너스 칩 없이 20점 초과
act({ type: 'open' });
submit({ A: Y5, B: Y5, C: G5 });  // A 네모 40점(제외), B 세모 40점(알림), C 동그라미 20점(기준 초과 아님)
assert.deepStrictEqual(types(alerts()), ['highNoBonus:B'], '첫 라운드: 높은 점수만 알림, 점수 급변은 제외');
act({ type: 'setBonus', pid: by('B').id, n: 1 });
assert.deepStrictEqual(alerts(), [], '보너스 칩이 있으면 높은 점수 알림 없음 (첫 라운드 + 보너스 지급 라운드)');
act({ type: 'setBonus', pid: by('B').id, n: 0 });
act({ type: 'saveSettings', patch: { alerts: { highNoBonus: { on: false } } } });
assert.deepStrictEqual(alerts(), [], '조건을 끄면 알림 없음');
act({ type: 'saveSettings', patch: { alerts: { highNoBonus: { on: true, score: 40 } } } });
assert.deepStrictEqual(alerts(), [], '기준 점수를 40으로 올리면 40점은 넘지 않음');
act({ type: 'saveSettings', patch: { alerts: { highNoBonus: { on: true, score: 20 } } } });
assert.throws(() => act({ type: 'saveSettings', patch: { alerts: { scoreJump: { delta: 0 } } } }), /1 이상/);
act({ type: 'close' });
assert.deepStrictEqual(alerts(), [], '집계 중이 아니면 알림 없음');

// ---- 점수 급변 (2라운드부터): D 가 1점 -> 40점, C 는 20 -> 20 변화 없음
act({ type: 'open' });
submit({ A: Y5, B: ['white'], C: G5, D: Y5 });
assert.deepStrictEqual(types(alerts()), ['highNoBonus:D', 'scoreJump:B', 'scoreJump:D'].sort(), 'B 는 40 -> 1 로 급락, D 는 1 -> 40 급등');
assert(alerts().find((a) => a.type === 'scoreJump' && a.name === 'D').text.includes('+39'));
act({ type: 'saveSettings', patch: { alerts: { scoreJump: { on: true, delta: 50 } } } });
assert(!alerts().some((a) => a.type === 'scoreJump'), '변동 기준 50점으로 올리면 알림 없음');
act({ type: 'saveSettings', patch: { alerts: { scoreJump: { on: true, delta: 10 } } } });
act({ type: 'close' });

// ---- 보너스 칩 지급 라운드(처음 0개가 아니게 된 라운드)에는 점수 급변·총량 알림 없음
act({ type: 'open' });
submit({ A: Y5, B: ['white'], C: ['white'], D: ['white'], E: ['white'], F: ['white'] }); // 큰 점수 변동 있음
act({ type: 'setBonus', pid: by('C').id, n: 2 });
act({ type: 'setBonus', pid: by('E').id, n: 1 });
assert(!alerts().some((a) => a.type === 'scoreJump' || a.type === 'bonusTotal'), '지급 라운드는 점수 급변·총량 변화 알림 제외: ' + JSON.stringify(alerts()));
act({ type: 'close' });
assert.strictEqual(core.participants.reduce((a, p) => a + p.bonusN, 0), 3);

// ---- 지급 이후: 반 전체 보너스 칩 총량이 바뀌면 알림, 같으면 없음
act({ type: 'open' });
submit({});
assert.deepStrictEqual(types(alerts()).filter((t) => t.startsWith('bonusTotal')).length, 1, '제출만 하면(보너스 0) 총량 3 -> 0');
act({ type: 'setBonus', pid: by('C').id, n: 2 });
act({ type: 'setBonus', pid: by('E').id, n: 1 });
assert(!alerts().some((a) => a.type === 'bonusTotal'), '총량 3 -> 3 (사람별로 바뀌어도 합계가 같으면 정상)');
act({ type: 'setBonus', pid: by('C').id, n: 1 });
act({ type: 'setBonus', pid: by('F').id, n: 1 });
assert(!alerts().some((a) => a.type === 'bonusTotal'), '양도(합계 그대로)는 정상');
act({ type: 'setBonus', pid: by('F').id, n: 2 });
const bt = alerts().find((a) => a.type === 'bonusTotal');
assert(bt && bt.text.includes('3개에서 4개'), '총량 증가 알림: ' + JSON.stringify(bt));
act({ type: 'saveSettings', patch: { alerts: { bonusTotal: { on: false } } } });
assert(!alerts().some((a) => a.type === 'bonusTotal'), '끄면 없음');
act({ type: 'saveSettings', patch: { alerts: { bonusTotal: { on: true } } } });
act({ type: 'setBonus', pid: by('F').id, n: 1 });
act({ type: 'close' });
console.log('OK 이상 징후 알림: 높은 점수, 점수 급변, 보너스 칩 총량, 켜고 끄기와 기준 변경');

// ---- 집계 중이 아닐 때 점수 수정: 점수만 바뀌고 순위·계급은 그대로, 직전 결과 기록의 점수도 같이 고쳐짐
const c = by('C');
const before = { cls: c.cls, rank: c.rank, prevCls: c.prevCls };
act({ type: 'setScore', pid: c.id, chips: ['yellow'], bonus: 5 });
assert.strictEqual(by('C').base, 8); assert.strictEqual(by('C').bonusN, 5); assert.strictEqual(by('C').score, 8 + 5 * 3);
assert.deepStrictEqual({ cls: by('C').cls, rank: by('C').rank, prevCls: by('C').prevCls }, before, '계급·순위는 그대로');
const last = history.find[history.find.length - 1].results.find((r) => r.pid === c.id);
assert.strictEqual(last.score, 23); assert.strictEqual(last.edited, true); assert.strictEqual(last.rank, before.rank);
assert.throws(() => act({ type: 'setScore', pid: c.id, chips: ['red'], bonus: -1 }), /0~999/);
assert.throws(() => act({ type: 'setScore', pid: c.id, chips: ['nope'], bonus: 1 }), /알 수 없는/);
// 다음 집계에서 제출하지 않으면 고친 값이 이어진다
act({ type: 'open' });
for (const n of NAMES) if (n !== 'C') act({ type: 'setChips', pid: by(n).id, chips: ['white'] });
assert.throws(() => act({ type: 'setScore', pid: c.id, chips: ['red'], bonus: 1 }), /집계 중/);
act({ type: 'close' });
assert.strictEqual(by('C').score, 23, '미제출자는 고친 점수가 유지됨');
act({ type: 'endGame' });
assert.throws(() => act({ type: 'setScore', pid: c.id, chips: ['red'], bonus: 1 }), /종료/);
console.log('OK 집계 중이 아닐 때 점수 수정: 계급·순위 그대로, 기록 반영, 종료 후 잠금');
