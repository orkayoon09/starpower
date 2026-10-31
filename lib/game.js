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
      { name: '네모', symbol: '■', color: '#7c3aed' },
      { name: '세모', symbol: '▲', color: '#0d9488' },
      { name: '동그라미', symbol: '●', color: '#ea580c' },
    ],
    pools: {
      find: { name: '찾는·여는반', short: '찾여', counts: [4, 14, 0], bonus: 4 },
      kku: { name: '꾸는반', short: '꾸', counts: [3, 10, 0], bonus: 3 },
    },
    bonusAll: 4, // 한 반으로 통합했을 때 계급별 보너스 칩 수(안내용)
    bonusValue: 3, // 보너스 칩 1개 점수
    maxBonus: 10, // 참가자가 한 번에 입력할 수 있는 보너스 칩 최대 개수
    colors: clone(SP.DEFAULT_COLORS),
    scoreTable: clone(SP.DEFAULT_TABLE),
    maxChips: 5,
    merged: false,
    // 계급별 인원: 맨 아래 계급을 뺀 위쪽 계급은 정원이 고정이고, 맨 아래 계급은 '나머지 전원'이다 (counts 의 마지막 값은 쓰지 않음)
    // sizeOverride 가 null 이면 pools[*].counts 를 사용
    sizeOverride: { find: null, kku: null, all: null },
  };
}

function newPerson(pool, id, n, lastTier) {
  return {
    id, pool, t0: lastTier, n,
    name: '', pin: '', birth: '', enroll: '', present: true, started: false,
    cls: lastTier, rank: null, tied: false, groupSize: null, prevCls: lastTier, change: 'none',
    chips: [], base: 0, bonusN: 0, score: 0, missing: false,
  };
}

function freshCore(adminPassword) {
  const core = {
    settings: defaultSettings(),
    participants: [],
    round: 0,
    open: false,
    bonus: {},
    tallyCount: 0,
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
    if (!core.nextId) core.nextId = 1;
    const last = s.tiers.length - 1;
    const started = core.round > 0 || core.tallyCount > 0;
    if (core.participants.some((p) => !p.name)) core.participants = core.participants.filter((p) => p.name); // 이름 없는 빈 아이디 제거
    for (const p of core.participants) {
      if (p.present === undefined) p.present = true;
      if (p.started === undefined) p.started = started;
      if (p.tied === undefined) p.tied = false;
      if (!(p.n >= 0)) p.n = 0;
    }
    void last;
  }
  migrate();

  function labelOf(p) {
    const s = getSettings();
    return `${s.pools[p.pool].short}-${p.n}`;
  }
  const active = () => core.participants.filter((p) => p.name && p.present !== false);
  const groupOf = (p) => (getSettings().merged ? 'all' : p.pool);
  const byId = (id) => core.participants.find((p) => p.id === id);

  function groupSizes(group) {
    const s = getSettings();
    const ov = s.sizeOverride[group];
    if (Array.isArray(ov) && ov.length === s.tiers.length) return ov.map(Number);
    if (group === 'all') return s.tiers.map((_, t) => Object.values(s.pools).reduce((a, p) => a + (p.counts[t] || 0), 0));
    return s.pools[group].counts.slice();
  }

  // 정렬 순서(표시용): 점수 -> 나이 많은 순 -> 입학 빠른 순 -> 아이디 순
  function compareParticipants(a, b) {
    return (
      b.score - a.score ||
      SP.dateKey(a.birth) - SP.dateKey(b.birth) ||
      SP.dateKey(a.enroll) - SP.dateKey(b.enroll) ||
      a.id.localeCompare(b.id)
    );
  }

  // 초기 계급 자동 배정
  // - 첫 집계를 열기 전: 출석한 사람을 나이 많은 순 -> 입학 빠른 순으로 줄 세워 위 계급부터 정원만큼 채우고, 나머지는 맨 아래 계급
  //   (명단·출석·정원이 바뀔 때마다 다시 계산한다)
  // - 첫 집계가 시작된 뒤: 계급은 점수로만 움직인다. 늦게 온 사람(새로 추가되거나 출석 처리된 사람)은 맨 아래 계급에서 시작한다.
  function refreshTiers() {
    const last = getSettings().tiers.length - 1;
    const act = active();
    if (core.round === 0) {
      const groups = {};
      for (const p of act) (groups[groupOf(p)] = groups[groupOf(p)] || []).push(p);
      for (const g of Object.keys(groups)) {
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
      }
    } else {
      for (const p of act) {
        if (!p.started) { Object.assign(p, { t0: last, cls: last, prevCls: last, change: 'none', started: true }); }
      }
    }
  }

  // 순위와 계급 정하기
  // - 점수가 같으면 공동 순위 (1, 2, 2, 4 ...)
  // - 계급은 순위대로 인원만큼 나누되, 동점자가 계급 경계에 걸치면 각자 원래 계급에 가장 가까운 계급을 유지한다.
  //   (이때 계급별 인원은 기본 정원과 달라질 수 있다)
  function rankAndClassify() {
    const groups = {};
    for (const p of active()) (groups[groupOf(p)] = groups[groupOf(p)] || []).push(p);
    for (const g of Object.keys(groups)) {
      const sorted = groups[g].slice().sort(compareParticipants);
      const sizes = groupSizes(g);
      const cum = [];
      sizes.reduce((acc, v, i) => (cum[i] = acc + v), 0);
      const nominal = (i) => { let t = 0; while (t < sizes.length - 1 && i >= cum[t]) t++; return t; };
      let lo = 0;
      while (lo < sorted.length) {
        let hi = lo;
        while (hi + 1 < sorted.length && sorted[hi + 1].score === sorted[lo].score) hi++;
        const minT = nominal(lo), maxT = nominal(hi);
        for (let i = lo; i <= hi; i++) {
          const p = sorted[i];
          const prev = p.cls;
          p.prevCls = prev;
          p.cls = Math.min(maxT, Math.max(minT, prev));
          p.rank = lo + 1;
          p.tied = hi > lo;
          p.groupSize = sorted.length;
          p.change = p.cls < prev ? 'up' : p.cls > prev ? 'down' : 'stay';
        }
        lo = hi + 1;
      }
    }
  }

  const clearObj = (o) => { for (const k of Object.keys(o)) delete o[k]; };
  const currentSubs = () => Object.fromEntries(Object.entries(subs).filter(([, v]) => v && v.round === core.round));

  // ---- 집계 흐름
  function openTally() {
    if (core.open) throw new Error('이미 집계가 열려 있어요');
    if (core.round === 0) refreshTiers();
    core.round += 1;
    for (const p of active()) p.started = true;
    clearObj(subs);
    core.bonus = {};
    core.open = true;
  }

  function cancelOpen() {
    if (!core.open) throw new Error('열린 집계가 없어요');
    if (Object.keys(currentSubs()).length || Object.keys(core.bonus).length) {
      throw new Error('이미 제출된 내용이 있어서 취소할 수 없어요. 마감 후 되돌리기를 사용하세요');
    }
    core.open = false;
    core.round = Math.max(0, core.round - 1);
  }

  function closeTally() {
    if (!core.open) throw new Error('열린 집계가 없어요');
    const s = getSettings();
    const cur = currentSubs();
    const before = {};
    for (const p of core.participants) {
      before[p.id] = {
        cls: p.cls, rank: p.rank, tied: p.tied, groupSize: p.groupSize, prevCls: p.prevCls, change: p.change,
        chips: p.chips, base: p.base, bonusN: p.bonusN, score: p.score, missing: p.missing,
      };
    }
    const missing = [];
    for (const p of active()) {
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
      const ov = core.bonus[p.id];
      p.bonusN = ov !== undefined ? Number(ov) || 0 : sub ? Number(sub.bonus) || 0 : (p.bonusN || 0);
      p.score = p.base + p.bonusN * s.bonusValue;
    }
    rankAndClassify();
    const results = active().map((p) => ({
      pid: p.id, name: p.name, group: groupOf(p), score: p.score, base: p.base, bonusN: p.bonusN, chips: p.chips,
      rank: p.rank, tied: p.tied, groupSize: p.groupSize, from: p.prevCls, to: p.cls, missing: p.missing,
    }));
    const summary = {
      up: results.filter((r) => r.to < r.from).length,
      down: results.filter((r) => r.to > r.from).length,
      stay: results.filter((r) => r.to === r.from).length,
      missing: missing.length,
    };
    history.push({
      round: core.round, closedAt: Date.now(), results, summary,
      table: clone(s.scoreTable), bonusValue: s.bonusValue, merged: s.merged,
      before, submissions: clone(cur), bonus: clone(core.bonus),
    });
    clearObj(subs);
    core.open = false;
    core.tallyCount = history.length;
  }

  function undoLast() {
    if (core.open) throw new Error('집계가 열려 있어요. 먼저 마감하거나 취소하세요');
    const h = history.pop();
    if (!h) throw new Error('되돌릴 집계가 없어요');
    for (const p of core.participants) Object.assign(p, h.before[p.id] || {});
    core.round = h.round;
    clearObj(subs);
    Object.assign(subs, h.submissions || {});
    core.bonus = h.bonus || {};
    core.open = true;
    core.tallyCount = history.length;
  }

  function resetGame() {
    for (const p of core.participants) {
      Object.assign(p, {
        cls: p.t0, rank: null, tied: false, groupSize: null, prevCls: p.t0, change: 'none', started: false,
        chips: [], base: 0, bonusN: 0, score: 0, missing: false,
      });
    }
    core.round = 0; core.open = false; core.bonus = {}; core.tallyCount = 0;
    clearObj(subs);
    history.length = 0;
    refreshTiers();
  }

  // ---- 참가자 관리
  function pinTaken(name, pin, exceptId) {
    const nn = normName(name);
    return core.participants.some((p) => p.id !== exceptId && p.name && normName(p.name) === nn && p.pin === pin);
  }
  function randomPin(name, exceptId) {
    for (let i = 0; i < 300; i++) {
      const pin = String(crypto.randomInt(0, 100)).padStart(2, '0');
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
    if (!/^\d{2}$/.test(pin)) throw new Error('PIN은 숫자 2자리여야 해요');
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
    if (pin && !/^\d{2}$/.test(pin)) throw new Error('PIN은 숫자 2자리여야 해요');
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
    // 칩 최대 개수에 맞게 점수표 길이 정리 (늘어난 칸은 1개 점수 x 개수로 채움)
    for (const c of next.colors) {
      const arr = next.scoreTable[c.key] || [];
      while (arr.length < next.maxChips) arr.push((arr[0] || 0) * (arr.length + 1));
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
        if (pp.bonus !== undefined) next.pools[key].bonus = Math.max(0, Math.floor(Number(pp.bonus)) || 0);
        if (pp.counts !== undefined) {
          if (!Array.isArray(pp.counts) || pp.counts.length !== next.tiers.length) throw new Error('계급 인원이 올바르지 않아요');
          next.pools[key].counts = pp.counts.map((n) => Math.max(0, Math.floor(Number(n)) || 0));
        }
      }
    }
    if (patch.bonusAll !== undefined) next.bonusAll = Math.max(0, Math.floor(Number(patch.bonusAll)) || 0);
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

  function saveSettings(patch) {
    core.settings = validateSettings(patch);
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
    const sub = core.open ? currentSubs()[p.id] : null;
    return {
      me: {
        id: p.id, label: labelOf(p), name: p.name, tier: p.cls, prevTier: p.prevCls, change: p.change,
        rank: p.rank, tied: !!p.tied, groupSize: p.groupSize, score: p.score, base: p.base, bonusN: p.bonusN,
        chips: p.chips, missing: p.missing, hasResult: core.tallyCount > 0 && p.rank !== null,
      },
      round: core.round, open: core.open, tallyCount: core.tallyCount,
      submission: sub ? { chips: sub.chips, bonus: Number(sub.bonus) || 0 } : null,
      poolName: s.merged ? '전체' : s.pools[p.pool].name,
      config: { tiers: s.tiers, colors: s.colors, scoreTable: s.scoreTable, maxChips: s.maxChips, bonusValue: s.bonusValue, maxBonus: s.maxBonus },
    };
  }

  function submit(p, chips, bonus) {
    if (!core.open) { const e = new Error('지금은 점수를 입력할 수 없어요'); e.status = 409; throw e; }
    const valid = validateChips(chips);
    const maxBonus = getSettings().maxBonus;
    const b = bonus === undefined || bonus === null || bonus === '' ? 0 : Number(bonus);
    if (!Number.isInteger(b) || b < 0 || b > maxBonus) throw new Error(`보너스 칩은 0~${maxBonus}개로 입력해주세요`);
    if (!valid.length && !b) throw new Error('칩을 1개 이상 입력해주세요');
    subs[p.id] = { chips: valid, bonus: b, ts: Date.now(), by: 'self', round: core.round };
  }

  // ---- 관리자용
  // 진행자가 직접 입력한 보너스 칩이 있으면 그 값, 없으면 참가자가 제출한 값
  function effectiveBonus() {
    const out = {};
    if (!core.open) return Object.assign(out, core.bonus);
    for (const [pid, sub] of Object.entries(currentSubs())) if (Number(sub.bonus)) out[pid] = Number(sub.bonus);
    for (const [pid, n] of Object.entries(core.bonus)) out[pid] = n;
    return out;
  }

  function adminView(extra) {
    return Object.assign({
      settings: core.settings, participants: core.participants, round: core.round, open: core.open,
      submissions: core.open ? currentSubs() : {}, bonus: effectiveBonus(),
      history: history.map((h) => ({
        round: h.round, closedAt: h.closedAt, results: h.results, summary: h.summary, table: h.table, merged: h.merged,
      })),
      labels: Object.fromEntries(core.participants.map((p) => [p.id, labelOf(p)])),
    }, extra || {});
  }

  function adminAction(a) {
    switch (a.type) {
      case 'open': openTally(); break;
      case 'cancelOpen': cancelOpen(); break;
      case 'close': closeTally(); break;
      case 'undo': undoLast(); break;
      case 'setBonus': {
        if (!core.open) throw new Error('집계가 열려 있을 때만 입력할 수 있어요');
        if (!byId(a.pid)) throw new Error('없는 아이디예요');
        core.bonus[a.pid] = Math.max(0, Math.floor(Number(a.n)) || 0);
        break;
      }
      case 'setChips': {
        if (!core.open) throw new Error('집계가 열려 있을 때만 입력할 수 있어요');
        if (!byId(a.pid)) throw new Error('없는 아이디예요');
        subs[a.pid] = { chips: validateChips(a.chips), bonus: Number((currentSubs()[a.pid] || {}).bonus) || 0, ts: Date.now(), by: 'admin', round: core.round };
        break;
      }
      case 'clearSub': delete subs[a.pid]; break;
      case 'updateParticipant': updateParticipant(a.pid, a.fields || {}); break;
      case 'importPeople': importPeople(a.pool, a.text); break;
      case 'addPerson': createPerson(a.pool, a); break;
      case 'removePerson': {
        const p = byId(a.pid);
        if (!p) throw new Error('없는 참가자예요');
        core.participants = core.participants.filter((x) => x.id !== a.pid);
        delete subs[a.pid]; delete core.bonus[a.pid];
        break;
      }
      case 'setPresent': {
        const p = byId(a.pid);
        if (!p) throw new Error('없는 참가자예요');
        p.present = !!a.present;
        if (!p.present) { delete subs[a.pid]; delete core.bonus[a.pid]; }
        break;
      }
      case 'regeneratePins':
        for (const p of active()) p.pin = '';
        for (const p of active()) p.pin = randomPin(p.name, p.id);
        break;
      case 'setClass': {
        const p = byId(a.pid);
        if (!p) throw new Error('없는 아이디예요');
        const t = Number(a.tier);
        if (!(t >= 0 && t < getSettings().tiers.length)) throw new Error('없는 계급이에요');
        p.prevCls = p.cls; p.cls = t; p.change = t < p.prevCls ? 'up' : t > p.prevCls ? 'down' : 'stay';
        break;
      }
      case 'saveSettings': saveSettings(a.patch || {}); break;
      case 'resetScoreTable': core.settings.scoreTable = clone(SP.DEFAULT_TABLE); core.settings.maxChips = 5; break;
      case 'setRound': {
        const r = Math.floor(Number(a.round));
        if (!(r >= 0)) throw new Error('라운드 번호가 올바르지 않아요');
        core.round = r;
        break;
      }
      case 'setPassword': {
        const pw = String(a.password || '');
        if (pw.length < 4) throw new Error('비밀번호는 4자 이상이어야 해요');
        core.adminPassword = pw;
        break;
      }
      case 'resetGame': resetGame(); break;
      case 'resetAll': {
        const fresh = freshCore(core.adminPassword);
        fresh.secret = core.secret; // 진행자 로그인은 유지
        for (const k of Object.keys(core)) delete core[k];
        Object.assign(core, fresh);
        clearObj(subs);
        history.length = 0;
        break;
      }
      default: throw new Error('알 수 없는 동작이에요');
    }
    refreshTiers();
  }

  return { labelOf, findLogin, meView, submit, adminView, adminAction, byId };
}

module.exports = { makeGame, freshCore, defaultSettings, normName, clone };
