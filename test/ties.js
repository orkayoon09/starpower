// 동점 처리 규칙: 계급 정원은 그대로, 동점자는 기존 계급 유지 -> 생년월일 -> 기수 순: node test/ties.js
const assert = require('assert');
const { makeGame, freshCore } = require('../lib/game.js');

const core = freshCore('pw');
const history = {}, subs = {};
const game = () => makeGame({ core, history, subs });
const act = (a) => game().adminAction(a, 'find');
const by = (name) => core.participants.find((p) => p.name === name);
const cls = (names) => names.map((n) => by(n).cls);

// 찾여 5명, 정원: 네모 1 / 세모 1 / 나머지 동그라미. 나이순 초기 계급: A 네모, B 세모, D·C·E 동그라미 (C 와 D 는 생년월일이 같고 D 가 기수가 빠름)
act({ type: 'importPeople', pool: 'find', text: ['A, 2005-01-01, 2024-03', 'B, 2006-01-01, 2024-03', 'C, 2007-01-01, 2025-03', 'D, 2007-01-01, 2024-03', 'E, 2008-01-01, 2024-03'].join('\n') });
act({ type: 'saveSettings', patch: { sizeOverride: { find: [1, 1, 3] } } });
assert.deepStrictEqual(cls(['A', 'B', 'D', 'C', 'E']), [0, 1, 2, 2, 2]);

const HIGH = ['yellow', 'yellow', 'yellow', 'yellow', 'yellow'], LOW = ['white'];
const round = (high) => {
  act({ type: 'open' });
  for (const p of core.participants) act({ type: 'setChips', pid: p.id, chips: high.includes(p.name) ? HIGH : LOW });
  act({ type: 'close' });
  const counts = [0, 1, 2].map((t) => core.participants.filter((p) => p.cls === t).length);
  assert.deepStrictEqual(counts, [1, 1, 3], '계급 인원은 항상 정원 그대로');
};

// 1라운드: 전원 동점 -> 모두 공동 1위, 기존 계급 그대로
round(['A', 'B', 'C', 'D', 'E']);
assert.deepStrictEqual(cls(['A', 'B', 'D', 'C', 'E']), [0, 1, 2, 2, 2]);
assert(core.participants.every((p) => p.rank === 1 && p.tied), '동점은 공동 순위로 표시');

// 2라운드: B, C, D 가 동점 1위(3자리: 네모, 세모, 동그라미). 기존 계급이 높은 B 가 먼저, 같은 동그라미 출신 D, C 는 생년월일이 같아 기수가 빠른 D 가 먼저
round(['B', 'C', 'D']);
assert.deepStrictEqual(cls(['B', 'D', 'C']), [0, 1, 2], '기존 계급 -> (생년월일 같으면) 기수');
assert.strictEqual(by('A').cls, 2, 'A 는 점수가 낮아 내려감');
assert(by('B').rank === 1 && by('D').rank === 1 && by('C').rank === 1 && by('A').rank === 4);

// 3라운드: 현재 B 네모, D 세모, A 동그라미. A, B, D 가 동점이면 A 가 가장 연장자라도 기존 계급이 우선이라 B, D 가 그대로, A 는 동그라미
round(['A', 'B', 'D']);
assert.deepStrictEqual(cls(['B', 'D', 'A']), [0, 1, 2], '기존 계급 유지가 생년월일보다 먼저');

// 4라운드: 기존 계급이 모두 같은(동그라미) A, C, E 만 동점으로 위 두 자리를 다툰다고 가정하려면 B, D 가 낮은 점수여야 한다 -> 세 사람 동점 1위: 네모, 세모 자리는 생년월일 순(A, C)
round(['A', 'C', 'E']);
assert.deepStrictEqual(cls(['A', 'C', 'E']), [0, 1, 2]);
console.log('OK 동점 처리: 정원 유지, 기존 계급 -> 생년월일 -> 기수');

// 점수표 확장 규칙: 5개까지는 문서 점수표, 6개 이상은 '5개 점수 + (n-5)개 점수' (하양 6개 = 16 + 1 = 17)
{
  const c2 = freshCore('pw');
  const g2 = makeGame({ core: c2, history: {}, subs: {} });
  g2.adminAction({ type: 'saveSettings', patch: { maxChips: 10 } }, 'find');
  assert.deepStrictEqual(c2.settings.scoreTable.white, [1, 2, 3, 12, 16, 17, 18, 19, 28, 32]);
  assert.deepStrictEqual(c2.settings.scoreTable.yellow, [8, 16, 24, 32, 40, 48, 56, 64, 72, 80]);
  g2.adminAction({ type: 'saveSettings', patch: { maxChips: 3 } }, 'find'); // 줄였다가 다시 늘려도 문서 점수표로 복구
  g2.adminAction({ type: 'saveSettings', patch: { maxChips: 6 } }, 'find');
  assert.deepStrictEqual(c2.settings.scoreTable.white, [1, 2, 3, 12, 16, 17]);
  console.log('OK 점수표 확장: 6개 이상은 5개 점수 + (n-5)개 점수');
}
