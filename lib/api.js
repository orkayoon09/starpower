'use strict';
/*
 * API 처리 (HTTP 서버 종류와 저장소 종류에 상관없이 동일하게 동작)
 *
 * handle(ctx, req) -> { status, body, changed }
 *   ctx.store               저장소 (아래 인터페이스, 모두 async)
 *   ctx.adminPasswordEnv    환경변수로 지정한 진행자 비밀번호 (없으면 null)
 *   ctx.requirePasswordEnv  true 면 환경변수 없이는 진행자 로그인 불가 (서버리스 환경)
 *   ctx.push                true 면 서버가 SSE 로 변경을 알려줌, false 면 화면이 주기적으로 갱신
 *   ctx.extras()            진행자 화면에 덧붙일 정보 (접속 주소 등)
 *   req = { method, path, token, body }
 *
 * 저장소 인터페이스
 *   getCore()/setCore(obj)          게임 상태 본체 (참가자, 설정, 반별 라운드 ...)
 *   getCoreV() -> {core, ver}       본체와 버전 (동시에 두 진행자가 저장할 때 충돌을 알아내기 위함)
 *   createCore(obj) -> bool         본체가 아직 없을 때만 만든다
 *   setCoreIf(obj, ver) -> bool     읽은 뒤 아무도 바꾸지 않았을 때만 저장한다
 *   getHistory(g)/setHistory(g,arr) 반별('find'|'kku'|'all') 마감된 집계 기록
 *   getSub(pid)/setSub(pid,obj)/delSub(pid)/listSubs()   이번 라운드 제출 칩 (참가자별로 따로 저장)
 *   getMisc(key)/setMisc(key,obj)   로그인 실패 횟수 등
 *
 * 참가자가 하는 일(로그인, 내 정보 조회, 칩 제출)은 본체를 읽기만 하고 자기 제출 칩만 쓰기 때문에
 * 여러 명이 동시에 제출해도 서로 덮어쓰지 않는다. 본체는 진행자만 수정한다.
 */
const crypto = require('crypto');
const { makeGame, freshCore, normName } = require('./game');
const VERSION = require('./version.js');

// ---------------------------------------------------------------- 토큰 (서명만 하고 서버에는 저장하지 않음)
const b64 = (s) => Buffer.from(s).toString('base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 10);

function signToken(core, payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${hmac(core.secret, body)}`;
}
function readToken(core, token) {
  if (!token || typeof token !== 'string' || !core.secret) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = hmac(core.secret, body);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
}

const effectivePassword = (ctx, core) => ctx.adminPasswordEnv || core.adminPassword;
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- 저장 (변경된 부분만)
const GROUPS = ['find', 'kku', 'all'];

async function loadCoreV(ctx) {
  for (let i = 0; i < 3; i++) {
    const r = await ctx.store.getCoreV();
    if (r && r.core) return r;
    await ctx.store.createCore(freshCore(ctx.adminPasswordEnv)); // 동시에 처음 접속해도 하나만 만들어진다
  }
  throw new Error('저장소를 초기화하지 못했어요');
}
// 참가자 요청은 버전이 필요 없으므로 본체만 읽는다 (읽기 한 번)
async function loadCore(ctx) {
  for (let i = 0; i < 3; i++) {
    const core = await ctx.store.getCore();
    if (core) return core;
    await ctx.store.createCore(freshCore(ctx.adminPasswordEnv));
  }
  throw new Error('저장소를 초기화하지 못했어요');
}

// groups: 불러올 기록 묶음. 상태만 볼 때는 내 반(통합 후에는 전체)만, 바꿀 때는 전부 읽는다.
async function loadAll(ctx, groupsFor) {
  const { core, ver } = await loadCoreV(ctx);
  const groups = typeof groupsFor === 'function' ? groupsFor(core) : GROUPS;
  const [hs, subs] = await Promise.all([Promise.all(groups.map((g) => ctx.store.getHistory(g))), ctx.store.listSubs()]);
  const history = {};
  groups.forEach((g, i) => { history[g] = hs[i] || []; });
  return { core, ver, history, subs: subs || {} };
}

function snapshot({ core, history, subs }) {
  return {
    core: JSON.stringify(core),
    history: Object.fromEntries(Object.entries(history).map(([g, v]) => [g, JSON.stringify(v)])),
    subs: Object.fromEntries(Object.entries(subs).map(([k, v]) => [k, JSON.stringify(v)])),
  };
}

// 본체를 먼저, 읽은 뒤 아무도 바꾸지 않았을 때만 저장한다. 다른 진행자가 먼저 저장했으면 false 를 돌려주고 아무것도 쓰지 않는다.
async function persist(ctx, before, { core, ver, history, subs }) {
  const st = ctx.store;
  if (JSON.stringify(core) !== before.core) { if (!(await st.setCoreIf(core, ver))) return false; }
  const writes = [];
  for (const g of Object.keys(history)) if (JSON.stringify(history[g]) !== before.history[g]) writes.push(st.setHistory(g, history[g]));
  for (const pid of Object.keys(before.subs)) if (!(pid in subs)) writes.push(st.delSub(pid));
  for (const pid of Object.keys(subs)) if (JSON.stringify(subs[pid]) !== before.subs[pid]) writes.push(st.setSub(pid, subs[pid]));
  await Promise.all(writes);
  return true;
}

// ---------------------------------------------------------------- 로그인 실패 제한
async function throttled(ctx, key) {
  const f = await ctx.store.getMisc('fail:' + key);
  return !!(f && f.until > Date.now());
}
async function noteFailure(ctx, key) {
  const k = 'fail:' + key;
  const f = (await ctx.store.getMisc(k)) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 8) { f.until = Date.now() + 60000; f.n = 0; }
  await ctx.store.setMisc(k, f);
}

// ---------------------------------------------------------------- 요청 처리
const ok = (body, changed) => ({ status: 200, body, changed: !!changed });
const fail = (status, error) => ({ status, body: { error }, changed: false });

async function handle(ctx, req) {
  const { method, path } = req;
  const body = req.body || {};
  try {
    if (method === 'GET' && path === '/api/health') return ok({ ok: true, push: !!ctx.push, version: VERSION });

    // ---- 참가자: 로그인
    if (method === 'POST' && path === '/api/login') {
      const core = await loadCore(ctx);
      const key = 'p:' + normName(body.name);
      if (await throttled(ctx, key)) return fail(429, '잠시 후 다시 시도해주세요');
      const game = makeGame({ core, history: {}, subs: {} });
      const found = game.findLogin(body.name, body.pin);
      if (!found) { await noteFailure(ctx, key); return fail(401, '이름 또는 번호가 맞지 않아요'); }
      return ok({ token: signToken(core, { r: 'p', pid: found.id }) });
    }

    // ---- 참가자: 내 정보 / 제출
    if ((method === 'GET' && path === '/api/me') || (method === 'POST' && path === '/api/submit')) {
      const core = await loadCore(ctx);
      const tk = readToken(core, req.token);
      const me = tk && tk.r === 'p' ? core.participants.find((x) => x.id === tk.pid && x.name && x.present !== false) : null;
      if (!me) return fail(401, 'login');
      const subs = {};
      const game = makeGame({ core, history: {}, subs });
      if (game.isOpenFor(me)) { const s = await ctx.store.getSub(me.id); if (s) subs[me.id] = s; }
      let changed = false;
      if (path === '/api/submit') {
        game.submit(me, body.chips, body.bonus);
        await ctx.store.setSub(me.id, subs[me.id]);
        changed = true;
      }
      return ok(Object.assign(game.meView(me), { push: !!ctx.push, version: VERSION }), changed);
    }

    // ---- 진행자: 로그인
    if (method === 'POST' && path === '/api/admin/login') {
      const core = await loadCore(ctx);
      if (ctx.requirePasswordEnv && !ctx.adminPasswordEnv) {
        return fail(500, '진행자 비밀번호가 설정되지 않았어요. Netlify 환경변수 ADMIN_PASSWORD 를 추가한 뒤 다시 배포하세요');
      }
      if (await throttled(ctx, 'admin')) return fail(429, '잠시 후 다시 시도해주세요');
      const pw = effectivePassword(ctx, core);
      if (!safeEqual(body.password || '', pw)) { await noteFailure(ctx, 'admin'); return fail(401, '비밀번호가 맞지 않아요'); }
      const scope = body.scope === 'kku' ? 'kku' : 'find'; // 진행자가 맡는 반
      return ok({ token: signToken(core, { r: 'a', v: sha(pw), s: scope }), scope });
    }

    // ---- 진행자: 상태 / 동작
    if (path === '/api/admin/state' || path === '/api/admin/action') {
      const isAction = method === 'POST' && path === '/api/admin/action';
      const extras = () => Object.assign({ push: !!ctx.push, version: VERSION, passwordFromEnv: !!ctx.adminPasswordEnv }, ctx.extras ? ctx.extras() : {});
      const auth = (core) => {
        const tk = readToken(core, req.token);
        if (!tk || tk.r !== 'a' || tk.v !== sha(effectivePassword(ctx, core))) return null;
        return tk.s === 'kku' ? 'kku' : 'find';
      };
      if (method === 'GET' && path === '/api/admin/state') {
        // 상태 조회: 내 반 기록만 읽는다 (통합 후에는 전체)
        const all = await loadAll(ctx, (core) => (core.settings.merged ? GROUPS : [auth(core) || 'find']));
        const scope = auth(all.core);
        if (!scope) return fail(401, 'login');
        return ok(makeGame(all).adminView(extras(), scope));
      }
      if (isAction) {
        if (body.type === 'setPassword' && ctx.adminPasswordEnv) {
          return fail(400, '비밀번호가 환경변수(ADMIN_PASSWORD)로 지정돼 있어요. 호스팅 설정에서 바꿔주세요');
        }
        // 두 진행자가 동시에 저장하면 나중에 저장하는 쪽이 충돌을 알아채고, 최신 상태에서 같은 동작을 다시 시도한다
        for (let attempt = 0; attempt < 5; attempt++) {
          const all = await loadAll(ctx);
          const scope = auth(all.core);
          if (!scope) return fail(401, 'login');
          const game = makeGame(all);
          const before = snapshot(all);
          game.adminAction(body, scope);
          if (await persist(ctx, before, all)) return ok(game.adminView(extras(), scope), true);
        }
        return fail(409, '다른 진행자가 동시에 작업하고 있어요. 잠시 뒤에 다시 눌러주세요');
      }
    }
    return fail(404, 'not found');
  } catch (e) {
    return fail(e.status || 400, e.message || '오류가 발생했어요');
  }
}

module.exports = { handle, loadCore };
