// The assistant brain: keyword rules (free) + optional AI (Anthropic API key in env).
const { db } = require('./store');

const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ً-ْـ]/g, '');
}

function hasAny(text, words) {
  const t = norm(text);
  return (words || []).some((w) => w && t.includes(norm(w)));
}

function keywordImportant(text) {
  const words = db.settings.importantKeywords || [];
  const t = norm(text);
  const hit = words.find((w) => w && t.includes(norm(w)));
  return hit ? `تحتوي على كلمة مهمة: "${hit}"` : '';
}

function ruleReply(text) {
  for (const r of db.settings.rules || []) {
    if (r && r.reply && hasAny(text, r.keywords)) return r.reply;
  }
  return '';
}

async function callAI(system, userContent, maxTokens = 700) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userContent }] })
  });
  if (!res.ok) throw new Error('AI error ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

function transcript(history, limit = 14) {
  return history
    .slice(-limit)
    .map((m) => `${m.fromMe ? 'نحن' : 'المتدرب'}: ${m.text}`)
    .join('\n');
}

// Decide what to do with the latest incoming message(s) in a chat.
// Returns { reply, needsHuman, important, reason }
async function decide(chat, history) {
  const lastIncoming = history.filter((m) => !m.fromMe).slice(-3).map((m) => m.text).join('\n');
  const kwImportant = keywordImportant(lastIncoming);

  if (!AI_KEY) {
    const reply = ruleReply(lastIncoming);
    return {
      reply: kwImportant ? '' : reply,
      needsHuman: !!kwImportant || !reply,
      important: !!kwImportant,
      reason: kwImportant || (reply ? '' : 'لا يوجد رد جاهز مناسب لهذه الرسالة')
    };
  }

  const s = db.settings;
  const system = `أنت مساعد خدمة المتدربين في "${s.businessName}" وترد على رسائل واتساب نيابة عن الإدارة.
قواعد:
- رد بالعربية بأسلوب مهذب وودود ومختصر (سطر إلى ثلاثة أسطر)، ويمكنك استخدام رمز تعبيري واحد على الأكثر.
- اعتمد فقط على "معلومات التدريب" و"الردود الجاهزة" أدناه. لا تخترع مواعيد أو أسعاراً أو وعوداً.
- إذا كان السؤال خارج المعلومات المتوفرة، أو الرسالة شكوى أو طلب استرداد أو مشكلة دفع أو انسحاب أو غضب أو أمر شخصي حساس، فاجعل needs_human = true ولا تكتب رداً نهائياً (يمكنك كتابة رد قصير مهذب مقترح مثل "تم استلام رسالتك وسيتواصل معك المسؤول قريباً").
- important = true إذا كانت الرسالة تحتاج انتباه المسؤول بسرعة.
أجب بصيغة JSON فقط بدون أي نص آخر:
{"reply": "...", "needs_human": false, "important": false, "reason": "سبب مختصر عند الحاجة للتدخل أو الأهمية"}

معلومات التدريب:
${s.knowledge}

الردود الجاهزة:
${(s.rules || []).map((r) => `- عند (${(r.keywords || []).join('، ')}): ${r.reply}`).join('\n')}`;

  try {
    const out = await callAI(system, `اسم المتدرب: ${chat.name || 'غير معروف'}\nالمحادثة:\n${transcript(history)}\n\nاكتب قرارك للرسالة الأخيرة من المتدرب.`);
    const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    const important = !!json.important || !!kwImportant;
    return {
      reply: String(json.reply || '').trim(),
      needsHuman: !!json.needs_human || !!kwImportant,
      important,
      reason: String(json.reason || kwImportant || '').trim()
    };
  } catch (e) {
    console.error('AI decide failed, falling back to rules:', e.message);
    const reply = ruleReply(lastIncoming);
    return { reply: kwImportant ? '' : reply, needsHuman: !!kwImportant || !reply, important: !!kwImportant, reason: kwImportant || 'تعذر تشغيل الذكاء الاصطناعي' };
  }
}

// Personal assistant panel inside the site.
async function ask(question, context) {
  if (!AI_KEY) return 'المساعد الذكي يحتاج مفتاح ذكاء اصطناعي (ANTHROPIC_API_KEY). الردود التلقائية بالكلمات المفتاحية تعمل بدونه.';
  const system = `أنت المساعد الشخصي لمسؤول "${db.settings.businessName}" داخل لوحة واتساب. تساعده في تلخيص المحادثات وصياغة الردود وكتابة التقارير. أجب بالعربية باختصار ووضوح.\n\nمعلومات التدريب:\n${db.settings.knowledge}`;
  return callAI(system, (context ? `سياق:\n${context}\n\n` : '') + `الطلب: ${question}`, 1200);
}

module.exports = { decide, ask, keywordImportant, aiEnabled: () => !!AI_KEY };
