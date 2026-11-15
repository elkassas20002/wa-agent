// Front-end for the WhatsApp smart panel
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (url, opts = {}) => {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'خطأ');
  return data;
};
const fmtTime = (ts) => {
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ar-SA', { day: 'numeric', month: 'short' });
};
const displayName = (c) => c.name || (c.id.endsWith('@s.whatsapp.net') ? '+' + c.id.split('@')[0] : 'متدرب');

const hue = (id) => { let h = 7; for (const ch of String(id).split('@')[0]) h = (h * 33 + ch.charCodeAt(0)) % 9973; return (h * 47) % 360; };
const initial = (c) => displayName(c).replace('+', '').trim().slice(0, 1) || '؟';
function toast(text, type) {
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'error' ? ' error' : '');
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3000);
}

let chats = [];
let lastListHtml = '';
let stickBottom = true;
let rules = [];
let current = null;
let filter = 'all';
let messages = [];
let alertsUnseen = 0;

// ---------- state / connection ----------
function renderState(s) {
  const st = $('status');
  st.classList.remove('ok', 'bad');
  const map = { connected: 'متصل', qr: 'بانتظار مسح الرمز', reconnecting: 'إعادة الاتصال…', starting: 'جارٍ التشغيل…', blocked: 'واتساب يرفض الاتصال مؤقتاً', stopped: 'الاتصال موقوف', idle: 'غير مرتبط' };
  $('statusText').textContent = (map[s.status] || s.status) + (s.me ? ' — ' + (s.me.name || '+' + s.me.id.split('@')[0]) : '') ;
  $('status').title = s.ai ? 'الردود بالذكاء الاصطناعي' : 'الردود بالكلمات المفتاحية';
  if (s.status === 'connected') st.classList.add('ok');
  else if (s.status === 'qr') st.classList.add('bad');
  if (s.mode) { $('mode').value = s.mode; syncSeg(); }
  $('btnRelink').classList.toggle('hidden', ['qr', 'connected'].includes(s.status));
  const showQr = s.status === 'qr' || (['starting', 'blocked', 'idle'].includes(s.status) && !s.me);
  if (!showQr) overlayDismissed = false;
  $('qrOverlay').classList.toggle('hidden', !showQr || overlayDismissed);
  $('qrNew').classList.toggle('hidden', s.status !== 'idle');
  if (s.qr) { $('qrImg').src = s.qr; $('qrImg').classList.remove('hidden'); $('qrMsg').textContent = 'امسح الرمز من تطبيق واتساب بيزنس'; }
  else {
    $('qrImg').classList.add('hidden');
    const mins = s.nextRetry ? Math.ceil((s.nextRetry - Date.now()) / 60000) : 0;
    $('qrMsg').textContent = s.status === 'idle' ? 'انتهت صلاحية الرمز. اضغط الزر لإظهار رمز جديد.' : mins > 0
      ? `واتساب يرفض الاتصال مؤقتاً (غالباً بسبب كثرة المحاولات السابقة). سيعيد الموقع المحاولة تلقائياً خلال ${mins} دقيقة تقريباً، ولا تحتاج تفعل شيئاً.`
      : 'جارٍ تجهيز الرمز…';
  }
  if (s.status === 'connected') loadChats();
}

let overlayDismissed = false;
$('qrNew').onclick = async () => { $('qrMsg').textContent = 'جارٍ تجهيز الرمز…'; $('qrNew').classList.add('hidden'); try { await api('/api/wa/connect', { method: 'POST' }); } catch (e) { toast(e.message, 'error'); } };
$('qrSkip').onclick = () => { overlayDismissed = true; $('qrOverlay').classList.add('hidden'); };
$('btnRelink').onclick = async () => {
  if (!confirm('سيتم فصل جلسة واتساب الحالية وإظهار رمز QR جديد لتمسحه. متابعة؟')) return;
  $('statusText').textContent = 'جارٍ تجهيز رمز جديد…';
  try { await api('/api/wa/logout', { method: 'POST' }); } catch (e) { toast(e.message, 'error'); }
  lastStateKey = '';
};
function syncSeg() { [...$('modeSeg').children].forEach((b) => b.classList.toggle('active', b.dataset.mode === $('mode').value)); }
$('modeSeg').onclick = (e) => {
  const b = e.target.closest('button'); if (!b || b.dataset.mode === $('mode').value) return;
  $('mode').value = b.dataset.mode;
  $('mode').onchange({ target: $('mode') });
};
$('mode').onchange = async (e) => {
  const v = e.target.value;
  if (v === 'auto' && !confirm('سيرد المساعد تلقائياً على المتدربين. الرسائل المهمة وغير الواضحة ستبقى لك. متابعة؟')) { e.target.value = 'draft'; syncSeg(); return; }
  syncSeg();
  try { await api('/api/settings', { method: 'POST', body: { mode: v } }); toast('تم تغيير وضع المساعد'); } catch (err) { toast(err.message, 'error'); }
  lastStateKey = '';
};

// ---------- chat list ----------
async function loadChats() {
  chats = await api('/api/chats');
  renderChats();
  if (current) renderChatHead();
}

function renderChats() {
  const q = $('search').value.trim();
  const list = chats.filter((c) => {
    if (q && !(displayName(c) + ' ' + c.id + ' ' + c.lastText).toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'waiting') return !c.lastFromMe;
    if (filter === 'important') return c.important || c.needsHuman;
    if (filter === 'draft') return !!c.draft;
    return true;
  });
  $('cntAll').textContent = chats.length;
  $('cntWaiting').textContent = chats.filter((c) => !c.lastFromMe).length;
  $('cntImportant').textContent = chats.filter((c) => c.important || c.needsHuman).length;
  $('cntDraft').textContent = chats.filter((c) => c.draft).length;
  const html = list.map((c) => {
    const tags = [];
    if (c.needsHuman) tags.push('<span class="tag red">يحتاج تدخلك</span>');
    else if (c.important) tags.push('<span class="tag red">⭐ مهم</span>');
    if (c.draft) tags.push('<span class="tag amber">مسودة جاهزة</span>');
    if (c.paused) tags.push('<span class="tag">⏸ المساعد متوقف</span>');
    if (c.autoReply === false) tags.push('<span class="tag">المساعد معطّل</span>');
    if (!c.lastFromMe && !c.needsHuman) tags.push('<span class="tag green">بانتظار رد</span>');
    return `<li data-id="${esc(c.id)}" class="${current === c.id ? 'active' : ''} ${c.unread ? 'unseen' : ''}">
      <div class="avatar" style="--h:${hue(c.id)}">${esc(initial(c))}</div>
      <div class="ci">
        <div class="row"><span class="name">${esc(displayName(c))}</span><span class="time">${fmtTime(c.lastTs)}</span></div>
        <div class="row"><span class="last">${c.lastFromMe ? '✓ ' : ''}${esc(c.lastText)}</span>${c.unread ? `<span class="unread">${c.unread}</span>` : ''}</div>
        ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
      </div></li>`;
  }).join('') || `<li class="empty">${q || filter !== 'all' ? 'لا توجد نتائج مطابقة' : 'لا توجد محادثات بعد.<br>ستظهر هنا عند وصول أول رسالة.'}</li>`;
  if (html !== lastListHtml) { lastListHtml = html; $('chatList').innerHTML = html; }
}

$('chatList').onclick = (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openChat(li.dataset.id);
};
$('search').oninput = renderChats;
$('tabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.f;
  [...$('tabs').children].forEach((x) => x.classList.toggle('active', x === b));
  renderChats();
};

// ---------- open chat ----------
async function openChat(id) {
  current = id;
  document.querySelector('.layout').classList.add('open');
  $('app').classList.add('in-chat');
  stickBottom = true;
  lastMsgKey = '';
  $('emptyState').classList.add('hidden');
  $('chatInner').classList.remove('hidden');
  messages = await api('/api/chats/' + encodeURIComponent(id) + '/messages');
  renderMessages();
  renderChatHead();
  renderChats();
  api('/api/chats/' + encodeURIComponent(id) + '/read', { method: 'POST' }).then(() => {
    const c = chats.find((x) => x.id === id); if (c) { c.unread = 0; renderChats(); }
  });
}

function renderChatHead() {
  const c = chats.find((x) => x.id === current);
  if (!c) return;
  $('chatName').textContent = displayName(c);
  $('chatAvatar').textContent = initial(c);
  $('chatAvatar').style.setProperty('--h', hue(c.id));
  $('chatSub').textContent = c.id.endsWith('@s.whatsapp.net') ? '+' + c.id.split('@')[0] : '';
  $('chatAuto').checked = c.autoReply !== false;
  $('btnResume').classList.toggle('hidden', !c.paused);
  $('btnImportant').textContent = c.important ? '⭐ إزالة "مهم"' : '☆ مهم';
  const flag = $('chatFlag');
  if (c.needsHuman || c.important) {
    flag.className = 'flag red';
    flag.innerHTML = `⚠️ ${c.needsHuman ? 'هذه المحادثة تحتاج تدخلك' : 'محادثة مهمة'}${c.reason ? ' — ' + esc(c.reason) : ''} <button class="btn small" id="btnDone">تمت المعالجة ✓</button>`;
    $('btnDone').onclick = async () => { await api(`/api/chats/${encodeURIComponent(c.id)}/update`, { method: 'POST', body: { needsHuman: false, important: false } }); loadChats(); };
  } else if (c.paused) {
    flag.className = 'flag';
    flag.textContent = '⏸️ المساعد متوقف مؤقتاً في هذه المحادثة لأنك رددت بنفسك من الجوال.';
  } else flag.className = 'flag hidden';
  const showDraft = !!c.draft;
  $('draftBox').classList.toggle('hidden', !showDraft);
  if (showDraft && document.activeElement !== $('draftText')) $('draftText').value = c.draft;
}

function renderMessages() {
  const box = $('messages');
  let lastDay = '';
  const older = messages.length ? '<button class="btn small older" id="btnOlder">⬆️ تحميل رسائل أقدم من الجوال</button>' : '';
  box.innerHTML = older + messages.map((m) => {
    const day = new Date(m.ts).toLocaleDateString('ar-SA', { weekday: 'long', day: 'numeric', month: 'long' });
    const sep = day !== lastDay ? `<div class="day-sep">${day}</div>` : '';
    lastDay = day;
    const who = m.fromMe ? (m.by === 'agent' ? '<span class="who bot">🤖 المساعد</span>' : m.by === 'phone' ? '<span class="who">📱 الجوال</span>' : '') : '';
    return `${sep}<div class="msg ${m.fromMe ? 'me' : ''}">${esc(m.text)}<div class="meta">${who}<span>${new Date(m.ts).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}</span></div></div>`;
  }).join('');
  if (stickBottom) box.scrollTop = box.scrollHeight;
  const bo = $('btnOlder');
  if (bo) bo.onclick = async () => {
    bo.disabled = true; bo.textContent = '…جارٍ الطلب من الجوال';
    try { await api(`/api/chats/${encodeURIComponent(current)}/history`, { method: 'POST' }); stickBottom = false; toast('تم طلب الرسائل الأقدم. تظهر خلال ثوانٍ إذا كان الجوال متصلاً بالإنترنت'); }
    catch (e) { toast(e.message, 'error'); }
  };
}
$('messages').onscroll = () => { const b = $('messages'); stickBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 80; };

// ---------- sending ----------
async function send(text) {
  if (!text.trim() || !current) return;
  try { await api(`/api/chats/${encodeURIComponent(current)}/send`, { method: 'POST', body: { text } }); }
  catch (e) { toast('تعذر الإرسال: ' + e.message, 'error'); throw e; }
  messages = await api('/api/chats/' + encodeURIComponent(current) + '/messages');
  stickBottom = true;
  renderMessages();
  loadChats();
}
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const t = $('input').value;
  $('input').value = ''; autoGrow();
  try { await send(t); } catch (_) { $('input').value = t; }
};
$('input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); } };
$('btnSendDraft').onclick = async () => { await send($('draftText').value); $('draftBox').classList.add('hidden'); };
$('btnDiscard').onclick = async () => { await api(`/api/chats/${encodeURIComponent(current)}/update`, { method: 'POST', body: { draft: '' } }); loadChats(); };
$('btnRegen').onclick = async () => {
  $('btnRegen').disabled = true;
  try { const c = await api(`/api/chats/${encodeURIComponent(current)}/regenerate`, { method: 'POST' }); $('draftText').value = c.draft || '(لا يوجد اقتراح مناسب — اكتب الرد بنفسك)'; }
  finally { $('btnRegen').disabled = false; }
};
$('chatAuto').onchange = async (e) => { await api(`/api/chats/${encodeURIComponent(current)}/update`, { method: 'POST', body: { autoReply: e.target.checked } }); loadChats(); };
$('btnResume').onclick = async () => { await api(`/api/chats/${encodeURIComponent(current)}/update`, { method: 'POST', body: { resume: true } }); loadChats(); };
$('btnImportant').onclick = async () => {
  const c = chats.find((x) => x.id === current);
  await api(`/api/chats/${encodeURIComponent(current)}/update`, { method: 'POST', body: { important: !c.important } });
  loadChats();
};
$('btnSummarize').onclick = () => { openAssistant(); askAssistant('لخّص هذه المحادثة في نقاط، واذكر ما يطلبه المتدرب وما الخطوة التالية المقترحة.'); };

// ---------- live updates (polling; long-lived connections don't work well on shared hosting) ----------
let lastAlertTs = null;
let lastStateKey = '';
let lastMsgKey = '';
async function poll() {
  try {
    const s = await api('/api/state');
    const key = s.status + '|' + (s.qr || '').slice(-40) + '|' + (s.me && s.me.id) + '|' + s.mode + '|' + Math.ceil(((s.nextRetry || 0) - Date.now()) / 60000);
    if (key !== lastStateKey) { lastStateKey = key; renderState(s); }
    if (s.status === 'connected') {
      chats = await api('/api/chats');
      renderChats();
      if (current) {
        renderChatHead();
        const msgs = await api('/api/chats/' + encodeURIComponent(current) + '/messages');
        const mk = msgs.length + '|' + (msgs.length ? msgs[msgs.length - 1].id + msgs[msgs.length - 1].by : '');
        if (mk !== lastMsgKey) {
          const hadNewIncoming = msgs.length > messages.length && msgs.some((m) => !m.fromMe && !messages.find((x) => x.id === m.id));
          messages = msgs; lastMsgKey = mk; renderMessages();
          if (hadNewIncoming) api('/api/chats/' + encodeURIComponent(current) + '/read', { method: 'POST' }).catch(() => {});
        }
      }
    }
    const alerts = await api('/api/alerts');
    const newest = alerts[0] ? alerts[0].ts : 0;
    if (lastAlertTs === null) lastAlertTs = newest;
    const fresh = alerts.filter((a) => a.ts > lastAlertTs);
    if (fresh.length) {
      lastAlertTs = newest;
      alertsUnseen += fresh.length;
      $('alertCount').textContent = alertsUnseen;
      $('alertCount').classList.remove('hidden');
      beep();
      if ('Notification' in window && Notification.permission === 'granted') {
        for (const a of fresh.slice(0, 3)) {
          const n = new Notification('🔔 ' + a.title + ' — ' + a.name, { body: a.text });
          n.onclick = () => { window.focus(); openChat(a.jid); };
        }
      }
    }
  } catch (e) {
    if (e.message !== 'unauthorized') $('statusText').textContent = 'تعذر الاتصال بالخادم… إعادة المحاولة';
  }
  setTimeout(poll, document.hidden ? 10000 : 3000);
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(ctx.currentTime + 0.25);
  } catch (_) {}
}

// ---------- modal helpers ----------
function openModal(title, html) { $('modalTitle').textContent = title; $('modalBody').innerHTML = html; $('modal').classList.remove('hidden'); }
$('modalClose').onclick = () => $('modal').classList.add('hidden');
$('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').classList.add('hidden'); };

// ---------- alerts ----------
$('btnAlerts').onclick = async () => {
  alertsUnseen = 0; $('alertCount').classList.add('hidden');
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  const list = await api('/api/alerts');
  openModal('🔔 التنبيهات', (list.map((a) => `<div class="alert-item" data-jid="${esc(a.jid)}"><b>${esc(a.title)}</b> — ${esc(a.name)} <span class="muted small">${new Date(a.ts).toLocaleString('ar-SA')}</span><div class="muted">${a.reason ? 'السبب: ' + esc(a.reason) + '<br>' : ''}${esc(a.text)}</div></div>`).join('') || '<p class="muted">لا توجد تنبيهات</p>')
    + '<p><button class="btn danger" id="clearAlerts">مسح التنبيهات</button></p>');
  $('modalBody').onclick = (e) => { const it = e.target.closest('.alert-item'); if (it) { $('modal').classList.add('hidden'); openChat(it.dataset.jid); } };
  $('clearAlerts').onclick = async () => { await api('/api/alerts/clear', { method: 'POST' }); $('modal').classList.add('hidden'); };
};

// ---------- report ----------
$('btnReport').onclick = () => showReport(7);
async function showReport(days) {
  const r = await api('/api/report?days=' + days);
  const max = Math.max(1, ...r.perDay.map((d) => d.incoming));
  openModal('📊 تقرير المحادثات', `
    <p><select id="repDays">${[1, 7, 30].map((d) => `<option value="${d}" ${d === r.days ? 'selected' : ''}>آخر ${d === 1 ? 'يوم' : d + ' أيام'}</option>`).join('')}</select>
    <button class="btn small" id="repAI">🤖 تحليل بالذكاء الاصطناعي</button></p>
    <div class="kpis">
      <div class="kpi"><b>${r.incoming}</b>رسالة واردة</div>
      <div class="kpi"><b>${r.activeChats}</b>متدرب تواصل</div>
      <div class="kpi"><b>${r.byAgent}</b>رد من المساعد</div>
      <div class="kpi"><b>${r.byHuman}</b>رد منك</div>
      <div class="kpi"><b>${r.waiting.length}</b>بانتظار رد</div>
      <div class="kpi"><b>${r.alerts}</b>تنبيه</div>
    </div>
    <h3>الرسائل الواردة يومياً</h3>
    <div class="bars">${r.perDay.map((d) => `<div class="bar-row"><span>${d.day}</span><div class="bar" style="width:${(d.incoming / max) * 100}%"></div><span>${d.incoming}</span></div>`).join('') || '<p class="muted">لا توجد بيانات</p>'}</div>
    <h3>أكثر الكلمات تكراراً في أسئلة المتدربين</h3>
    <p>${r.topWords.map(([w, n]) => `<span class="tag">${esc(w)} (${n})</span>`).join(' ') || '<span class="muted">—</span>'}</p>
    <h3>محادثات بانتظار رد (${r.waiting.length})</h3>
    <table><tr><th>المتدرب</th><th>آخر رسالة</th><th>منذ</th></tr>${r.waiting.map((w) => `<tr class="alert-item" data-jid="${esc(w.id)}"><td>${esc(w.name || w.id.split('@')[0])}</td><td>${esc(w.lastText)}</td><td>${new Date(w.lastTs).toLocaleString('ar-SA')}</td></tr>`).join('')}</table>
    <h3>محادثات مهمة (${r.important.length})</h3>
    <table>${r.important.map((w) => `<tr class="alert-item" data-jid="${esc(w.id)}"><td>${esc(w.name || w.id.split('@')[0])}</td><td>${esc(w.reason)}</td><td>${esc(w.lastText)}</td></tr>`).join('') || '<tr><td class="muted">لا يوجد</td></tr>'}</table>
    <div id="repAIOut" class="a-msg bot hidden" style="margin-top:12px"></div>`);
  $('repDays').onchange = (e) => showReport(Number(e.target.value));
  $('modalBody').onclick = (e) => { const it = e.target.closest('[data-jid]'); if (it) { $('modal').classList.add('hidden'); openChat(it.dataset.jid); } };
  $('repAI').onclick = async () => {
    const out = $('repAIOut'); out.classList.remove('hidden'); out.textContent = '…جارٍ التحليل';
    try {
      const { answer } = await api('/api/assistant', { method: 'POST', body: { scope: 'all', question: `اكتب تقريراً مختصراً لآخر ${r.days} أيام: أبرز ما يسأل عنه المتدربون، المحادثات التي تحتاج متابعة عاجلة، واقتراحات لتحسين الردود الجاهزة. الإحصاءات: ${JSON.stringify({ incoming: r.incoming, activeChats: r.activeChats, byAgent: r.byAgent, byHuman: r.byHuman, waiting: r.waiting.length })}` } });
      out.textContent = answer;
    } catch (e) { out.textContent = e.message; }
  };
}

// ---------- settings ----------
$('btnSettings').onclick = async () => {
  const s = await api('/api/settings');
  const ruleRow = (r = { keywords: [], reply: '' }) => `<div class="rule"><input type="text" class="rk" placeholder="كلمات مفصولة بفاصلة" value="${esc((r.keywords || []).join('، '))}"><textarea class="rr" rows="2" placeholder="الرد">${esc(r.reply)}</textarea><button type="button" class="btn danger rdel">✕</button></div>`;
  openModal('⚙️ إعدادات المساعد', `<form class="form" id="setForm">
    <div><label>اسم الجهة</label><input type="text" name="businessName" value="${esc(s.businessName)}"></div>
    <div><label>معلومات التدريب <span class="hint">— كل ما يحتاجه المساعد ليرد (البرامج، المواعيد، الرسوم، التسجيل…)${s.ai ? '' : '. تُستخدم مع الذكاء الاصطناعي فقط'}</span></label><textarea name="knowledge" rows="8">${esc(s.knowledge)}</textarea></div>
    <div><label>الردود الجاهزة <span class="hint">— إذا احتوت رسالة المتدرب على إحدى الكلمات يُستخدم الرد</span></label><div id="rules">${(s.rules || []).map(ruleRow).join('')}</div><button type="button" class="btn small" id="addRule">+ إضافة رد</button></div>
    <div><label>كلمات تجعل الرسالة "مهمة" <span class="hint">— مفصولة بفاصلة؛ عندها يتوقف المساعد ويرسل لك تنبيهاً</span></label><textarea name="importantKeywords" rows="2">${esc((s.importantKeywords || []).join('، '))}</textarea></div>
    <div class="grid2">
      <div><label><input type="checkbox" name="alertToSelf" ${s.alertToSelf ? 'checked' : ''}> أرسل التنبيه لرقمي نفسه (محادثة "أنا")</label></div>
      <div><label>رقم إضافي للتنبيهات <span class="hint">مثال 9665xxxxxxxx</span></label><input type="text" name="alertNumber" value="${esc(s.alertNumber)}"></div>
      <div><label>تأخير الرد التلقائي (ثوانٍ) من</label><input type="number" name="replyDelayMin" value="${s.replyDelayMin}"></div>
      <div><label>إلى</label><input type="number" name="replyDelayMax" value="${s.replyDelayMax}"></div>
      <div><label>إيقاف المساعد في المحادثة بعد ردك من الجوال (ساعات)</label><input type="number" name="humanPauseHours" value="${s.humanPauseHours}"></div>
      <div><label>أقصى ردود تلقائية لكل محادثة في الساعة</label><input type="number" name="maxAutoRepliesPerHour" value="${s.maxAutoRepliesPerHour}"></div>
    </div>
    <div><button class="btn primary" type="submit">حفظ</button> <span id="setMsg" class="muted"></span></div>
    <hr><div><button type="button" class="btn danger" id="waLogout">فصل واتساب عن اللوحة</button> <button type="button" class="btn" id="panelLogout">تسجيل الخروج من اللوحة</button></div>
  </form>`);
  const split = (v) => String(v).split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);
  $('addRule').onclick = () => $('rules').insertAdjacentHTML('beforeend', ruleRow());
  $('rules').onclick = (e) => { if (e.target.classList.contains('rdel')) e.target.parentElement.remove(); };
  $('setForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      businessName: f.businessName.value, knowledge: f.knowledge.value,
      rules: [...document.querySelectorAll('#rules .rule')].map((r) => ({ keywords: split(r.querySelector('.rk').value), reply: r.querySelector('.rr').value.trim() })).filter((r) => r.keywords.length && r.reply),
      importantKeywords: split(f.importantKeywords.value), alertToSelf: f.alertToSelf.checked, alertNumber: f.alertNumber.value.trim(),
      replyDelayMin: Number(f.replyDelayMin.value), replyDelayMax: Number(f.replyDelayMax.value),
      humanPauseHours: Number(f.humanPauseHours.value), maxAutoRepliesPerHour: Number(f.maxAutoRepliesPerHour.value)
    };
    await api('/api/settings', { method: 'POST', body });
    $('setMsg').textContent = '✓ تم الحفظ'; toast('تم حفظ الإعدادات');
  };
  $('waLogout').onclick = async () => { if (confirm('سيتم فصل واتساب وسيظهر رمز QR جديد. متابعة؟')) { await api('/api/wa/logout', { method: 'POST' }); $('modal').classList.add('hidden'); } };
  $('panelLogout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login.html'; };
};

// ---------- assistant ----------
function openAssistant() { $('assistant').classList.remove('hidden'); $('assistInput').focus(); }
$('btnAssistant').onclick = () => $('assistant').classList.toggle('hidden');
$('assistantClose').onclick = () => $('assistant').classList.add('hidden');
async function askAssistant(q) {
  const log = $('assistLog');
  log.insertAdjacentHTML('beforeend', `<div class="a-msg me">${esc(q)}</div>`);
  const pending = document.createElement('div'); pending.className = 'a-msg bot'; pending.textContent = '…'; log.appendChild(pending);
  log.scrollTop = log.scrollHeight;
  try {
    const { answer } = await api('/api/assistant', { method: 'POST', body: { question: q, jid: current || undefined, scope: current ? undefined : 'all' } });
    pending.textContent = answer;
  } catch (e) { pending.textContent = 'خطأ: ' + e.message; }
  log.scrollTop = log.scrollHeight;
}
$('assistForm').onsubmit = (e) => { e.preventDefault(); const q = $('assistInput').value.trim(); if (q) { $('assistInput').value = ''; askAssistant(q); } };
$('assistInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('assistForm').requestSubmit(); } };

// mobile: back to list by tapping brand
$('btnBack').onclick = () => { document.querySelector('.layout').classList.remove('open'); $('app').classList.remove('in-chat'); current = null; renderChats(); };
$('navChats').onclick = () => { $('modal').classList.add('hidden'); $('assistant').classList.add('hidden'); };

// theme
function applyTheme(t) { document.documentElement.dataset.theme = t; $('btnTheme').textContent = t === 'dark' ? '☀️' : '🌙'; try { localStorage.setItem('theme', t); } catch (_) {} }
$('btnTheme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
applyTheme(document.documentElement.dataset.theme || 'light');

// quick replies (the saved ready-made replies)
async function loadRules() { try { rules = (await api('/api/settings')).rules || []; } catch (_) {} }
$('btnQuick').onclick = async () => {
  const m = $('quickMenu');
  if (!m.classList.contains('hidden')) { m.classList.add('hidden'); return; }
  await loadRules();
  m.innerHTML = rules.map((r, i) => `<button type="button" data-i="${i}"><b>${esc((r.keywords || []).slice(0, 4).join('، '))}</b>${esc(r.reply)}</button>`).join('') || '<div class="muted" style="padding:10px">لا توجد ردود جاهزة. أضفها من ⚙️ الإعدادات.</div>';
  m.classList.remove('hidden');
};
$('quickMenu').onclick = (e) => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  $('input').value = rules[Number(b.dataset.i)].reply;
  $('quickMenu').classList.add('hidden');
  $('input').focus(); autoGrow();
};
document.addEventListener('click', (e) => { if (!e.target.closest('#quickMenu') && !e.target.closest('#btnQuick')) $('quickMenu').classList.add('hidden'); });
function autoGrow() { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(140, i.scrollHeight) + 'px'; }
$('input').oninput = autoGrow;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('modal').classList.add('hidden'); $('assistant').classList.add('hidden'); $('quickMenu').classList.add('hidden'); } });

// ---------- boot ----------
poll();
if ('Notification' in window && Notification.permission === 'default') setTimeout(() => Notification.requestPermission(), 3000);
