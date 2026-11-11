'use strict';
/*
 * 게임 로직 (저장소·HTTP와 무관한 순수 로직)
 *
 * makeGame({ core, history, subs }) 가 받는 데이터
 *   core    : { settings, participants, round, open, bonus, tallyCount, adminPassword }
 *   history : 마감된 집계 기록 배열
 *   subs    : { [참가자id]: { chips, ts, by, round } }  이번 라운드에 제출된 칩
 * 로직은 이 객체들을 직접 수정하고, 저장은 호출한 쪽(api.js)이 변경 전후를 비교해서 처리한다.
 */
const crypto = require('crypto');
const SP = require('../public/shared.js');

const clone = (x) => JSON.parse(JSON.stringify(x));
const normName = (s) => String(s || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();

// ---------------------------------------------------------------- 기본값
function defaultSettings() {
  return {
    schema: 2,
    // 위에서 아래 순서 (최상위 -> 최하위)
    tiers: [
      { name: '하트', symbol: '♥', color: '#d32e21' },
      { name: '다이아몬드', symbol: '◆', color: '#0b1dd3' },
      { name: '클로버', symbol: '♣', color: '#88dc44' },
    ],
    pools: {
      find: { name: '찾는·여는반', short: '찾여', counts: [4, 14, 0] },
      kku: { name: '꾸는반', short: '꾸', counts: [3, 10, 0] },
    },
    bonusValue: 3, // 보너스 칩 1개 점수
    maxBonus: 10, // 참가자가 한 번에 입력할 수 있는 보너스 칩 최대 개수
    colors: clone(SP.DEFAULT_COLORS),
    scoreTable: clone(SP.DEFAULT_TABLE),
    maxChips: 5,
    // 집계 중 이상 징후 알림(부정행위 의심). 조건마다 켜고 끌 수 있고 기준 숫자를 바꿀 수 있다.
    alerts: {
      highNoBonus: { on: true, score: 20 },  // 최상위 계급이 아닌 사람이 보너스 칩 없이 칩 점수가 이 값을 넘음
      bonusTotal: { on: true },              // 보너스 칩이 처음 지급된 라운드 이후 반 전체 보너스 칩 총량이 바뀜
      scoreJump: { on: true, delta: 10 },    // 첫 라운드와 보너스 칩 지급 라운드 외에 점수가 이 값 이상 오르내림
    },
    merged: false,
    // 계급별 인원: 맨 아래 계급을 뺀 위쪽 계급은 정원이 고정이고, 맨 아래 계급은 '나머지 전원'이다 (counts 의 마지막 값은 쓰지 않음)
    // sizeOverride 가 null 이면 pools[*].counts 를 사용
    sizeOverride: { find: null, kku: null, all: null },
  };
}

function newPerson(pool, id, n, lastTier) {
  return {
    id, pool, t0: lastTier, n,
    name: '', pin: '', birth: '', enroll: '', present: true, jailed: false, started: false,
    cls: lastTier, rank: null, prevRank: null, tied: false, groupSize: null, prevCls: lastTier, change: 'none',
    chips: [], base: 0, bonusN: 0, score: 0, missing: false,
  };
}

// 반별(통합 후에는 'all') 진행 상태
function freshGame() {
  return { round: 0, open: false, tallyCount: 0, bonus: {}, ended: null, fresh: false };
}

function freshCore(adminPassword) {
  const core = {
    settings: defaultSettings(),
    participants: [],
    games: { find: freshGame(), kku: freshGame(), all: freshGame() }, // 반별 라운드·집계 상태 (통합 후에는 all 을 사용)
    merge: { find: false, kku: false },                                  // 양쪽이 '합치기'를 눌렀는지
    nextHist: 0,
    nextId: 1,
    adminPassword: adminPassword || String(crypto.randomInt(100000, 1000000)),
    secret: crypto.randomBytes(24).toString('hex'), // 로그인 토큰 서명용
  };
  return core;
}

// ---------------------------------------------------------------- 게임
function makeGame({ core, history, subs }) {
  const getSettings = () => core.settings;

  // ---- 참가자
  // 예전 버전(아이디를 미리 만들어 두던 방식)으로 저장된 데이터를 새 방식으로 바꾼다. 여러 번 실행해도 안전하다.
  function migrate() {
    const s = getSettings();
    if (s.schema !== 2) {
      const d = defaultSettings();
      for (const k of Object.keys(s.pools)) if (d.pools[k]) s.pools[k].counts = d.pools[k].counts.slice();
      s.sizeOverride = { find: null, kku: null, all: null };
      s.schema = 2;
    }
    if (s.maxBonus === undefined) s.maxBonus = 10;
    if (!s.alerts) s.alerts = defaultSettings().alerts;
    if (!core.nextId) core.nextId = 1;
    if (!core.nextHist) core.nextHist = 0;
    if (!core.merge) core.merge = { find: false, kku: false };
    if (!core.games) {
      // 1.x 데이터: 반별 진행 구조로 바뀌면서 진행 상황(라운드·순위)은 처음 상태로 돌린다. 명단·PIN·설정은 그대로 둔다.
      core.games = { find: freshGame(), kku: freshGame(), all: freshGame() };
      for (const k of ['round', 'open', 'bonus', 'tallyCount', 'ended']) delete core[k];
      s.merged = false;
      for (const p of core.participants) Object.assign(p, { cls: p.t0 == null ? s.tiers.length - 1 : p.t0, rank: null, prevRank: null, started: false });
    }
    for (const g of ['find', 'kku', 'all']) if (!core.games[g]) core.games[g] = freshGame();
    if (core.participants.some((p) => !p.name)) core.participants = core.participants.filter((p) => p.name); // 이름 없는 빈 아이디 제거
    for (const p of core.participants) {
      if (p.present === undefined) p.present = true;
      if (p.jailed === undefined) p.jailed = false;
      if (p.started === undefined) p.started = false;
      if (p.tied === undefined) p.tied = false;
      if (!(p.n >= 0)) p.n = 0;
    }
  }
  migrate();

  function labelOf(p) {
    const s = getSettings();
    return `${s.pools[p.pool].short}-${p.n}`;
  }
  const clearObj = (o) => { for (const k of Object.keys(o)) delete o[k]; };
  const GROUPS = ['find', 'kku', 'all'];
  const active = () => core.participants.filter((p) => p.name && p.present !== false);
  const groupOf = (p) => (getSettings().merged ? 'all' : p.pool);
  const byId = (id) => core.participants.find((p) => p.id === id);
  const gr = (g) => core.games[g];                                   // 반(통합 후에는 전체)별 진행 상태
  const members = (g) => core.participants.filter((p) => p.name && groupOf(p) === g);
  const activeIn = (g) => members(g).filter((p) => p.present !== false);
  const histOf = (g) => history[g] || (history[g] = []);
  const allHistory = () => GROUPS.flatMap((k) => histOf(k)).sort((a, b) => a.closedAt - b.closedAt || a.id - b.id);
  const inGroup = (pid, g) => { const p = byId(pid); return !!p && groupOf(p) === g; };

  function groupSizes(group) {
    const s = getSettings();
    const ov = s.sizeOverride[group];
    if (Array.isArray(ov) && ov.length === s.tiers.length) return ov.map(Number);
    if (group === 'all') return s.tiers.map((_, t) => Object.values(s.pools).reduce((a, p) => a + (p.counts[t] || 0), 0));
    return s.pools[group].counts.slice();
  }

  // 초기 계급 자동 배정 (반마다 따로)
  // - 그 반의 첫 집계를 열기 전: 출석한 사람을 나이 많은 순 -> 입학 빠른 순으로 줄 세워 위 계급부터 정원만큼 채우고, 나머지는 맨 아래 계급
  //   (명단·출석·정원이 바뀔 때마다 다시 계산한다)
  // - 첫 집계가 시작된 뒤: 계급은 점수로만 움직인다. 늦게 온 사람(새로 추가되거나 출석 처리된 사람)은 맨 아래 계급에서 시작한다.
  function refreshTiers() {
    const last = getSettings().tiers.length - 1;
    const groups = {};
    for (const p of active()) (groups[groupOf(p)] = groups[groupOf(p)] || []).push(p);
    for (const g of Object.keys(groups)) {
      if (gr(g).round === 0) {
        const order = groups[g].slice().sort((a, b) =>
          SP.dateKey(a.birth) - SP.dateKey(b.birth) || SP.dateKey(a.enroll) - SP.dateKey(b.enroll) || a.n - b.n || a.id.localeCompare(b.id));
        const sizes = groupSizes(g);
        const cum = [];
        sizes.reduce((acc, v, i) => (cum[i] = acc + v), 0);
        order.forEach((p, i) => {
          let t = 0;
          while (t < last && i >= cum[t]) t++;
          Object.assign(p, { t0: t, cls: t, prevCls: t, change: 'none' });
        });
      } else {
        for (const p of groups[g]) {
          if (!p.started) { Object.assign(p, { t0: last, cls: last, prevCls: last, change: 'none', started: true }); }
        }
      }
    }
  }

  // 순위와 계급 정하기 (한 반, 또는 통합 후 전체)
  // - 순위: 점수가 같으면 공동 순위 (1, 2, 2, 4 ...)
  // - 계급: 계급별 인원(정원)은 설정에서 바꾸지 않는 한 항상 그대로다. 점수 순으로 한 줄을 세워 정원만큼 위에서부터 계급을 나눈다.
  // - 동점자끼리의 줄 세우기: 1순위 기존 계급 유지(원래 높은 계급에 있던 사람이 먼저), 2순위 생년월일(나이 많은 순), 3순위 기수(입학 빠른 순).
  //   마지막으로 번호·아이디 순. 동점자가 계급 경계에 걸리면 이 순서대로 윗 계급 자리를 채운다.
  const tieOrder = (a, b) =>
    a.cls - b.cls ||
    SP.dateKey(a.birth) - SP.dateKey(b.birth) ||
    SP.dateKey(a.enroll) - SP.dateKey(b.enroll) ||
    a.n - b.n ||
    a.id.localeCompare(b.id);

  function rankAndClassify(g) {
    const fresh = !!gr(g).fresh; // 통합 직후 첫 집계: 반 안의 순위와 통합 순위는 비교할 수 없어서 순위 변화를 표시하지 않는다
    const sorted = activeIn(g).sort((a, b) => b.score - a.score);
    const sizes = groupSizes(g);
    const cum = [];
    sizes.reduce((acc, v, i) => (cum[i] = acc + v), 0);
    const nominal = (i) => { let t = 0; while (t < sizes.length - 1 && i >= cum[t]) t++; return t; };
    let lo = 0;
    while (lo < sorted.length) {
      let hi = lo;
      while (hi + 1 < sorted.length && sorted[hi + 1].score === sorted[lo].score) hi++;
      // p.cls 는 아직 직전 집계의 계급이다 (줄을 다 세운 뒤에 바꾼다)
      const line = sorted.slice(lo, hi + 1).sort(tieOrder);
      line.forEach((p, k) => {
        const prev = p.cls;
        p.prevCls = prev;
        p.cls = nominal(lo + k);
        p.prevRank = fresh || p.rank == null ? null : p.rank; // 직전 집계 때의 순위 (순위 변화 표시용)
        p.rank = lo + 1;
        p.tied = hi > lo;
        p.groupSize = sorted.length;
        p.change = p.cls < prev ? 'up' : p.cls > prev ? 'down' : 'stay';
      });
      lo = hi + 1;
    }
  }

  // 이번 라운드에 제출된 칩 (그 반 사람의 것만)
  const currentSubs = (g) => Object.fromEntries(Object.entries(subs).filter(([pid, v]) => v && v.round === gr(g).round && inGroup(pid, g)));
  const clearSubs = (g) => { for (const pid of Object.keys(subs)) if (!byId(pid) || inGroup(pid, g)) delete subs[pid]; };

  // ---- 집계 흐름 (반마다 따로)
  function openTally(g) {
    const gs = gr(g);
    if (gs.open) throw new Error('이미 집계가 열려 있어요');
    if (core.merge && core.merge[g]) throw new Error('합치기를 눌러 둔 상태예요. 합치기를 취소한 뒤에 집계를 시작하세요');
    if (gs.round === 0) refreshTiers();
    gs.round += 1;
    for (const p of activeIn(g)) p.started = true;
    clearSubs(g);
    gs.bonus = {};
    gs.open = true;
  }

  function cancelOpen(g) {
    const gs = gr(g);
    if (!gs.open) throw new Error('열린 집계가 없어요');
    if (Object.keys(currentSubs(g)).length || Object.keys(gs.bonus).length) {
      throw new Error('이미 제출된 내용이 있어서 취소할 수 없어요. 마감 후 되돌리기를 사용하세요');
    }
    gs.open = false;
    gs.round = Math.max(0, gs.round - 1);
  }

  function closeTally(g) {
    const gs = gr(g);
    if (!gs.open) throw new Error('열린 집계가 없어요');
    const s = getSettings();
    const cur = currentSubs(g);
    const before = {};
    for (const p of members(g)) {
      before[p.id] = {
        cls: p.cls, rank: p.rank, prevRank: p.prevRank, tied: p.tied, groupSize: p.groupSize, prevCls: p.prevCls, change: p.change,
        chips: p.chips, base: p.base, bonusN: p.bonusN, score: p.score, missing: p.missing,
      };
    }
    const missing = [];
    for (const p of activeIn(g)) {
      const sub = cur[p.id];
      if (sub) {
        p.chips = sub.chips.slice(0, s.maxChips);
        p.base = SP.calcScore(p.chips, s.scoreTable).total; // 마감 시점의 점수표로 재계산
        p.missing = false;
      } else {
        p.missing = true; // 미제출: 이전 칩/점수 유지
        missing.push(p.id);
      }
      // 보너스 칩: 진행자가 직접 입력한 값이 있으면 그 값, 없으면 참가자가 낸 값, 미제출이면 이전 값을 유지
      const ov = gs.bonus[p.id];
      p.bonusN = ov !== undefined ? Number(ov) || 0 : sub ? Number(sub.bonus) || 0 : (p.bonusN || 0);
      p.score = p.base + p.bonusN * s.bonusValue;
    }
    const fresh = !!gs.fresh;
    rankAndClassify(g);
    const results = activeIn(g).map((p) => ({
      pid: p.id, name: p.name, group: groupOf(p), score: p.score, base: p.base, bonusN: p.bonusN, chips: p.chips,
      rank: p.rank, prevRank: p.prevRank == null ? null : p.prevRank, tied: p.tied, groupSize: p.groupSize, from: p.prevCls, to: p.cls, missing: p.missing,
    }));
    const summary = {
      up: results.filter((r) => r.to < r.from).length,
      down: results.filter((r) => r.to > r.from).length,
      stay: results.filter((r) => r.to === r.from).length,
      missing: missing.length,
    };
    histOf(g).push({
      id: ++core.nextHist, group: g, round: gs.round, closedAt: Date.now(), results, summary,
      table: clone(s.scoreTable), bonusValue: s.bonusValue, merged: s.merged, fresh,
      before, submissions: clone(cur), bonus: clone(gs.bonus),
    });
    gs.fresh = false;
    clearSubs(g);
    gs.open = false;
    gs.tallyCount += 1;
  }

  function undoLast(g) {
    const gs = gr(g);
    if (gs.open) throw new Error('집계가 열려 있어요. 먼저 마감하거나 취소하세요');
    const h = histOf(g).pop();
    if (!h) throw new Error('되돌릴 집계가 없어요');
    for (const p of members(g)) if (h.before[p.id]) Object.assign(p, h.before[p.id]);
    gs.round = h.round;
    clearSubs(g);
    Object.assign(subs, h.submissions || {});
    gs.bonus = h.bonus || {};
    gs.open = true;
    gs.tallyCount = Math.max(0, gs.tallyCount - 1);
    gs.fresh = !!h.fresh;
  }

  // ---- 게임 종료 (반마다 따로)
  // 종료하면 최종 결과 화면이 열리고 집계·명단·계급 변경이 잠긴다. 종료 취소로 다시 이어갈 수 있다.
  // 참가자 화면은 기록(history)을 읽지 않으므로, 사람별 라운드 이동 기록은 종료 시점에 함께 저장해 둔다.
  function endGame(g) {
    const gs = gr(g);
    if (gs.ended) throw new Error('이미 종료된 게임이에요');
    if (gs.open) throw new Error('집계가 열려 있어요. 먼저 마감하거나 취소하세요');
    if (!histOf(g).length) throw new Error('마감된 집계가 없어서 종료할 수 없어요');
    if (core.merge && core.merge[g]) throw new Error('합치기를 눌러 둔 상태예요. 합치기를 취소한 뒤에 종료하세요');
    const journeys = {};
    for (const h of allHistory()) {
      for (const r of h.results) {
        if (!inGroup(r.pid, g)) continue;
        const j = (journeys[r.pid] = journeys[r.pid] || []);
        if (!j.length) j.push({ r: 0, tier: r.from, rank: null, score: null, tied: false });
        j.push({ r: h.round, tier: r.to, rank: r.rank, score: r.score, tied: !!r.tied, missing: !!r.missing });
      }
    }
    gs.ended = { at: Date.now(), round: gs.round, journeys };
  }

  function reopenGame(g) {
    const gs = gr(g);
    if (!gs.ended) throw new Error('종료된 게임이 아니에요');
    gs.ended = null;
  }

  function finalView(p) {
    const g = groupOf(p);
    const ended = gr(g).ended;
    const j = (ended && ended.journeys[p.id]) || [];
    const mates = activeIn(g);
    const tierCounts = getSettings().tiers.map((_, t) => mates.filter((x) => x.cls === t).length);
    let moves = 0, ups = 0, downs = 0, best = null;
    for (let i = 1; i < j.length; i++) {
      if (j[i].tier < j[i - 1].tier) { moves++; ups++; } else if (j[i].tier > j[i - 1].tier) { moves++; downs++; }
    }
    for (const e of j) if (e.rank != null && (best === null || e.rank < best.rank)) best = { rank: e.rank, round: e.r };
    return { journey: j, moves, ups, downs, best, tierCounts, groupSize: mates.length, rounds: ended.round };
  }

  const resetProgress = (p) => Object.assign(p, {
    cls: p.t0, rank: null, prevRank: null, tied: false, groupSize: null, prevCls: p.t0, change: 'none', started: false,
    chips: [], base: 0, bonusN: 0, score: 0, missing: false,
  });

  // 게임 초기화: 통합 전에는 내 반만, 통합 후에는 전체를 처음 상태로 되돌린다 (통합도 풀린다)
  function resetGame(scope) {
    const s = getSettings();
    if (s.merged) {
      for (const p of core.participants) resetProgress(p);
      for (const g of GROUPS) { core.games[g] = freshGame(); histOf(g).length = 0; }
      clearObj(subs);
      s.merged = false;
      core.merge = { find: false, kku: false };
    } else {
      for (const p of core.participants) if (p.pool === scope) resetProgress(p);
      core.games[scope] = freshGame();
      histOf(scope).length = 0;
      clearSubs(scope);
      core.merge[scope] = false;
    }
    refreshTiers();
  }

  // ---- 두 반 합치기 (쉬는시간 뒤)
  // 양쪽 진행자가 모두 '합치기'를 누르면 찾는·여는반 진행자 화면 하나로 통합된다. 계급과 점수는 그대로 이어지고,
  // 통합 첫 라운드 번호는 두 반의 마지막 라운드 중 큰 쪽 다음 번호다.
  function setMergeReady(scope, ready) {
    const s = getSettings();
    if (s.merged) throw new Error('이미 하나로 합쳐졌어요');
    if (!core.merge) core.merge = { find: false, kku: false };
    const gs = gr(scope);
    if (ready) {
      if (gs.open) throw new Error('집계가 열려 있어요. 마감한 뒤에 합치기를 눌러주세요');
      if (gs.ended) throw new Error('종료된 상태예요. 종료를 취소한 뒤에 합치기를 눌러주세요');
      core.merge[scope] = true;
    } else core.merge[scope] = false;
    if (core.merge.find && core.merge.kku) doMerge();
  }

  function doMerge() {
    const s = getSettings();
    s.merged = true;
    core.games.all = Object.assign(freshGame(), {
      round: Math.max(gr('find').round, gr('kku').round),
      tallyCount: Math.max(gr('find').tallyCount, gr('kku').tallyCount),
      fresh: true,
    });
    core.merge = { find: false, kku: false };
    clearObj(subs);
  }

  // ---- 참가자 관리
  function pinTaken(name, pin, exceptId) {
    const nn = normName(name);
    return core.participants.some((p) => p.id !== exceptId && p.name && normName(p.name) === nn && p.pin === pin);
  }
  function randomPin(name, exceptId) {
    for (let i = 0; i < 300; i++) {
      const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      if (!pinTaken(name, pin, exceptId)) return pin;
    }
    throw new Error('같은 이름이 너무 많아서 PIN을 만들 수 없어요');
  }

  function updateParticipant(pid, f) {
    const p = byId(pid);
    if (!p) throw new Error('없는 참가자예요');
    const name = f.name !== undefined ? String(f.name).trim() : p.name;
    if (!name) throw new Error('이름은 비울 수 없어요. 명단에서 빼려면 삭제나 결석 처리를 사용하세요');
    let pin = f.pin !== undefined ? String(f.pin).trim() : p.pin;
    if (!pin) pin = randomPin(name, pid);
    // 예전(2자리)으로 발급된 PIN은 그대로 둘 때만 허용한다. 새로 입력하는 PIN은 4자리여야 한다.
    if (!/^\d{4}$/.test(pin) && pin !== p.pin) throw new Error('PIN은 숫자 4자리여야 해요');
    if (pinTaken(name, pin, pid)) throw new Error('같은 이름과 PIN 조합이 이미 있어요. PIN을 바꿔주세요');
    p.name = name;
    p.pin = pin;
    if (f.birth !== undefined) p.birth = String(f.birth).trim();
    if (f.enroll !== undefined) p.enroll = String(f.enroll).trim();
  }

  function createPerson(pool, f) {
    if (!getSettings().pools[pool]) throw new Error('없는 반이에요');
    const name = String(f.name || '').trim();
    if (!name) throw new Error('이름을 입력해주세요');
    const last = getSettings().tiers.length - 1;
    let id;
    do { id = `${pool}-${core.nextId++}`; } while (byId(id));
    const n = 1 + core.participants.filter((x) => x.pool === pool).reduce((m, x) => Math.max(m, x.n), 0);
    const p = newPerson(pool, id, n, last);
    p.name = name;
    p.birth = String(f.birth || '').trim();
    p.enroll = String(f.enroll || '').trim();
    const pin = String(f.pin || '').trim();
    if (pin && !/^\d{4}$/.test(pin)) throw new Error('PIN은 숫자 4자리여야 해요');
    if (pin && pinTaken(name, pin, id)) throw new Error('같은 이름과 PIN 조합이 이미 있어요. PIN을 바꿔주세요');
    core.participants.push(p);
    p.pin = pin || randomPin(name, id);
    return p;
  }

  function importPeople(pool, text) {
    if (!getSettings().pools[pool]) throw new Error('없는 반이에요');
    const people = String(text || '').split(/\r?\n/).map((line) => {
      const cols = line.split(/\t|,|\s{2,}/).map((c) => c.trim());
      return { name: cols[0] || '', birth: cols[1] || '', enroll: cols[2] || '' };
    }).filter((x) => x.name);
    if (!people.length) throw new Error('붙여넣은 명단이 비어 있어요');
    let added = 0;
    for (const person of people) {
      // 같은 반에 같은 이름·생년월일이 이미 있으면 중복으로 보고 건너뜀 (명단을 두 번 붙여넣었을 때를 대비)
      const dup = core.participants.some((x) => x.pool === pool && normName(x.name) === normName(person.name) && x.birth === person.birth);
      if (dup) continue;
      createPerson(pool, person); added++;
    }
    return added;
  }

  // ---- 설정
  function validateSettings(patch) {
    const s = getSettings();
    const next = clone(s);
    if (patch.maxChips !== undefined) {
      const m = Math.floor(Number(patch.maxChips));
      if (!(m >= 1 && m <= 10)) throw new Error('칩 최대 개수는 1~10이어야 해요');
      next.maxChips = m;
    }
    if (patch.bonusValue !== undefined) {
      const v = Number(patch.bonusValue);
      if (!Number.isFinite(v) || v < 0) throw new Error('보너스 칩 점수가 올바르지 않아요');
      next.bonusValue = v;
    }
    if (patch.maxBonus !== undefined) {
      const m = Math.floor(Number(patch.maxBonus));
      if (!(m >= 0 && m <= 50)) throw new Error('보너스 칩 최대 개수는 0~50이어야 해요');
      next.maxBonus = m;
    }
    if (patch.scoreTable) {
      for (const c of next.colors) {
        const arr = patch.scoreTable[c.key];
        if (arr) {
          if (!Array.isArray(arr) || arr.some((x) => !Number.isFinite(Number(x)))) throw new Error('점수표 값이 올바르지 않아요');
          next.scoreTable[c.key] = arr.map(Number);
        }
      }
    }
    // 칩 최대 개수에 맞게 점수표 길이 정리. 늘어난 칸은 이렇게 채운다:
    //  - 5개까지: 문서의 점수표 값 (그 색의 기본값이 없으면 1개 점수 x 개수)
    //  - 6개 이상(n개): '5개 점수 + (n-5)개 점수'  (예: 하양 6개 = 16 + 1 = 17)
    for (const c of next.colors) {
      const arr = next.scoreTable[c.key] || [];
      const def = SP.DEFAULT_TABLE[c.key];
      while (arr.length < next.maxChips) {
        const n = arr.length + 1;
        arr.push(n <= 5 ? (def && def[n - 1] !== undefined ? def[n - 1] : (arr[0] || 0) * n) : arr[4] + arr[n - 6]);
      }
      next.scoreTable[c.key] = arr.slice(0, next.maxChips);
    }
    if (patch.tiers) {
      if (!Array.isArray(patch.tiers) || patch.tiers.length !== next.tiers.length) throw new Error('계급 설정이 올바르지 않아요');
      next.tiers = patch.tiers.map((t, i) => ({
        name: String(t.name || '').trim() || next.tiers[i].name,
        symbol: String(t.symbol || '').trim() || next.tiers[i].symbol,
        color: /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : next.tiers[i].color,
      }));
    }
    if (patch.pools) {
      for (const key of Object.keys(next.pools)) {
        const pp = patch.pools[key];
        if (!pp) continue;
        if (pp.name !== undefined) next.pools[key].name = String(pp.name).trim() || next.pools[key].name;
        if (pp.short !== undefined) next.pools[key].short = String(pp.short).trim() || next.pools[key].short;
        if (pp.counts !== undefined) {
          if (!Array.isArray(pp.counts) || pp.counts.length !== next.tiers.length) throw new Error('계급 인원이 올바르지 않아요');
          next.pools[key].counts = pp.counts.map((n) => Math.max(0, Math.floor(Number(n)) || 0));
        }
      }
    }
    if (patch.alerts) {
      const a = next.alerts || (next.alerts = defaultSettings().alerts);
      const pa = patch.alerts;
      const num1 = (v, label) => { const n = Number(v); if (!Number.isFinite(n) || n < 1 || n > 1000) throw new Error(`${label}은 1 이상의 숫자로 입력해주세요`); return n; };
      if (pa.highNoBonus) {
        if (pa.highNoBonus.on !== undefined) a.highNoBonus.on = !!pa.highNoBonus.on;
        if (pa.highNoBonus.score !== undefined) a.highNoBonus.score = num1(pa.highNoBonus.score, '기준 점수');
      }
      if (pa.bonusTotal && pa.bonusTotal.on !== undefined) a.bonusTotal.on = !!pa.bonusTotal.on;
      if (pa.scoreJump) {
        if (pa.scoreJump.on !== undefined) a.scoreJump.on = !!pa.scoreJump.on;
        if (pa.scoreJump.delta !== undefined) a.scoreJump.delta = num1(pa.scoreJump.delta, '점수 변동 기준');
      }
    }
    if (patch.merged !== undefined) next.merged = !!patch.merged;
    if (patch.sizeOverride) {
      for (const g of ['find', 'kku', 'all']) {
        if (!(g in patch.sizeOverride)) continue;
        const v = patch.sizeOverride[g];
        if (v === null) next.sizeOverride[g] = null;
        else {
          if (!Array.isArray(v) || v.length !== next.tiers.length || v.some((n) => !(Number(n) >= 0))) {
            throw new Error('계급 인원이 올바르지 않아요');
          }
          next.sizeOverride[g] = v.map((n) => Math.floor(Number(n)));
        }
      }
    }
    return next;
  }

  // 설정 저장. 반 이름·정원은 내 반 것만, 계급 인원 직접 설정은 내 반(통합 후에는 전체) 것만 바뀐다.
  // 두 반을 합치는 것은 설정이 아니라 양쪽의 '합치기' 버튼으로만 된다.
  function saveSettings(patch, scope) {
    const s = getSettings();
    const p = Object.assign({}, patch);
    delete p.merged;
    if (p.pools) p.pools = Object.fromEntries(Object.entries(p.pools).filter(([k]) => s.merged || k === scope));
    if (p.sizeOverride) {
      const g = s.merged ? 'all' : scope;
      p.sizeOverride = Object.fromEntries(Object.entries(p.sizeOverride).filter(([k]) => k === g));
    }
    core.settings = validateSettings(p);
  }

  function validateChips(chips) {
    const s = getSettings();
    if (!Array.isArray(chips)) throw new Error('칩 정보가 올바르지 않아요');
    if (chips.length > s.maxChips) throw new Error(`칩은 최대 ${s.maxChips}개까지 입력할 수 있어요`);
    const keys = new Set(s.colors.map((c) => c.key));
    if (chips.some((c) => !keys.has(c))) throw new Error('알 수 없는 칩 색상이에요');
    return chips.slice();
  }

  // ---- 참가자용
  function findLogin(name, pin) {
    return active().find((x) => normName(x.name) === normName(name) && x.pin === String(pin || '').trim()) || null;
  }

  function meView(p) {
    const s = getSettings();
    const g = groupOf(p);
    const gs = gr(g);
    const sub = gs.open ? currentSubs(g)[p.id] : null;
    return {
      me: {
        id: p.id, label: labelOf(p), name: p.name, tier: p.cls, prevTier: p.prevCls, change: p.change,
        rank: p.rank, prevRank: p.prevRank == null ? null : p.prevRank, tied: !!p.tied, groupSize: p.groupSize, score: p.score, base: p.base, bonusN: p.bonusN,
        chips: p.chips, missing: p.missing, jailed: !!p.jailed, hasResult: gs.tallyCount > 0 && p.rank !== null,
      },
      round: gs.round, open: gs.open, tallyCount: gs.tallyCount,
      ended: gs.ended ? { at: gs.ended.at } : null,
      final: gs.ended && p.rank !== null ? finalView(p) : null,
      submission: sub ? { chips: sub.chips, bonus: Number(sub.bonus) || 0 } : null,
      poolName: s.merged ? '전체' : s.pools[p.pool].name,
      config: { tiers: s.tiers, colors: s.colors, scoreTable: s.scoreTable, maxChips: s.maxChips, bonusValue: s.bonusValue, maxBonus: s.maxBonus },
    };
  }

  function submit(p, chips, bonus) {
    const gs = gr(groupOf(p));
    if (!gs.open) { const e = new Error('지금은 점수를 입력할 수 없어요'); e.status = 409; throw e; }
    if (p.jailed) { const e = new Error('수감 중이라 칩을 입력할 수 없어요'); e.status = 409; throw e; }
    const valid = validateChips(chips);
    const maxBonus = getSettings().maxBonus;
    const b = bonus === undefined || bonus === null || bonus === '' ? 0 : Number(bonus);
    if (!Number.isInteger(b) || b < 0 || b > maxBonus) throw new Error(`보너스 칩은 0~${maxBonus}개로 입력해주세요`);
    if (!valid.length && !b) throw new Error('칩을 1개 이상 입력해주세요');
    subs[p.id] = { chips: valid, bonus: b, ts: Date.now(), by: 'self', round: gs.round };
  }

  // 참가자가 지금 집계에 칩을 낼 수 있는지 (api.js 가 제출 칩을 읽을지 정할 때 사용)
  const isOpenFor = (p) => gr(groupOf(p)).open;

  // ---- 진행자용
  // 진행자는 반 하나를 맡는다(scope: 'find' | 'kku'). 두 반이 합쳐진 뒤에는 찾는·여는반 진행자만 진행하고 꾸는반 진행자는 보기만 한다.
  const viewGroup = (scope) => (getSettings().merged ? 'all' : scope);
  const readOnly = (scope) => getSettings().merged && scope !== 'find';
  const ownsPerson = (p, scope) => (getSettings().merged ? scope === 'find' : p.pool === scope);
  const need = (p, scope) => { if (!p) throw new Error('없는 아이디예요'); if (!ownsPerson(p, scope)) throw new Error('다른 반 참가자는 이 화면에서 바꿀 수 없어요'); return p; };

  // 진행자가 직접 입력한 보너스 칩이 있으면 그 값, 없으면 참가자가 제출한 값
  function effectiveBonus(g) {
    const gs = gr(g);
    const out = {};
    if (!gs.open) return Object.assign(out, gs.bonus);
    for (const [pid, sub] of Object.entries(currentSubs(g))) if (Number(sub.bonus)) out[pid] = Number(sub.bonus);
    for (const [pid, n] of Object.entries(gs.bonus)) out[pid] = n;
    return out;
  }

  // 집계 도중 이상 징후(부정행위 의심) 찾기. 지금 제출된 칩과 직전 마감 상태를 비교한다. 제출한 사람만 본다(미제출자는 점수가 그대로이므로).
  function anomalies(g) {
    const s = getSettings(), gs = gr(g), al = s.alerts;
    if (!gs.open || !al) return [];
    const cur = currentSubs(g);
    const list = activeIn(g);
    const bonusOf = (p) => { const ov = gs.bonus[p.id]; if (ov !== undefined) return Number(ov) || 0; const sub = cur[p.id]; return sub ? Number(sub.bonus) || 0 : (p.bonusN || 0); };
    const baseOf = (p) => (cur[p.id] ? SP.calcScore(cur[p.id].chips, s.scoreTable).total : p.base);
    const baseTotal = list.reduce((a, p) => a + (p.bonusN || 0), 0);
    const newTotal = list.reduce((a, p) => a + bonusOf(p), 0);
    const everGranted = baseTotal > 0 || GROUPS.some((k) => histOf(k).some((h) => h.results.some((r) => r.bonusN > 0)));
    const grantRound = !everGranted && newTotal > 0; // 보너스 칩이 처음 지급되는 라운드
    const out = [];
    if (al.highNoBonus.on) {
      for (const p of list) {
        if (!cur[p.id] || p.cls < 1 || bonusOf(p) !== 0) continue;
        const base = baseOf(p);
        if (base > al.highNoBonus.score) {
          out.push({ key: `hn:${p.id}:${base}`, type: 'highNoBonus', pid: p.id, name: p.name,
            text: `${s.tiers[p.cls].name} 계급인데 보너스 칩 없이 칩 점수가 ${base}점이에요 (기준 ${al.highNoBonus.score}점 초과)` });
        }
      }
    }
    if (al.bonusTotal.on && everGranted && newTotal !== baseTotal) {
      const moved = list.filter((p) => bonusOf(p) !== (p.bonusN || 0)).map((p) => `${p.name} ${(p.bonusN || 0)}→${bonusOf(p)}`);
      out.push({ key: `bt:${g}:${baseTotal}:${newTotal}`, type: 'bonusTotal', name: g === 'all' ? '전체' : s.pools[g].name,
        text: `보너스 칩 총량이 ${baseTotal}개에서 ${newTotal}개로 바뀌었어요`, detail: moved.slice(0, 8).join(', ') + (moved.length > 8 ? ` 외 ${moved.length - 8}명` : '') });
    }
    if (al.scoreJump.on && !grantRound) {
      for (const p of list) {
        if (!cur[p.id] || p.rank == null) continue; // 첫 라운드(비교할 이전 점수 없음)는 제외
        const now = baseOf(p) + bonusOf(p) * s.bonusValue;
        const d = now - p.score;
        if (Math.abs(d) >= al.scoreJump.delta) {
          out.push({ key: `sj:${p.id}:${now}`, type: 'scoreJump', pid: p.id, name: p.name,
            text: `점수가 ${p.score}점에서 ${now}점으로 ${d > 0 ? '올랐어요' : '내렸어요'} (${d > 0 ? '+' : ''}${d}점, 기준 ${al.scoreJump.delta}점 이상)` });
        }
      }
    }
    return out;
  }

  function adminView(extra, scope) {
    scope = scope === 'kku' ? 'kku' : 'find';
    const s = getSettings();
    const g = viewGroup(scope);
    const gs = gr(g);
    const mine = s.merged ? core.participants : core.participants.filter((p) => p.pool === scope);
    const hist = (s.merged ? allHistory() : histOf(g).slice());
    const other = scope === 'find' ? 'kku' : 'find';
    return Object.assign({
      scope, viewGroup: g, readOnly: readOnly(scope),
      settings: core.settings, participants: mine, round: gs.round, open: gs.open,
      ended: gs.ended ? { at: gs.ended.at, round: gs.ended.round } : null,
      submissions: gs.open ? currentSubs(g) : {}, bonus: effectiveBonus(g), alerts: anomalies(g),
      merge: s.merged ? { done: true } : {
        done: false, mine: !!core.merge[scope],
        other: { pool: other, name: s.pools[other].name, ready: !!core.merge[other], round: gr(other).round, open: gr(other).open, ended: !!gr(other).ended },
      },
      history: hist.map((h) => ({
        id: h.id, group: h.group, round: h.round, closedAt: h.closedAt, results: h.results, summary: h.summary, table: h.table, merged: h.merged,
      })),
      labels: Object.fromEntries(mine.map((p) => [p.id, labelOf(p)])),
    }, extra || {});
  }

  // 종료된 게임에서 막는 동작 (결과가 바뀌는 것들). 종료 취소 후에 다시 쓸 수 있다.
  const LOCKED_WHEN_ENDED = ['open', 'cancelOpen', 'close', 'undo', 'setClass', 'setRound', 'addPerson', 'importPeople', 'removePerson', 'setPresent', 'setScore', 'setJailed', 'releaseAll', 'setBonus', 'setChips', 'clearSub', 'setMergeReady'];
  const READONLY_ALLOWED = [];

  function adminAction(a, scope) {
    scope = scope === 'kku' ? 'kku' : 'find';
    if (readOnly(scope) && !READONLY_ALLOWED.includes(a.type)) throw new Error('두 반이 합쳐진 뒤에는 찾는·여는반 진행자 화면에서 진행해요. 이 화면은 보기 전용이에요');
    const s = getSettings();
    const g = viewGroup(scope);
    const gs = gr(g);
    if (gs.ended && LOCKED_WHEN_ENDED.includes(a.type)) throw new Error('종료된 게임이에요. 계속하려면 먼저 ‘종료 취소’를 눌러주세요');
    switch (a.type) {
      case 'open': openTally(g); break;
      case 'cancelOpen': cancelOpen(g); break;
      case 'close': closeTally(g); break;
      case 'undo': {
        if (core.merge && core.merge[scope]) throw new Error('합치기를 눌러 둔 상태예요. 합치기를 취소한 뒤에 되돌리세요');
        undoLast(g);
        break;
      }
      case 'endGame': endGame(g); break;
      case 'reopenGame': reopenGame(g); break;
      case 'setMergeReady': setMergeReady(scope, !!a.ready); break;
      case 'setBonus': {
        if (!gs.open) throw new Error('집계가 열려 있을 때만 입력할 수 있어요');
        need(byId(a.pid), scope);
        gs.bonus[a.pid] = Math.max(0, Math.floor(Number(a.n)) || 0);
        break;
      }
      case 'setChips': {
        if (!gs.open) throw new Error('집계가 열려 있을 때만 입력할 수 있어요');
        need(byId(a.pid), scope);
        subs[a.pid] = { chips: validateChips(a.chips), bonus: Number((currentSubs(g)[a.pid] || {}).bonus) || 0, ts: Date.now(), by: 'admin', round: gs.round };
        break;
      }
      case 'clearSub': need(byId(a.pid), scope); delete subs[a.pid]; break;
      // 집계 중이 아닐 때 참가자의 칩·보너스 칩을 고친다. 점수만 바뀌고 순위와 계급은 다음 마감 때까지 그대로다.
      // 가장 최근 마감 기록의 점수도 같이 고쳐서 결과 탭에 반영한다(순위·계급은 기록 그대로).
      case 'setScore': {
        if (gs.open) throw new Error('집계 중에는 ‘입력/수정’으로 칩을 고치세요');
        const p = need(byId(a.pid), scope);
        const chips = validateChips(a.chips);
        const b = Number(a.bonus === undefined || a.bonus === '' ? p.bonusN : a.bonus);
        if (!Number.isInteger(b) || b < 0 || b > 999) throw new Error('보너스 칩은 0~999개로 입력해주세요');
        p.chips = chips;
        p.base = SP.calcScore(chips, s.scoreTable).total;
        p.bonusN = b;
        p.score = p.base + b * s.bonusValue;
        let last = null;
        for (const k of GROUPS) for (const h of histOf(k)) if (h.results.some((r) => r.pid === p.id) && (!last || h.closedAt >= last.closedAt)) last = h;
        if (last) {
          const row = last.results.find((r) => r.pid === p.id);
          Object.assign(row, { chips: chips.slice(), base: p.base, bonusN: b, score: p.score, edited: true });
        }
        break;
      }
      case 'updateParticipant': need(byId(a.pid), scope); updateParticipant(a.pid, a.fields || {}); break;
      case 'importPeople':
        if (!s.merged && a.pool !== scope) throw new Error('이 화면에서는 내 반 명단만 추가할 수 있어요');
        importPeople(a.pool, a.text);
        break;
      case 'addPerson':
        if (!s.merged && a.pool !== scope) throw new Error('이 화면에서는 내 반 참가자만 추가할 수 있어요');
        createPerson(a.pool, a);
        break;
      case 'removePerson': {
        const p = need(byId(a.pid), scope);
        core.participants = core.participants.filter((x) => x.id !== a.pid);
        delete subs[a.pid]; delete gr(groupOf(p)).bonus[a.pid];
        break;
      }
      case 'setPresent': {
        const p = need(byId(a.pid), scope);
        p.present = !!a.present;
        if (!p.present) { delete subs[a.pid]; delete gr(groupOf(p)).bonus[a.pid]; }
        break;
      }
      // 감옥: 수감된 참가자는 칩을 제출할 수 없다(제출하지 않은 사람처럼 이전 칩과 점수가 유지됨). 순위와 계급 이동은 그대로 계산된다.
      case 'setJailed': {
        const p = need(byId(a.pid), scope);
        p.jailed = !!a.jailed;
        if (p.jailed) delete subs[a.pid]; // 이번 집계에 이미 낸 칩은 취소
        break;
      }
      case 'releaseAll': {
        for (const p of members(g)) p.jailed = false;
        break;
      }
      case 'regeneratePins': {
        const list = members(g).filter((p) => p.present !== false);
        for (const p of list) p.pin = '';
        for (const p of list) p.pin = randomPin(p.name, p.id);
        break;
      }
      case 'setClass': {
        const p = need(byId(a.pid), scope);
        const t = Number(a.tier);
        if (!(t >= 0 && t < s.tiers.length)) throw new Error('없는 계급이에요');
        p.prevCls = p.cls; p.cls = t; p.change = t < p.prevCls ? 'up' : t > p.prevCls ? 'down' : 'stay';
        break;
      }
      case 'saveSettings': saveSettings(a.patch || {}, scope); break;
      case 'resetScoreTable': core.settings.colors = clone(SP.DEFAULT_COLORS); core.settings.scoreTable = clone(SP.DEFAULT_TABLE); core.settings.maxChips = 5; break;
      case 'setRound': {
        const r = Math.floor(Number(a.round));
        if (!(r >= 0)) throw new Error('라운드 번호가 올바르지 않아요');
        gs.round = r;
        break;
      }
      case 'setPassword': {
        const pw = String(a.password || '');
        if (pw.length < 4) throw new Error('비밀번호는 4자 이상이어야 해요');
        core.adminPassword = pw;
        break;
      }
      case 'resetGame': resetGame(scope); break;
      case 'resetAll': {
        if (scope !== 'find') throw new Error('전체 초기화는 찾는·여는반 진행자 화면에서만 할 수 있어요');
        const fresh = freshCore(core.adminPassword);
        fresh.secret = core.secret; // 진행자 로그인은 유지
        for (const k of Object.keys(core)) delete core[k];
        Object.assign(core, fresh);
        clearObj(subs);
        for (const k of GROUPS) histOf(k).length = 0;
        break;
      }
      default: throw new Error('알 수 없는 동작이에요');
    }
    refreshTiers();
  }

  return { labelOf, findLogin, meView, submit, isOpenFor, adminView, adminAction, byId };
}

module.exports = { makeGame, freshCore, freshGame, defaultSettings, normName, clone };
