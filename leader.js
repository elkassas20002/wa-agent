// Hostinger (LiteSpeed) may run several copies of this app at the same time, and it only lets each
// copy listen on one port. Only ONE copy may hold the WhatsApp session, otherwise WhatsApp keeps
// kicking them. Coordination is done through files in DATA_DIR:
//   leader.json  - which process is the leader (heartbeat every few seconds)
//   state.json   - WhatsApp connection state written by the leader
//   cmd/         - queue of actions (send message, change settings...) other copies ask the leader to run
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, reload, flush, DB_FILE } = require('./store');

const LOCK = path.join(DATA_DIR, 'leader.json');
const STATE = path.join(DATA_DIR, 'state.json');
const CMD_DIR = path.join(DATA_DIR, 'cmd');
fs.mkdirSync(CMD_DIR, { recursive: true });

const STALE_MS = 20000;
let isLeader = false;
let executor = null;
let onBecomeLeader = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function writeJSON(f, v) {
  const t = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(t, JSON.stringify(v));
  fs.renameSync(t, f);
}

async function heartbeat() {
  const cur = readJSON(LOCK);
  if (isLeader) {
    if (!cur || cur.pid === process.pid) { writeJSON(LOCK, { pid: process.pid, ts: Date.now() }); return; }
    console.log(`[pid ${process.pid}] another process (${cur.pid}) took leadership; exiting`);
    process.exit(0);
  }
  // Processes may live in separate sandboxes where PIDs can't be checked, so rely on the heartbeat age only.
  if (cur && cur.pid !== process.pid && Date.now() - cur.ts < STALE_MS) return;
  writeJSON(LOCK, { pid: process.pid, ts: Date.now() });
  await sleep(300 + Math.random() * 400);
  const again = readJSON(LOCK);
  if (!again || again.pid !== process.pid) return;
  isLeader = true;
  reload();
  console.log(`[pid ${process.pid}] became LEADER`);
  if (onBecomeLeader) onBecomeLeader();
}

// Leader: run queued commands from other copies
let busy = false;
async function processQueue() {
  if (!isLeader || busy || !executor) return;
  busy = true;
  try {
    const files = fs.readdirSync(CMD_DIR).filter((f) => f.endsWith('.req.json')).sort();
    for (const f of files) {
      const full = path.join(CMD_DIR, f);
      const working = full.replace('.req.json', '.work.json');
      try { fs.renameSync(full, working); } catch (_) { continue; }
      const cmd = readJSON(working);
      let res;
      try { res = { ok: true, data: await executor(cmd.type, cmd.args || {}) }; }
      catch (e) { res = { ok: false, error: e.message }; }
      flush();
      writeJSON(working.replace('.work.json', '.res.json'), res);
      try { fs.unlinkSync(working); } catch (_) {}
    }
    // clean old result files nobody picked up
    for (const f of fs.readdirSync(CMD_DIR)) {
      const full = path.join(CMD_DIR, f);
      try { if (Date.now() - fs.statSync(full).mtimeMs > 120000) fs.unlinkSync(full); } catch (_) {}
    }
  } finally { busy = false; }
}

// Any copy: run an action (directly if leader, otherwise through the queue)
async function run(type, args) {
  if (isLeader) { const r = await executor(type, args || {}); flush(); return r; }
  const id = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  writeJSON(path.join(CMD_DIR, id + '.req.json'), { type, args });
  const resFile = path.join(CMD_DIR, id + '.res.json');
  for (let i = 0; i < 100; i++) { // up to ~25s
    await sleep(250);
    const r = readJSON(resFile);
    if (r) {
      try { fs.unlinkSync(resFile); } catch (_) {}
      refresh(true);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    }
  }
  try { fs.unlinkSync(path.join(CMD_DIR, id + '.req.json')); } catch (_) {}
  throw new Error('الخادم مشغول أو يعيد التشغيل، حاول بعد ثوانٍ');
}

// Non-leader copies re-read the saved data when it changes
let lastMtime = 0;
function refresh(force) {
  if (isLeader) return;
  try {
    const m = fs.statSync(DB_FILE).mtimeMs;
    if (force || m !== lastMtime) { lastMtime = m; reload(); }
  } catch (_) {}
}

function writeState(s) { if (isLeader) { try { writeJSON(STATE, { ...s, ts: Date.now() }); } catch (_) {} } }
function readState() { return readJSON(STATE) || { status: 'starting' }; }

function start({ exec, becomeLeader }) {
  executor = exec;
  onBecomeLeader = becomeLeader;
  heartbeat();
  setInterval(heartbeat, 5000);
  setInterval(processQueue, 300);
}

module.exports = { start, run, refresh, writeState, readState, isLeader: () => isLeader };
