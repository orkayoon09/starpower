'use strict';
/*
 * 스타파워 점수 집계 서버 (노트북이나 일반 서버에서 직접 실행하는 방식)
 * - npm install 불필요, Node 18 이상
 * - 실행: node server.js   (기본 포트 3000, PORT 환경변수로 변경)
 * - 데이터는 data/state.json 에 저장되어 재시작해도 유지됨 (DATA_DIR 로 위치 변경)
 *
 * Netlify에 올릴 때는 이 파일 대신 netlify/functions/api.mjs 가 같은 로직(lib/)을 사용한다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { handle, loadCore } = require('./lib/api');
const { FileStore } = require('./lib/store-file');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new FileStore(DATA_DIR);
const ctx = {
  store,
  adminPasswordEnv: process.env.ADMIN_PASSWORD || null,
  requirePasswordEnv: false,
  push: true,
  extras: () => ({ urls: lanUrls(), port: PORT }),
};

function lanUrls() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  }
  return out;
}

// ---- 실시간 알림 (SSE)
const sseClients = new Set();
function broadcast() {
  const msg = `event: update\ndata: ${Date.now()}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch (e) { sseClients.delete(res); } }
}
setInterval(() => { for (const res of sseClients) { try { res.write(': ping\n\n'); } catch (e) { sseClients.delete(res); } } }, 25000);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('잘못된 요청이에요')); } });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const r = await handle(ctx, { method: req.method, path: url.pathname, token, body });
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(r.body));
      if (r.changed) broadcast();
      return;
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname === '/admin' ? '/admin.html' : url.pathname;
    file = path.normalize(decodeURIComponent(file));
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } catch (e) {
    if (!res.headersSent) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } else res.end();
  }
});

function shutdown() { try { store.flush(); } catch (e) {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
  loadCore(ctx).then((core) => {
    store.flush();
    server.listen(PORT, '0.0.0.0', () => {
      console.log('\n스타파워 점수 집계 서버가 실행 중이에요\n');
      console.log(`  진행자 화면   http://localhost:${PORT}/admin`);
      console.log(`  진행자 비밀번호  ${ctx.adminPasswordEnv || core.adminPassword}   (환경변수 ADMIN_PASSWORD 로 지정하거나 설정 탭에서 변경)`);
      const urls = lanUrls();
      console.log('\n  참가자 접속 주소 (같은 와이파이)');
      if (urls.length) urls.forEach((u) => console.log('   ', u)); else console.log(`    http://localhost:${PORT}`);
      console.log('');
    });
  });
}

module.exports = { server };
