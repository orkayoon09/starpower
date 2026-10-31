'use strict';
/* 파일 저장소: 메모리에 두고 data/state.json 에 저장 (노트북에서 직접 실행할 때 사용) */
const fs = require('fs');
const path = require('path');

class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.core = null;       // JSON 문자열
    this.history = '[]';    // JSON 문자열
    this.subs = {};         // { pid: JSON 문자열 }
    this.misc = new Map();  // 저장하지 않는 값 (로그인 실패 횟수)
    this.timer = null;
    this._load();
  }

  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && d.core) {
        this.core = JSON.stringify(d.core);
        this.history = JSON.stringify(d.history || []);
        this.subs = Object.fromEntries(Object.entries(d.subs || {}).map(([k, v]) => [k, JSON.stringify(v)]));
      }
    } catch (e) { /* 파일이 없으면 새로 시작 */ }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer); this.timer = null;
    fs.mkdirSync(this.dir, { recursive: true });
    const subs = Object.entries(this.subs).map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',');
    const text = `{"core":${this.core || 'null'},"history":${this.history},"subs":{${subs}}}`;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, this.file);
  }

  async getCore() { return this.core ? JSON.parse(this.core) : null; }
  async setCore(o) { this.core = JSON.stringify(o); this.save(); }
  async getHistory() { return JSON.parse(this.history); }
  async setHistory(a) { this.history = JSON.stringify(a); this.save(); }
  async getSub(pid) { return this.subs[pid] ? JSON.parse(this.subs[pid]) : null; }
  async setSub(pid, o) { this.subs[pid] = JSON.stringify(o); this.save(); }
  async delSub(pid) { delete this.subs[pid]; this.save(); }
  async listSubs() { return Object.fromEntries(Object.entries(this.subs).map(([k, v]) => [k, JSON.parse(v)])); }
  async getMisc(k) { return this.misc.get(k) || null; }
  async setMisc(k, v) { this.misc.set(k, v); }
}

module.exports = { FileStore };
