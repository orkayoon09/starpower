// 노트북 서버(server.js)를 실제로 띄워서 60명 규모 흐름을 검증: node test/simulate.js
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert');
const { run } = require('./scenario');

const PORT = 3900 + Math.floor(Math.random() * 80);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const env = { ...process.env, PORT, DATA_DIR: dir };
  delete env.ADMIN_PASSWORD;
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'pipe' });
  let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 50 && !out.includes('실행 중'); i++) await sleep(100);
    assert(out.includes('실행 중'), 'server did not start: ' + out);
    const password = (out.match(/진행자 비밀번호\s+(\S+)/) || [])[1];
    assert(password, '터미널에 비밀번호가 표시돼야 함');
    await run(`http://127.0.0.1:${PORT}`, { password, push: true });
    srv.kill('SIGTERM'); await sleep(400);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.strictEqual(saved.core.participants.filter((p) => p.name).length, 61);
    assert(saved.history.length >= 1);
    console.log('OK 저장 파일 유지\n\n모든 검증 통과 (노트북 서버)');
    process.exit(0);
  } catch (e) { srv.kill(); console.error('FAIL', e.stack || e); process.exit(1); }
})();
