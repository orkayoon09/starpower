// Netlify 함수(netlify/functions/api.mjs)를 진짜 @netlify/blobs 클라이언트 + 로컬 Blobs 서버로 검증: node test/simulate-netlify.js
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert');
const { run } = require('./scenario');
const { runPools } = require('./pools');

(async () => {
  const { BlobsServer } = await import('@netlify/blobs/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spb-'));
  const token = 'test-token';
  // 로컬 Blobs 서버는 '조건 확인 -> 저장' 사이에 다른 요청이 끼어들 수 있어서 진짜 Netlify 와 다르다.
  // 진짜 Netlify 의 조건부 저장(onlyIfMatch/onlyIfNew)은 서버에서 한 번에 처리된다고 문서에 나와 있으므로,
  // 시험에서는 저장 요청을 한 줄로 세워 그 동작을 흉내 낸다. (etag 가 수정 시각 기반이라 같은 ms 충돌도 피하려고 잠깐 쉰다)
  let chain = Promise.resolve();
  const origPut = BlobsServer.prototype.put;
  BlobsServer.prototype.put = function (req) {
    const run = chain.then(() => origPut.call(this, req)).then(async (r) => { await new Promise((ok) => setTimeout(ok, 3)); return r; });
    chain = run.catch(() => {});
    return run;
  };
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
    await runPools(`http://127.0.0.1:${srv.address().port}`, { password: 'env-admin-pw' });
    await run(`http://127.0.0.1:${srv.address().port}`, { password: 'env-admin-pw', push: false });
    console.log('\n모든 검증 통과 (Netlify 함수 + Blobs)');
    process.exit(0);
  } catch (e) { console.error('FAIL', e.stack || e); process.exit(1); }
})();
