// Netlify 함수: /api/* 요청을 처리한다. 데이터는 Netlify Blobs 에 저장된다.
// 로직은 lib/ 안의 코드를 노트북 서버(server.js)와 똑같이 사용한다.
import { getStore } from '@netlify/blobs';
import api from '../../lib/api.js';

// 진행자 화면이 자주 조회하는 '제출된 칩'은 etag 가 같으면 다시 읽지 않도록 인스턴스 메모리에 둔다.
const subCache = new Map();

class BlobStore {
  // 요청마다 새로 만든다. Netlify 가 요청마다 주는 접근 토큰은 시간이 지나면 만료되므로,
  // 함수가 처음 켜졌을 때 만든 클라이언트를 계속 쓰면 'Token expired' 오류가 난다.
  // strong: 방금 쓴 값이 바로 모든 요청에서 보이도록 (기본값은 최대 60초 지연될 수 있음)
  get s() { return getStore({ name: 'starpower', consistency: 'strong' }); }
  async getCore() { return (await this.s.get('core', { type: 'json' })) ?? null; }
  async setCore(o) { await this.s.setJSON('core', o); }
  // etag 를 버전으로 쓴다: 읽은 뒤 다른 진행자가 저장했으면 저장이 거절된다
  async getCoreV() {
    const r = await this.s.getWithMetadata('core', { type: 'json' });
    if (!r) return { core: null, ver: null };
    if (r.etag) return { core: r.data, ver: r.etag };
    // 응답에서 etag 를 못 받는 환경에서는 목록의 etag 를 먼저 읽고 그 다음에 본문을 읽는다.
    // 그 사이에 다른 진행자가 저장했다면 etag 가 더 오래된 것이라 저장이 거절되고, 최신 상태로 다시 시도한다.
    const { blobs } = await this.s.list({ prefix: 'core' });
    const e = blobs.find((b) => b.key === 'core');
    const data = await this.s.get('core', { type: 'json' });
    return { core: data, ver: e ? e.etag : undefined };
  }
  async createCore(o) { return (await this.s.setJSON('core', o, { onlyIfNew: true })).modified; }
  async setCoreIf(o, ver) { return (await this.s.setJSON('core', o, { onlyIfMatch: ver })).modified; }
  async getHistory(g) { return (await this.s.get('history/' + g, { type: 'json' })) ?? []; }
  async setHistory(g, a) { await this.s.setJSON('history/' + g, a); }
  async getSub(pid) { return (await this.s.get('sub/' + pid, { type: 'json' })) ?? null; }
  async setSub(pid, o) { subCache.delete('sub/' + pid); await this.s.setJSON('sub/' + pid, o); }
  async delSub(pid) { subCache.delete('sub/' + pid); await this.s.delete('sub/' + pid); }
  async listSubs() {
    const { blobs } = await this.s.list({ prefix: 'sub/' });
    const out = {};
    const live = new Set(blobs.map((b) => b.key));
    for (const k of subCache.keys()) if (!live.has(k)) subCache.delete(k);
    await Promise.all(blobs.map(async (b) => {
      const hit = subCache.get(b.key);
      if (hit && hit.etag === b.etag) { out[b.key.slice(4)] = structuredClone(hit.data); return; }
      const data = await this.s.get(b.key, { type: 'json' });
      if (data) { subCache.set(b.key, { etag: b.etag, data }); out[b.key.slice(4)] = structuredClone(data); }
    }));
    return out;
  }
  async getMisc(k) { return (await this.s.get('misc/' + encodeURIComponent(k), { type: 'json' })) ?? null; }
  async setMisc(k, v) { await this.s.setJSON('misc/' + encodeURIComponent(k), v); }
}

const ctx = {
  store: new BlobStore(),
  adminPasswordEnv: process.env.ADMIN_PASSWORD || null,
  requirePasswordEnv: true, // 서버 로그를 볼 수 없으므로 비밀번호는 반드시 환경변수로 지정
  push: false,              // 실시간 푸시 대신 화면이 주기적으로 갱신
};

export default async (req) => {
  const url = new URL(req.url);
  let body = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch (e) { body = {}; }
  }
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const r = await api.handle(ctx, { method: req.method, path: url.pathname, token, body });
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};

export const config = { path: '/api/*' };
