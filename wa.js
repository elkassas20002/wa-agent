// WhatsApp connection (linked device via QR, like WhatsApp Web) + auto-reply logic.
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { db, save, getChat, addMessage, addAlert, DATA_DIR } = require('./store');
const agent = require('./agent');

const AUTH_DIR = path.join(DATA_DIR, 'auth');
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });

const state = { status: 'starting', qr: null, me: null, lastError: '', events: [], attempts: 0, stopped: false };
let pairPhone = '';
let sock = null;
let reconnects = 0;
// Connection profiles, tried in order if WhatsApp keeps closing the connection before showing a QR.
// The first one is the setup that connected successfully on this server.
const CONFIGS = [
  { name: 'mac-chrome-full', browser: () => Browsers.macOS('Chrome'), full: true, latest: true },
  { name: 'mac-chrome-builtin-version', browser: () => Browsers.macOS('Chrome'), full: false, latest: false },
  { name: 'ubuntu-chrome', browser: () => Browsers.ubuntu('Chrome'), full: false, latest: true }
];
let cfgIndex = 0;
let earlyFails = 0; // closes without ever getting a QR or opening
let totalEarlyFails = 0;
let generation = 0;
let startTimer = null;
function scheduleStart(ms) {
  clearTimeout(startTimer);
  startTimer = setTimeout(() => start().catch((e) => { console.error('restart failed', e); scheduleStart(10000); }), ms);
}
const listeners = new Set();
const sentByPanel = new Set(); // message ids sent by this app (so we don't treat them as "human typed on phone")
const pendingTimers = new Map();
const pendingSends = new Map(); // jid -> {text, by} while sendMessage is in flight
const autoReplyLog = new Map(); // jid -> [timestamps]

function emit(type, data) {
  for (const fn of listeners) {
    try { fn(type, data); } catch (_) {}
  }
}
function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const isIndividual = (jid) => !!jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
const myJid = () => (sock && sock.user ? jidNormalizedUser(sock.user.id) : '');
const myLid = () => (sock && sock.user && sock.user.lid ? jidNormalizedUser(sock.user.lid) : '');
const isSelf = (jid) => jid === myJid() || (myLid() && jid === myLid());
const toTs = (t) => Number(t && t.toNumber ? t.toNumber() : t || 0) * 1000 || Date.now();

function extractText(message) {
  if (!message) return '';
  const m =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message.editedMessage?.message ||
    message;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return '🖼️ صورة' + (m.imageMessage.caption ? ': ' + m.imageMessage.caption : '');
  if (m.videoMessage) return '🎬 فيديو' + (m.videoMessage.caption ? ': ' + m.videoMessage.caption : '');
  if (m.audioMessage) return '🎤 رسالة صوتية';
  if (m.documentMessage) return '📄 ملف: ' + (m.documentMessage.fileName || '') + (m.documentMessage.caption ? ' - ' + m.documentMessage.caption : '');
  if (m.stickerMessage) return '🏷️ ملصق';
  if (m.locationMessage) return '📍 موقع';
  if (m.contactMessage) return '👤 جهة اتصال: ' + (m.contactMessage.displayName || '');
  if (m.buttonsResponseMessage) return m.buttonsResponseMessage.selectedDisplayText || '';
  if (m.listResponseMessage) return m.listResponseMessage.title || '';
  if (m.reactionMessage) return null; // ignore reactions
  if (m.protocolMessage || m.senderKeyDistributionMessage) return null;
  return '';
}

function ingest(msg, { live } = {}) {
  const jid = msg.key && msg.key.remoteJid;
  if (!isIndividual(jid) || isSelf(jid)) return null;
  const text = extractText(msg.message);
  if (text === null || (text === '' && !msg.message)) return null;
  const fromMe = !!msg.key.fromMe;
  const chat = getChat(jid);
  if (!fromMe && msg.pushName && !chat.name) chat.name = msg.pushName;
  let by = 'customer';
  if (fromMe) {
    const p = pendingSends.get(jid);
    if (sentByPanel.has(msg.key.id)) by = 'panel';
    else if (p && p.text === text) { by = p.by; pendingSends.delete(jid); }
    else by = 'phone';
  }
  const rec = { id: msg.key.id, fromMe, text: text || '(رسالة غير مدعومة)', ts: toTs(msg.messageTimestamp), by };
  const added = addMessage(jid, rec);
  if (!added) return null;
  if (live) {
    if (!fromMe) chat.unread = (chat.unread || 0) + 1;
    if (fromMe && by === 'phone') {
      // You replied from your phone -> the human took over this chat: pause the bot for a while.
      chat.pausedUntil = Date.now() + (db.settings.humanPauseHours || 12) * 3600 * 1000;
      chat.needsHuman = false;
      chat.draft = '';
    }
    if (fromMe) { chat.needsHuman = false; chat.unread = 0; }
    save();
    emit('message', { jid, message: rec, chat });
  }
  return { jid, rec, chat };
}

// ---------- connection control ----------
function logEvent(level, text) {
  state.events.unshift({ ts: Date.now(), level, text });
  if (state.events.length > 80) state.events.length = 80;
  console.log('[wa]', text);
}
const hasSession = () => fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
const REASONS = {
  401: 'تم تسجيل الخروج من الجوال',
  403: 'الحساب ممنوع من الاتصال',
  408: 'انتهت مهلة الاتصال',
  411: 'عدم تطابق الأجهزة المتعددة',
  428: 'واتساب أغلق الاتصال',
  440: 'تم فتح الجلسة من مكان آخر',
  500: 'جلسة تالفة',
  503: 'خدمة واتساب غير متاحة',
  515: 'إعادة تشغيل مطلوبة بعد الربط'
};

let firstStart = true;
async function start() {
  clearTimeout(startTimer);
  if (firstStart) { firstStart = false; state.stopped = !!db.settings.waStopped; if (state.stopped) { state.status = 'stopped'; logEvent('warn', 'الاتصال موقوف يدوياً'); emit('state', publicState()); } }
  if (state.stopped) return;
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  if (CONFIGS[cfgIndex].latest) { try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) {} }
  state.profile = CONFIGS[cfgIndex].name;
  state.version = version ? version.join('.') : 'مدمج';
  state.attempts++;
  state.lastAttempt = Date.now();
  state.nextRetry = 0;
  if (!state.me) state.status = 'starting';
  logEvent('info', `محاولة اتصال #${state.attempts} (${state.profile}، ${hasSession() ? 'جلسة محفوظة' : 'جلسة جديدة'})`);
  emit('state', publicState());

  const gen = ++generation;
  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: authState,
    logger,
    browser: CONFIGS[cfgIndex].browser(),
    markOnlineOnConnect: false,
    syncFullHistory: CONFIGS[cfgIndex].full,
    getMessage: async (key) => {
      const m = (db.messages[key.remoteJid] || []).find((x) => x.id === key.id);
      return m ? { conversation: m.text } : undefined;
    }
  });
  const mySock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (gen !== generation) return; // an old socket we already replaced
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      earlyFails = 0;
      totalEarlyFails = 0;
      if (state.status !== 'qr') logEvent('ok', 'واتساب جاهز للربط، رمز QR ظاهر');
      state.status = 'qr';
      state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
      state.qrAt = Date.now();
      if (pairPhone && !state.pairCode) {
        try {
          const code = await mySock.requestPairingCode(pairPhone);
          state.pairCode = code && code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
          logEvent('ok', 'تم إنشاء رمز الربط بالرقم ' + pairPhone);
        } catch (e) {
          logEvent('error', 'تعذر إنشاء رمز الربط: ' + e.message);
        }
        pairPhone = '';
      }
      emit('state', publicState());
    }
    if (connection === 'open') {
      reconnects = 0;
      earlyFails = 0;
      totalEarlyFails = 0;
      state.status = 'connected';
      state.qr = null;
      state.pairCode = '';
      state.connectedSince = Date.now();
      state.me = { id: myJid(), name: mySock.user.name || '' };
      logEvent('ok', 'متصل بنجاح بالرقم +' + state.me.id.split('@')[0]);
      emit('state', publicState());
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : 0;
      state.lastError = (REASONS[code] || 'انقطع الاتصال') + (code ? ` (${code})` : '');
      state.connectedSince = 0;
      const wasConnected = state.status === 'connected';
      let wait;
      if (state.stopped) { state.status = 'stopped'; emit('state', publicState()); return; }
      if (code === DisconnectReason.loggedOut) {
        logEvent('warn', 'تم فصل اللوحة من الجوال؛ حُذفت الجلسة وسيظهر رمز جديد');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        state.me = null;
        state.status = 'starting';
        wait = 3000;
      } else if (code === DisconnectReason.restartRequired) {
        logEvent('info', 'تم الربط، جارٍ إكمال الاتصال');
        wait = 500;
      } else if (code === DisconnectReason.connectionReplaced) {
        logEvent('warn', 'الجلسة فُتحت من مكان آخر؛ إعادة المحاولة بعد دقيقة');
        state.status = 'reconnecting';
        wait = 60000;
      } else if (wasConnected || (state.me && hasSession())) {
        reconnects++;
        state.status = 'reconnecting';
        wait = Math.min(60000, 3000 * reconnects);
        logEvent('warn', `${state.lastError}؛ إعادة الاتصال بعد ${Math.round(wait / 1000)} ث`);
      } else {
        // Refused before any QR: likely a temporary block after many attempts. Back off up to 10 min and rotate profiles.
        earlyFails++;
        totalEarlyFails++;
        state.status = 'blocked';
        wait = Math.min(600000, 5000 * Math.pow(2, Math.min(totalEarlyFails, 7)));
        if (earlyFails >= 2) { earlyFails = 0; cfgIndex = (cfgIndex + 1) % CONFIGS.length; }
        if (hasSession() && totalEarlyFails >= 6) {
          logEvent('warn', 'الجلسة المحفوظة لا تتصل؛ حُذفت ليظهر رمز جديد');
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        logEvent('error', `${state.lastError} قبل ظهور الرمز؛ المحاولة التالية بعد ${wait >= 60000 ? Math.round(wait / 60000) + ' د' : Math.round(wait / 1000) + ' ث'}`);
      }
      state.nextRetry = Date.now() + wait;
      emit('state', publicState());
      scheduleStart(wait);
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => updateNames(contacts));
  sock.ev.on('contacts.update', (contacts) => updateNames(contacts));

  sock.ev.on('messaging-history.set', ({ messages, contacts, chats, syncType }) => {
    let n = 0;
    for (const m of messages || []) if (ingest(m, { live: false })) n++;
    if (contacts) updateNames(contacts);
    if (chats) updateNames(chats);
    console.log('History sync', syncType, '- saved', n, 'messages from', (chats || []).length, 'chats');
    emit('chats', {});
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      const r = ingest(msg, { live: type === 'notify' || type === 'append' });
      if (r && type === 'notify' && !r.rec.fromMe) scheduleHandle(r.jid);
    }
  });
}

function updateNames(contacts) {
  let changed = false;
  for (const c of contacts || []) {
    const jid = c.id && jidNormalizedUser(c.id);
    if (!isIndividual(jid) || !db.chats[jid]) continue;
    const name = c.name || c.notify || c.verifiedName;
    if (name && db.chats[jid].name !== name) { db.chats[jid].name = name; changed = true; }
  }
  if (changed) { save(); emit('chats', {}); }
}

// Wait a few seconds so we answer several quick messages together.
function scheduleHandle(jid) {
  clearTimeout(pendingTimers.get(jid));
  pendingTimers.set(jid, setTimeout(() => handleIncoming(jid).catch((e) => console.error('handle failed', e)), 7000));
}

async function handleIncoming(jid) {
  pendingTimers.delete(jid);
  const chat = getChat(jid);
  const history = db.messages[jid] || [];
  const last = history[history.length - 1];
  if (!last || last.fromMe) return; // someone already replied
  const s = db.settings;

  const d = await agent.decide(chat, history);
  chat.reason = d.reason || '';
  if (d.important) chat.important = true;

  const paused = chat.pausedUntil && chat.pausedUntil > Date.now();
  const botAllowed = s.mode !== 'off' && chat.autoReply !== false && !paused;

  if (d.needsHuman || d.important) {
    chat.needsHuman = true;
    chat.draft = d.reply || chat.draft || '';
    save();
    emit('chats', {});
    // WhatsApp/browser alert only for important messages; "needs human" is shown in the panel.
    if (d.important) await alert(jid, 'رسالة مهمة', d.reason, last.text);
    return;
  }

  if (!d.reply) { save(); return; }

  if (!botAllowed || s.mode === 'draft') {
    chat.draft = d.reply;
    save();
    emit('chats', {});
    return;
  }

  // mode === 'auto'
  const log = (autoReplyLog.get(jid) || []).filter((t) => t > Date.now() - 3600 * 1000);
  if (log.length >= (s.maxAutoRepliesPerHour || 6)) {
    chat.draft = d.reply;
    chat.needsHuman = true;
    chat.reason = 'تجاوزت المحادثة حد الردود التلقائية في الساعة';
    save();
    emit('chats', {});
    return;
  }
  const min = Math.max(2, Number(s.replyDelayMin) || 6);
  const max = Math.max(min, Number(s.replyDelayMax) || 18);
  const delay = (min + Math.random() * (max - min)) * 1000;
  try { await sock.presenceSubscribe(jid); await sock.sendPresenceUpdate('composing', jid); } catch (_) {}
  await new Promise((r) => setTimeout(r, delay));
  const again = db.messages[jid] || [];
  if (again[again.length - 1] && again[again.length - 1].fromMe) return; // you answered meanwhile
  try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
  await sendText(jid, d.reply, 'agent');
  log.push(Date.now());
  autoReplyLog.set(jid, log);
}

async function alert(jid, title, reason, text) {
  const chat = getChat(jid);
  const a = addAlert({ jid, title, reason: reason || '', text: (text || '').slice(0, 300), name: chat.name || jid.split('@')[0] });
  emit('alert', a);
  const s = db.settings;
  const body = `🔔 *${title}*\nمن: ${a.name}${jid.endsWith('@s.whatsapp.net') ? ' (+' + jid.split('@')[0] + ')' : ''}\n${reason ? 'السبب: ' + reason + '\n' : ''}الرسالة: ${a.text}`;
  const targets = [];
  if (s.alertToSelf && myJid()) targets.push(myJid());
  if (s.alertNumber) {
    const n = String(s.alertNumber).replace(/\D/g, '');
    if (n) targets.push(n + '@s.whatsapp.net');
  }
  for (const t of targets) {
    try {
      const sent = await sock.sendMessage(t, { text: body });
      if (sent && sent.key) sentByPanel.add(sent.key.id);
    } catch (e) { console.error('alert send failed', e.message); }
  }
}

async function sendText(jid, text, by = 'panel') {
  if (!sock || state.status !== 'connected') throw new Error('واتساب غير متصل');
  pendingSends.set(jid, { text, by });
  let sent;
  try { sent = await sock.sendMessage(jid, { text }); } finally { pendingSends.delete(jid); }
  if (sent && sent.key) {
    sentByPanel.add(sent.key.id);
    if (sentByPanel.size > 5000) sentByPanel.delete(sentByPanel.values().next().value);
    const chat = getChat(jid);
    const rec = { id: sent.key.id, fromMe: true, text, ts: Date.now(), by };
    const list = db.messages[jid] || [];
    const existing = list.find((m) => m.id === rec.id);
    if (existing) existing.by = by; else addMessage(jid, rec);
    chat.draft = '';
    chat.needsHuman = false;
    chat.unread = 0;
    if (by === 'panel') chat.pausedUntil = 0;
    save();
    emit('message', { jid, message: rec, chat });
  }
  return true;
}

async function markRead(jid) {
  const chat = getChat(jid);
  chat.unread = 0;
  save();
  try {
    const keys = (db.messages[jid] || []).filter((m) => !m.fromMe).slice(-5).map((m) => ({ remoteJid: jid, id: m.id, fromMe: false }));
    if (sock && keys.length) await sock.readMessages(keys);
  } catch (_) {}
}

async function regenerate(jid) {
  const chat = getChat(jid);
  const d = await agent.decide(chat, db.messages[jid] || []);
  chat.draft = d.reply || '';
  chat.reason = d.reason || chat.reason;
  save();
  return chat;
}

function closeSocket() {
  generation++; // ignore events from the old socket
  clearTimeout(startTimer);
  if (sock) { try { sock.end(undefined); } catch (_) {} }
}

// Unlink from WhatsApp (removes the linked device) and show a fresh QR.
async function logout() {
  generation++;
  clearTimeout(startTimer);
  if (sock && state.status === 'connected') {
    try { await Promise.race([sock.logout(), new Promise((r) => setTimeout(r, 5000))]); } catch (_) {}
  }
  closeSocket();
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  reconnects = 0;
  state.stopped = false;
  db.settings.waStopped = false; save();
  state.status = 'starting';
  state.me = null;
  state.qr = null;
  state.pairCode = '';
  logEvent('warn', 'تم فصل الربط وحذف الجلسة؛ جارٍ تجهيز رمز جديد');
  emit('state', publicState());
  scheduleStart(1500);
}

// Try to connect right now (skips the waiting time).
function connectNow() {
  closeSocket();
  state.stopped = false;
  db.settings.waStopped = false; save();
  logEvent('info', 'طلب اتصال يدوي');
  scheduleStart(300);
}

// Stop connecting (keeps the session so you can resume later without scanning again).
function stop() {
  closeSocket();
  state.stopped = true;
  db.settings.waStopped = true; save();
  state.status = 'stopped';
  state.qr = null;
  state.nextRetry = 0;
  state.connectedSince = 0;
  logEvent('warn', 'تم إيقاف الاتصال يدوياً (الجلسة محفوظة)');
  emit('state', publicState());
}

// Link with an 8-character code typed on the phone instead of scanning a QR.
function pairWithPhone(phone) {
  const n = String(phone || '').replace(/\D/g, '');
  if (n.length < 9) throw new Error('رقم غير صحيح، اكتبه بالصيغة الدولية مثل 9665xxxxxxxx');
  if (state.status === 'connected') throw new Error('واتساب متصل بالفعل');
  state.pairCode = '';
  pairPhone = n;
  if (hasSession()) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  closeSocket();
  state.stopped = false;
  db.settings.waStopped = false; save();
  logEvent('info', 'طلب ربط برمز للرقم ' + n);
  scheduleStart(300);
}

function publicState() {
  return {
    status: state.status, qr: state.qr, qrAt: state.qrAt || 0, me: state.me, lastError: state.lastError,
    nextRetry: state.nextRetry || 0, connectedSince: state.connectedSince || 0, attempts: state.attempts,
    lastAttempt: state.lastAttempt || 0, profile: state.profile || '', version: state.version || '',
    pairCode: state.pairCode || '', session: hasSession(), stopped: !!state.stopped,
    events: state.events.slice(0, 50), pid: process.pid, ai: agent.aiEnabled()
  };
}

module.exports = { start, onEvent, publicState, sendText, markRead, regenerate, logout, connectNow, stop, pairWithPhone };
