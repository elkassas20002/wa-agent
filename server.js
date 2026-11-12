const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, save, getChat, DATA_DIR, DEFAULT_SETTINGS } = require('./store');
const wa = require('./wa');
const agent = require('./agent');
const leader = require('./leader');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set. Set it in the environment variables!');

// Session secret persisted in data dir
const SECRET_FILE = path.join(DATA_DIR, 'secret');
if (!fs.existsSync(SECRET_FILE)) {
  try { fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { flag: 'wx' }); } catch (_) {}
}
const SECRET = process.env.SESSION_SECRET || fs.readFileSync(SECRET_FILE, 'utf8').trim();
const TOKEN = crypto.createHmac('sha256', SECRET).update('admin:' + PASSWORD).digest('hex');

// ---------- actions that change data: always executed by the leader process ----------
async function exec(type, a) {
  switch (type) {
    case 'send':
      await wa.sendText(a.jid, a.text, 'panel');
      return { ok: true };
    case 'read':
      await wa.markRead(a.jid);
      return { ok: true };
    case 'update': {
      const c = getChat(a.jid);
      const b = a.body || {};
      if ('autoReply' in b) c.autoReply = !!b.autoReply;
      if ('important' in b) c.important = !!b.important;
      if ('needsHuman' in b) c.needsHuman = !!b.needsHuman;
      if (b.resume) c.pausedUntil = 0;
      if ('draft' in b) c.draft = String(b.draft || '');
      save();
      return c;
    }
    case 'regenerate':
      return wa.regenerate(a.jid);
    case 'settings': {
      const b = a.body || {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in b) db.settings[k] = b[k];
      if (!['off', 'draft', 'auto'].includes(db.settings.mode)) db.settings.mode = 'draft';
      save();
      return db.settings;
    }
    case 'alertsClear':
      db.alerts.length = 0;
      save();
      return { ok: true };
    case 'waLogout':
      await wa.logout();
      return { ok: true };
    case 'waConnect':
      wa.connectNow();
      return { ok: true };
    case 'waStop':
      wa.stop();
      return { ok: true };
    case 'waPair':
      wa.pairWithPhone(a.phone);
      return { ok: true };
    default:
      throw new Error('unknown action');
  }
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function authed(req) {
  const t = getCookie(req, 'sid');
  return PASSWORD && t && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

app.get('/health', (req, res) => res.type('text').send('ok ' + (leader.readState().status || '')));

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = (attempts.get(ip) || []).filter((t) => t > Date.now() - 15 * 60 * 1000);
  if (a.length >= 8) return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد ربع ساعة' });
  const pw = String((req.body && req.body.password) || '');
  const ok = PASSWORD && pw.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(PASSWORD));
  if (!ok) { a.push(Date.now()); attempts.set(ip, a); return res.status(401).json({ error: 'كلمة المرور غير صحيحة' }); }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `sid=${TOKEN}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.use((req, res, next) => {
  if (authed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  if (req.path === '/' || req.path.endsWith('.html')) return res.redirect('/login.html');
  if (req.path.endsWith('.css')) return next();
  return res.status(401).send('unauthorized');
});
app.use(express.static(path.join(__dirname, 'public')));

// non-leader copies re-read saved data before answering
app.use('/api', (req, res, next) => { leader.refresh(); next(); });

const act = (type, argsFn) => async (req, res) => {
  try { res.json(await leader.run(type, argsFn(req))); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

// ---- read endpoints ----
app.get('/api/state', (req, res) => {
  const s = leader.readState();
  const stale = !s.ts || Date.now() - s.ts > 30000;
  res.json({ ...s, status: stale && s.status === 'connected' ? 'reconnecting' : s.status, mode: db.settings.mode, ai: agent.aiEnabled() });
});

app.get('/api/chats', (req, res) => {
  const now = Date.now();
  res.json(Object.values(db.chats).filter((c) => c.lastTs).map((c) => ({ ...c, paused: c.pausedUntil > now })).sort((a, b) => b.lastTs - a.lastTs));
});
app.get('/api/chats/:jid/messages', (req, res) => res.json(db.messages[req.params.jid] || []));
app.get('/api/settings', (req, res) => res.json({ ...db.settings, ai: agent.aiEnabled() }));
app.get('/api/alerts', (req, res) => res.json(db.alerts.slice(0, 100)));

// ---- actions ----
app.post('/api/chats/:jid/send', (req, res, next) => {
  if (!String((req.body && req.body.text) || '').trim()) return res.status(400).json({ error: 'الرسالة فارغة' });
  next();
}, act('send', (req) => ({ jid: req.params.jid, text: String(req.body.text).trim() })));
app.post('/api/chats/:jid/read', act('read', (req) => ({ jid: req.params.jid })));
app.post('/api/chats/:jid/update', act('update', (req) => ({ jid: req.params.jid, body: req.body })));
app.post('/api/chats/:jid/regenerate', act('regenerate', (req) => ({ jid: req.params.jid })));
app.post('/api/settings', act('settings', (req) => ({ body: req.body })));
app.post('/api/alerts/clear', act('alertsClear', () => ({})));
app.post('/api/wa/logout', act('waLogout', () => ({})));
app.post('/api/wa/connect', act('waConnect', () => ({})));
app.post('/api/wa/stop', act('waStop', () => ({})));
app.post('/api/wa/pair', act('waPair', (req) => ({ phone: (req.body || {}).phone })));
app.get('/api/wa/health', (req, res) => {
  const lock = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'leader.json'), 'utf8')); } catch (_) { return null; } })();
  const st = leader.readState();
  res.json({
    servedBy: process.pid,
    leaderPid: lock ? lock.pid : null,
    leaderHeartbeatAgo: lock ? Date.now() - lock.ts : null,
    stateAgo: st.ts ? Date.now() - st.ts : null,
    chats: Object.keys(db.chats).length,
    messages: Object.values(db.messages).reduce((n, l) => n + l.length, 0),
    node: process.version
  });
});

app.get('/api/report', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const since = Date.now() - days * 86400000;
  const perDay = {};
  let incoming = 0, byAgent = 0, byHuman = 0;
  const activeChats = new Set();
  const words = {};
  const stop = new Set(['في','من','على','الى','إلى','عن','هل','ما','متى','كيف','انا','أنا','ابي','ابغى','لو','يا','و','او','أو','مع','هذا','هذي','الله','السلام','عليكم','شكرا','ممكن','اللي','عندي','لكم','بس','كم']);
  for (const [jid, list] of Object.entries(db.messages)) {
    for (const m of list) {
      if (m.ts < since) continue;
      const day = new Date(m.ts + 3 * 3600000).toISOString().slice(0, 10); // Riyadh date
      perDay[day] = perDay[day] || { incoming: 0, agent: 0, human: 0 };
      if (!m.fromMe) {
        incoming++; perDay[day].incoming++; activeChats.add(jid);
        for (const w of String(m.text).split(/[\s،,.؟?!:()"']+/)) {
          if (w.length > 2 && !stop.has(w) && !/^\d+$/.test(w)) words[w] = (words[w] || 0) + 1;
        }
      } else if (m.by === 'agent') { byAgent++; perDay[day].agent++; }
      else { byHuman++; perDay[day].human++; }
    }
  }
  const chats = Object.values(db.chats);
  const waiting = chats.filter((c) => c.lastTs && !c.lastFromMe).sort((a, b) => a.lastTs - b.lastTs)
    .map((c) => ({ id: c.id, name: c.name, lastText: c.lastText, lastTs: c.lastTs }));
  res.json({
    days, incoming, byAgent, byHuman, activeChats: activeChats.size,
    perDay: Object.entries(perDay).sort().map(([d, v]) => ({ day: d, ...v })),
    topWords: Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 15),
    waiting: waiting.slice(0, 50),
    important: chats.filter((c) => c.important).map((c) => ({ id: c.id, name: c.name, reason: c.reason, lastText: c.lastText })),
    alerts: db.alerts.filter((a) => a.ts >= since).length
  });
});

app.post('/api/assistant', async (req, res) => {
  const b = req.body || {};
  let context = '';
  if (b.jid && db.messages[b.jid]) {
    const c = db.chats[b.jid] || {};
    context = `محادثة مع ${c.name || b.jid}:\n` + db.messages[b.jid].slice(-40).map((m) => `${m.fromMe ? 'نحن' : 'المتدرب'}: ${m.text}`).join('\n');
  } else if (b.scope === 'all') {
    context = Object.values(db.chats).sort((a, b2) => b2.lastTs - a.lastTs).slice(0, 40)
      .map((c) => `- ${c.name || c.id}: ${c.lastFromMe ? '(رددنا)' : '(بانتظار رد)'} ${c.lastText}`).join('\n');
  }
  try { res.json({ answer: await agent.ask(String(b.question || ''), context) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`[pid ${process.pid}] panel listening on`, PORT));

// leader writes connection state to disk so every copy can show it
wa.onEvent((type) => { if (type === 'state') leader.writeState(wa.publicState()); });
leader.start({
  exec,
  becomeLeader: () => {
    wa.start().catch((e) => console.error('WhatsApp start failed', e));
    setInterval(() => leader.writeState(wa.publicState()), 5000);
  }
});

process.on('SIGTERM', () => { if (leader.isLeader()) require('./store').flush(); process.exit(0); });
