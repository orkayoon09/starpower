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
 *   getCore()/setCore(obj)          게임 상태 본체 (참가자, 설정, 라운드 ...)
 *   getHistory()/setHistory(arr)    마감된 집계 기록
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
async function loadCore(ctx) {
  let core = await ctx.store.getCore();
  if (!core) {
    core = freshCore(ctx.adminPasswordEnv);
    await ctx.store.setCore(core);
  }
  return core;
}

async function loadAll(ctx) {
  const [core, history, subs] = await Promise.all([loadCore(ctx), ctx.store.getHistory(), ctx.store.listSubs()]);
  return { core, history: history || [], subs: subs || {} };
}

function snapshot({ core, history, subs }) {
  return {
    core: JSON.stringify(core), history: JSON.stringify(history),
    subs: Object.fromEntries(Object.entries(subs).map(([k, v]) => [k, JSON.stringify(v)])),
  };
}

async function persist(ctx, before, { core, history, subs }) {
  const st = ctx.store;
  if (JSON.stringify(history) !== before.history) await st.setHistory(history);
  const writes = [];
  for (const pid of Object.keys(before.subs)) if (!(pid in subs)) writes.push(st.delSub(pid));
  for (const pid of Object.keys(subs)) if (JSON.stringify(subs[pid]) !== before.subs[pid]) writes.push(st.setSub(pid, subs[pid]));
  await Promise.all(writes);
  if (JSON.stringify(core) !== before.core) await st.setCore(core); // 본체는 마지막에 저장
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
      const game = makeGame({ core, history: [], subs: {} });
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
      if (core.open) { const s = await ctx.store.getSub(me.id); if (s) subs[me.id] = s; }
      const game = makeGame({ core, history: [], subs });
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
      return ok({ token: signToken(core, { r: 'a', v: sha(pw) }) });
    }

    // ---- 진행자: 상태 / 동작
    if (path === '/api/admin/state' || path === '/api/admin/action') {
      const all = await loadAll(ctx);
      const tk = readToken(all.core, req.token);
      if (!tk || tk.r !== 'a' || tk.v !== sha(effectivePassword(ctx, all.core))) return fail(401, 'login');
      const game = makeGame(all);
      const extras = () => Object.assign({ push: !!ctx.push, version: VERSION, passwordFromEnv: !!ctx.adminPasswordEnv }, ctx.extras ? ctx.extras() : {});
      if (method === 'GET' && path === '/api/admin/state') return ok(game.adminView(extras()));
      if (method === 'POST' && path === '/api/admin/action') {
        const before = snapshot(all);
        if (body.type === 'setPassword' && ctx.adminPasswordEnv) {
          return fail(400, '비밀번호가 환경변수(ADMIN_PASSWORD)로 지정돼 있어요. 호스팅 설정에서 바꿔주세요');
        }
        game.adminAction(body);
        await persist(ctx, before, all);
        return ok(game.adminView(extras()), true);
      }
    }
    return fail(404, 'not found');
  } catch (e) {
    return fail(e.status || 400, e.message || '오류가 발생했어요');
  }
}

module.exports = { handle, loadCore };
