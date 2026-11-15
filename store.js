// Simple JSON-file storage kept OUTSIDE the deployed folder so redeploys don't wipe it.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), 'wa-agent-data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch (_) {}
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_MSGS_PER_CHAT = 300;

const DEFAULT_SETTINGS = {
  mode: 'draft', // off | draft | auto
  businessName: 'مركز التدريب',
  knowledge:
    'اكتب هنا كل معلومات التدريب التي يرد بها المساعد:\n- أسماء البرامج والدورات\n- المواعيد والمدة\n- الرسوم وطرق الدفع\n- طريقة التسجيل والرابط\n- الشهادات\n- أوقات الدوام وأرقام التواصل',
  rules: [
    { keywords: ['السلام عليكم', 'مرحبا', 'هلا'], reply: 'وعليكم السلام ورحمة الله، أهلاً بك 🌷 كيف أقدر أخدمك؟' },
    { keywords: ['سعر', 'رسوم', 'كم التكلفة', 'بكم'], reply: 'رسوم البرنامج: (اكتب الرسوم هنا). هل تحب أرسل لك رابط التسجيل؟' },
    { keywords: ['موعد', 'متى', 'تبدأ'], reply: 'يبدأ البرنامج القادم بتاريخ (اكتب التاريخ هنا).' },
    { keywords: ['تسجيل', 'اسجل', 'أسجل', 'رابط'], reply: 'تقدر تسجل من هنا: (ضع رابط التسجيل).' }
  ],
  importantKeywords: ['شكوى', 'استرجاع', 'استرداد', 'مشكلة', 'عاجل', 'ضروري', 'انسحاب', 'الغاء', 'إلغاء', 'المدير', 'دفعت', 'حولت', 'تحويل', 'غير راضي', 'سيء'],
  alertToSelf: true,
  alertNumber: '',
  replyDelayMin: 6,
  replyDelayMax: 18,
  humanPauseHours: 12,
  maxAutoRepliesPerHour: 6,
  waStopped: false
};

// db is a single shared object; reload() refreshes it IN PLACE so other modules keep their reference.
const db = { chats: {}, messages: {}, settings: { ...DEFAULT_SETTINGS }, alerts: [] };
function reload() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db.chats = loaded.chats || {};
      db.messages = loaded.messages || {};
      db.alerts = loaded.alerts || [];
      db.settings = { ...DEFAULT_SETTINGS, ...(loaded.settings || {}) };
    }
  } catch (e) {
    console.error('Could not read db.json', e.message);
  }
}
reload();

function writeNow() {
  const tmp = DB_FILE + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('save failed', e.message);
  }
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 1500);
}
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeNow(); }
}

function getChat(jid) {
  if (!db.chats[jid]) {
    db.chats[jid] = { id: jid, name: '', lastTs: 0, lastText: '', unread: 0, autoReply: true, pausedUntil: 0, important: false, needsHuman: false, draft: '', reason: '' };
  }
  return db.chats[jid];
}

function addMessage(jid, m) {
  const list = (db.messages[jid] = db.messages[jid] || []);
  if (m.id && list.some((x) => x.id === m.id)) return false;
  list.push(m);
  list.sort((a, b) => a.ts - b.ts);
  if (list.length > MAX_MSGS_PER_CHAT) list.splice(0, list.length - MAX_MSGS_PER_CHAT);
  const chat = getChat(jid);
  const last = list[list.length - 1];
  chat.lastTs = last.ts;
  chat.lastText = last.text;
  chat.lastFromMe = last.fromMe;
  save();
  return true;
}

function addAlert(a) {
  db.alerts.unshift({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), ts: Date.now(), ...a });
  db.alerts = db.alerts.slice(0, 200);
  save();
  return db.alerts[0];
}

module.exports = { db, save, flush, reload, DB_FILE, getChat, addMessage, addAlert, DATA_DIR, DEFAULT_SETTINGS };
