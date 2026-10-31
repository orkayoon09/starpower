// Netlify 함수(netlify/functions/api.mjs)를 진짜 @netlify/blobs 클라이언트 + 로컬 Blobs 서버로 검증: node test/simulate-netlify.js
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert');
const { run } = require('./scenario');

(async () => {
  const { BlobsServer } = await import('@netlify/blobs/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spb-'));
  const token = 'test-token';
  const bs = new BlobsServer({ directory: dir, token, port: 0 });
  const { port: bport } = await bs.start();
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: `http://localhost:${bport}`, uncachedEdgeURL: `http://localhost:${bport}`, token, siteID: 'test-site' })).toString('base64');
  process.env.ADMIN_PASSWORD = 'env-admin-pw';
  const fn = (await import('../netlify/functions/api.mjs')).default;

  // Netlify 가 하듯이 Request 를 만들어 함수에 넘기는 어댑터
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await fn(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    await run(`http://127.0.0.1:${srv.address().port}`, { password: 'env-admin-pw', push: false });
    console.log('\n모든 검증 통과 (Netlify 함수 + Blobs)');
    process.exit(0);
  } catch (e) { console.error('FAIL', e.stack || e); process.exit(1); }
})();
