const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'خطأ');
  return d;
}
function dur(ms) {
  if (ms <= 0) return 'الآن';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' ث';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' د ' + (s % 60) + ' ث';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' س ' + (m % 60) + ' د';
  return Math.floor(h / 24) + ' يوم ' + (h % 24) + ' س';
}

const STATUS = {
  connected: { cls: 'ok', label: 'متصل', title: 'واتساب متصل ويعمل' },
  qr: { cls: 'qr', label: 'بانتظار الربط', title: 'امسح الرمز لربط واتساب بيزنس' },
  starting: { cls: 'warn', label: 'جارٍ التشغيل', title: 'جارٍ تجهيز الاتصال بواتساب…' },
  reconnecting: { cls: 'warn', label: 'إعادة الاتصال', title: 'انقطاع مؤقت، جارٍ إعادة الاتصال' },
  blocked: { cls: 'bad', label: 'مرفوض مؤقتاً', title: 'واتساب يرفض الاتصال حالياً، اللوحة تعيد المحاولة تلقائياً' },
  stopped: { cls: 'off', label: 'موقوف', title: 'الاتصال موقوف يدوياً' },
  idle: { cls: 'off', label: 'غير مرتبط', title: 'انتهت صلاحية الرمز. اضغط "اتصال الآن" لإظهار رمز جديد' }
};

let S = null;
let tab = 'qr';

function render() {
  if (!S) return;
  const st = STATUS[S.status] || { cls: 'warn', label: S.status, title: S.status };
  $('badge').className = 'cx-badge ' + st.cls;
  $('badge').textContent = st.label;
  $('heroTitle').textContent = st.title;
  $('heroSub').textContent = S.me ? (S.me.name ? S.me.name + ' · ' : '') + '+' + S.me.id.split('@')[0] : (S.session ? 'توجد جلسة محفوظة' : 'لا توجد جلسة — يحتاج ربط');
  $('stNumber').textContent = S.me ? '+' + S.me.id.split('@')[0] : '—';
  $('stUptime').textContent = S.connectedSince ? dur(Date.now() - S.connectedSince) : '—';
  $('stNext').textContent = S.status === 'stopped' ? 'موقوف' : S.nextRetry && S.nextRetry > Date.now() ? 'بعد ' + dur(S.nextRetry - Date.now()) : '—';
  $('stError').textContent = S.lastError || '—';
  $('stSession').textContent = S.session ? 'نعم' : 'لا';
  $('stAttempts').textContent = S.attempts ?? '—';

  // linking card
  const linked = S.status === 'connected';
  $('linkedMsg').classList.toggle('hidden', !linked);
  document.querySelector('.cx-tabs').classList.toggle('hidden', linked);
  $('tabQr').classList.toggle('hidden', linked || tab !== 'qr');
  $('tabCode').classList.toggle('hidden', linked || tab !== 'code');
  if (S.qr && S.status === 'qr') {
    $('qr').src = S.qr; $('qr').classList.remove('hidden');
    $('qrNote').classList.add('hidden');
  } else {
    $('qr').classList.add('hidden'); $('qrNote').classList.remove('hidden');
    $('qrNote').textContent = S.status === 'blocked'
      ? `واتساب يرفض الاتصال مؤقتاً. المحاولة التالية بعد ${dur((S.nextRetry || 0) - Date.now())}.`
      : S.status === 'idle' ? 'انتهت صلاحية الرمز دون مسحه. اضغط "اتصال الآن" لإظهار رمز جديد.'
      : S.status === 'stopped' ? 'الاتصال موقوف. اضغط "اتصال الآن" لإظهار الرمز.'
      : 'سيظهر الرمز هنا عندما يكون واتساب جاهزاً للربط…';
  }
  if (S.pairCode) { $('pairCode').textContent = S.pairCode; $('pairCode').classList.remove('hidden'); }
  else $('pairCode').classList.add('hidden');

  // controls
  $('btnStop').disabled = S.status === 'stopped';
  $('btnConnect').disabled = S.status === 'connected';

  // events
  $('events').innerHTML = (S.events || []).map((e) => `<li><time>${new Date(e.ts).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span class="dotc ${esc(e.level)}"></span><span>${esc(e.text)}</span></li>`).join('') || '<li class="muted">لا توجد أحداث بعد</li>';
}

async function poll() {
  try { S = await api('/api/state'); render(); } catch (_) {}
  setTimeout(poll, 2000);
}
async function pollHealth() {
  try {
    const h = await api('/api/wa/health');
    const rows = [
      ['العملية المتصلة بواتساب', h.leaderPid ?? '—'],
      ['آخر نبضة منها', h.leaderHeartbeatAgo != null ? dur(h.leaderHeartbeatAgo) + ' مضت' : '—'],
      ['آخر تحديث للحالة', h.stateAgo != null ? dur(h.stateAgo) + ' مضت' : '—'],
      ['العملية التي خدمت هذه الصفحة', h.servedBy],
      ['المحادثات المحفوظة', h.chats],
      ['الرسائل المحفوظة', h.messages],
      ['ملف الاتصال', S ? S.profile + ' · ' + S.version : '—'],
      ['Node.js', h.node]
    ];
    $('health').innerHTML = rows.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('');
  } catch (_) {}
  setTimeout(pollHealth, 10000);
}
setInterval(render, 1000); // keep countdowns ticking

document.querySelector('.cx-tabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  tab = b.dataset.t;
  document.querySelectorAll('.cx-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  render();
};

async function action(url, confirmText, body) {
  if (confirmText && !confirm(confirmText)) return;
  try { await api(url, { method: 'POST', body: body || {} }); S = await api('/api/state'); render(); }
  catch (e) { alert(e.message); }
}
$('btnConnect').onclick = () => action('/api/wa/connect', S && S.status === 'blocked' ? 'واتساب يرفض الاتصال حالياً، والمحاولة المبكرة قد تطيل الرفض. هل تريد المحاولة الآن على أي حال؟' : null);
$('btnStop').onclick = () => action('/api/wa/stop', 'سيتوقف استقبال الرسائل والرد التلقائي حتى تضغط "اتصال الآن". متابعة؟');
$('btnLogout').onclick = () => action('/api/wa/logout', 'سيتم فصل اللوحة عن واتساب وحذف الجلسة، وستحتاج لمسح رمز جديد. متابعة؟');
$('pairForm').onsubmit = (e) => {
  e.preventDefault();
  action('/api/wa/pair', 'سيتم إنشاء رمز ربط جديد لهذا الرقم (وتُحذف أي جلسة سابقة غير متصلة). متابعة؟', { phone: $('pairPhone').value });
};

poll();
pollHealth();
