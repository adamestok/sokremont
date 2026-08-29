/**
 * СОКРЕМОНТ — чат сайт <-> Telegram (+ голосовые сообщения)
 *
 * Как развернуть (Cloudflare Dashboard):
 *   1. Workers & Pages -> sok-chat -> Edit code -> вставить весь этот файл -> Deploy.
 *   2. Settings -> Bindings: нужен ОДИН namespace KV с ЛЮБЫМ именем — код найдёт его сам.
 *      (Если KV ещё нет: KV -> Create namespace, затем Bindings -> добавить KV.)
 *   3. Открыть https://sok-chat.<аккаунт>.workers.dev/setup?t=<ТОКЕН_БОТА> :
 *        - выбрать чат администратора (сначала напишите боту любое сообщение),
 *        - нажать «Включить вебхук».
 *   Переменные окружения (необязательно, можно задать в Settings -> Variables):
 *        BOT_TOKEN, CHAT_ID, WEBHOOK_SECRET
 */

/* старый DO-класс: отдаёт сохранённый chat_id владельца для миграции */
export class ChatStore {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/owner') {
      const owner = await this.state.storage.get('owner_chat_id');
      return new Response(JSON.stringify({ owner: owner || null }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('deprecated', { status: 410 });
  }
}

export default {
  async fetch(req, env, ctx) {
    const kv = pickKv(env);
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') return r204();
      if (p === '/' && req.method === 'GET') return j({ ok: true, name: 'sok-chat', v: 'voice-1' });
      if (p === '/health') return j({ ok: true, ts: Date.now(), v: 'voice-1' });
      if (p === '/migrate-owner') {
        if (url.searchParams.get('t') !== (env && env.BOT_TOKEN)) return j({ ok: false, error: 'forbidden' }, 403);
        const st0 = await kv.get('settings', 'json').catch(() => ({})) || {};
        if (st0.chat) return j({ ok: true, chat: st0.chat, src: 'kv' });
        try {
          const id = env.CHAT_DO.idFromName('main');
          const r = await env.CHAT_DO.get(id).fetch('https://do.internal/owner');
          const d = await r.json();
          if (d && d.owner) {
            st0.chat = String(d.owner);
            await kv.put('settings', JSON.stringify(st0));
            return j({ ok: true, chat: st0.chat, src: 'do' });
          }
          return j({ ok: false, error: 'в старом хранилище чат не найден' });
        } catch (e) { return j({ ok: false, error: String(e && e.message || e) }); }
      }
      if (!kv) return j({ ok: false, error: 'KV binding не найден: добавьте KV namespace в Settings -> Bindings' }, 500);

      if (p === '/msg' && req.method === 'POST') return await hMsg(req, kv, env, ctx);
      if (p === '/voice' && req.method === 'POST') return j({ ok: false, error: 'Voice messages from site are disabled' }, 403);
      if (p === '/voice' && req.method === 'GET') return await hVoiceGet(url, kv);
      if (p === '/poll' && req.method === 'GET') return await hPoll(url, kv, ctx);
      if (p === '/webhook' || p === '/tgwebhook') return await hWebhook(req, kv, env, ctx);
      if (p === '/setup') return await hSetup(req, url, kv, env, ctx);

      return j({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return j({ ok: false, error: String(e && e.message || e) }, 500);
    }
  }
};

/* ---------- helpers ---------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Telegram-Bot-Api-Secret-Token'
};

function cors(h) { const o = Object.assign({}, CORS, h || {}); return o; }
function j(obj, code) { return new Response(JSON.stringify(obj), { status: code || 200, headers: cors({ 'Content-Type': 'application/json; charset=utf-8' }) }); }
function r204() { return new Response(null, { status: 204, headers: cors() }); }

function pickKv(env) {
  for (const k of Object.keys(env || {})) {
    const v = env[k];
    if (v && typeof v.get === 'function' && typeof v.put === 'function' && typeof v.list === 'function') return v;
  }
  return null;
}

function b64enc(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64dec(str) {
  const s = atob(str), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}
const okSid = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(s);
const clean = (s, n) => String(s == null ? '' : s).slice(0, n);

async function cfg(kv, env) {
  let st = {};
  try { st = await kv.get('settings', 'json') || {}; } catch (e) {}
  const token = (env && (env.BOT_TOKEN || env.TG_TOKEN || env.TOKEN)) || st.token || '';
  const chat = (env && (env.CHAT_ID || env.ADMIN_CHAT)) || st.chat || '';
  return { token: String(token), chat: String(chat) };
}

async function tg(cfgv, method, payload) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + cfgv.token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

/* очередь сообщений сессии */
async function qGet(kv, sid) { try { return await kv.get('q:' + sid, 'json') || []; } catch (e) { return []; } }
async function qPush(kv, ctx, sid, m) {
  const a = await qGet(kv, sid);
  a.push(m);
  const cut = Date.now() - 172800000;
  const t = a.filter(x => x.ts > cut).slice(-200);
  await kv.put('q:' + sid, JSON.stringify(t), { expirationTtl: 172800 });
  ctx && ctx.waitUntil(Promise.resolve());
}
async function sessTouch(kv, sid) {
  try {
    const v = await kv.get('s:' + sid);
    const now = Date.now();
    if (v && parseInt(v, 10) > now - 300000) return; // пишем не чаще раза в 5 минут
    await kv.put('s:' + sid, String(now), { expirationTtl: 604800 });
  } catch (e) {}
}
async function sessList(kv) {
  const cur = await kv.list({ prefix: 's:', limit: 1000 });
  return cur.keys.map(k => k.name.slice(2));
}

/* ---------- сайт -> текст ---------- */

async function hMsg(req, kv, env, ctx) {
  const b = await req.json().catch(() => ({}));
  const sid = b.sid, cid = clean(b.cid, 40);
  if (!okSid(sid)) return j({ ok: false, error: 'bad sid' }, 400);
  if (b.hp) return j({ ok: true }); // honeypot
  const c = await cfg(kv, env);
  if (!c.token || !c.chat) return j({ ok: false, error: 'бот не настроен: откройте /setup?t=<токен>' }, 503);

  const name = clean(b.name, 60) || 'Гость';
  const text = clean(b.text, 3000);
  if (!text.trim()) return j({ ok: false, error: 'пустое сообщение' }, 400);

  const ts = Date.now();
  await qPush(kv, ctx, sid, { from: 'user', name, text, ts, cid: cid || undefined });
  await sessTouch(kv, sid);

  const sent = await tg(c, 'sendMessage', { chat_id: c.chat, text: '\uD83D\uDCAC ' + name + ': ' + text });
  if (sent.ok && sent.result && sent.result.message_id) {
    await kv.put('m:' + c.chat + ':' + sent.result.message_id, sid, { expirationTtl: 604800 });
  }
  return j({ ok: true, ts, cid: cid || undefined });
}

/* ---------- сайт -> голосовое ---------- */

async function hVoiceUp(req, kv, env, ctx) {
  const f = await req.formData().catch(() => null);
  if (!f) return j({ ok: false, error: 'нужен multipart/form-data' }, 400);
  const sid = String(f.get('sid') || ''), cid = clean(f.get('cid'), 40);
  if (!okSid(sid)) return j({ ok: false, error: 'bad sid' }, 400);
  const file = f.get('file');
  if (!file || typeof file === 'string') return j({ ok: false, error: 'нет файла' }, 400);
  if (file.size > 20 * 1024 * 1024) return j({ ok: false, error: 'файл больше 20 МБ' }, 413);

  const c = await cfg(kv, env);
  if (!c.token || !c.chat) return j({ ok: false, error: 'бот не настроен: откройте /setup?t=<токен>' }, 503);

  const name = clean(f.get('name'), 60) || 'Гость';
  const dur = parseInt(f.get('dur'), 10) || 0;
  const mime = file.type || 'audio/webm';
  const buf = await file.arrayBuffer();

  const fid = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await kv.put('a:' + fid, b64enc(buf), { expirationTtl: 604800, metadata: { mime } });

  const ts = Date.now();
  await qPush(kv, ctx, sid, { from: 'user', type: 'voice', fid, dur: dur || undefined, ts, cid: cid || undefined });
  await sessTouch(kv, sid);

  /* в Telegram админу */
  const ext = /ogg/.test(mime) ? 'ogg' : (/mp4|m4a|aac/.test(mime) ? 'm4a' : 'webm');
  const fd = new FormData();
  fd.append('chat_id', c.chat);
  fd.append('caption', '\uD83C\uDF99 Голосовое от ' + name);
  if (dur) fd.append('duration', String(dur));
  fd.append('voice', new Blob([buf], { type: mime }), 'voice.' + ext);
  let sent = await tgMultipart(c, 'sendVoice', fd);
  if (!sent.ok) {
    const fd2 = new FormData();
    fd2.append('chat_id', c.chat);
    fd2.append('caption', '\uD83C\uDF99 Голосовое от ' + name);
    fd2.append('document', new Blob([buf], { type: mime }), 'voice.' + ext);
    sent = await tgMultipart(c, 'sendDocument', fd2);
  }
  if (sent.ok && sent.result && sent.result.message_id) {
    await kv.put('m:' + c.chat + ':' + sent.result.message_id, sid, { expirationTtl: 604800 });
  }
  return j({ ok: true, ts, fid, dur: dur || undefined, cid: cid || undefined });
}

async function tgMultipart(c, method, fd) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + c.token + '/' + method, { method: 'POST', body: fd });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

/* ---------- аудио наружу ---------- */

async function hVoiceGet(url, kv) {
  const fid = url.searchParams.get('fid') || '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(fid)) return new Response('bad fid', { status: 400 });
  const res = await kv.getWithMetadata('a:' + fid, { type: 'arrayBuffer' });
  if (!res.value) return new Response('not found', { status: 404 });
  const mime = (res.metadata && res.metadata.mime) || 'audio/ogg';
  return new Response(res.value, {
    headers: cors({
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=86400',
      'Content-Disposition': 'inline; filename="voice.ogg"',
      'Accept-Ranges': 'none'
    })
  });
}

/* ---------- опрос очереди сайтом ---------- */

async function hPoll(url, kv, ctx) {
  const sid = url.searchParams.get('sid') || '';
  const since = parseInt(url.searchParams.get('since'), 10) || 0;
  if (!okSid(sid)) return j({ msgs: [] });
  const a = await qGet(kv, sid);
  const fresh = a.filter(m => m.ts > since);
  ctx.waitUntil(sessTouch(kv, sid));
  return j({ msgs: fresh });
}

/* ---------- Telegram -> сайт ---------- */

async function hWebhook(req, kv, env, ctx) {
  if (req.method === 'GET') return j({ ok: true });
  const c = await cfg(kv, env);
  const sec = env && env.WEBHOOK_SECRET;
  if (sec && req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== sec) return j({ ok: true });
  const up = await req.json().catch(() => null);
  if (!up || !up.message) return j({ ok: true });

  const msg = up.message;
  const chatId = msg.chat && String(msg.chat.id);

  if (!c.chat) {
    if (msg.text || msg.voice) {
      const st = await kv.get('settings', 'json').catch(() => ({})) || {};
      st.chat = chatId;
      await kv.put('settings', JSON.stringify(st));
      await tg(c, 'sendMessage', { chat_id: chatId, text: '\u2705 Этот чат назначен чатом администратора. Сообщения с сайта будут приходить сюда. Отвечайте reply-сообщением — уйдёт конкретному клиенту, без reply — всем активным. Можно голосом \uD83C\uDF99' });
    }
    return j({ ok: true });
  }
  if (chatId !== c.chat) return j({ ok: true });

  /* маршрутизация: ответ (reply) -> конкретная сессия */
  let target = null;
  const rid = msg.reply_to_message && msg.reply_to_message.message_id;
  if (rid) target = await kv.get('m:' + c.chat + ':' + rid);

  const ts = Date.now();
  const mk = (m) => Object.assign({ from: 'bot', ts }, m);

  /* голосовое от админа */
  if (msg.voice || msg.audio) {
    const v = msg.voice || msg.audio;
    const gf = await tg(c, 'getFile', { file_id: v.file_id });
    if (!gf.ok || !gf.result || !gf.result.file_path) return j({ ok: true });
    const fp = gf.result.file_path;
    let buf = null;
    try {
      const r = await fetch('https://api.telegram.org/file/bot' + c.token + '/' + fp);
      if (r.ok) buf = await r.arrayBuffer();
    } catch (e) {}
    if (!buf) return j({ ok: true });

    let fid = v.file_unique_id || ('t' + ts.toString(36));
    fid = fid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100) || ('t' + ts.toString(36));
    const mime = v.mime_type || (/\.ogg$/.test(fp) ? 'audio/ogg' : 'audio/mpeg');
    await kv.put('a:' + fid, b64enc(buf), { expirationTtl: 604800, metadata: { mime } });

    const vm = mk({ type: 'voice', fid, dur: v.duration || undefined });
    if (target && okSid(target)) await qPush(kv, ctx, target, vm);
    else await broadcast(kv, ctx, vm);
    return j({ ok: true });
  }

  /* текст от админа */
  if (msg.text) {
    const t = msg.text.trim();
    if (t === '/id') { await tg(c, 'sendMessage', { chat_id: chatId, text: 'chat_id = ' + chatId }); return j({ ok: true }); }
    if (t === '/start') { await tg(c, 'sendMessage', { chat_id: chatId, text: 'Готов к работе. Отвечайте на сообщение клиента (reply) — уйдёт только ему; без reply — всем активным посетителям сайта. Можно слать голосовые.' }); return j({ ok: true }); }
    if (!target) {
      const tm = msg.reply_to_message;
      if (tm && tm.text) {
        const mm = tm.text.match(/#s:([A-Za-z0-9_-]+)/);
        if (mm && okSid(mm[1])) target = mm[1];
      }
    }
    const bm = mk({ text: t.slice(0, 3000) });
    if (target && okSid(target)) await qPush(kv, ctx, target, bm);
    else await broadcast(kv, ctx, bm);
  }
  return j({ ok: true });
}

async function broadcast(kv, ctx, m) {
  const sids = await sessList(kv);
  const min = Date.now() - 86400000;
  let n = 0;
  for (const s of sids) {
    if (n >= 200) break;
    try {
      const v = await kv.get('s:' + s);
      if (!v || parseInt(v, 10) < min) continue;
      await qPush(kv, ctx, s, m);
      n++;
    } catch (e) {}
  }
}

/* ---------- страница настройки ---------- */

async function hSetup(req, url, kv, env, ctx) {
  const c0 = await cfg(kv, env);
  const tok = url.searchParams.get('t') || '';

  if (req.method === 'GET' && !tok && !c0.token) {
    return new Response(setupHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const effTok = tok || c0.token;

  /* первый запуск: сохранить токен */
  if (!c0.token) {
    if (req.method !== 'POST' || !body.token) {
      return new Response(setupHTML(), { status: tok ? 200 : 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const nt = clean(body.token, 64);
    if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(nt)) return j({ ok: false, error: 'токен похож на неверный' }, 400);
    const st = await kv.get('settings', 'json').catch(() => ({})) || {};
    st.token = nt;
    await kv.put('settings', JSON.stringify(st));
    return j({ ok: true, saved: 'token' });
  }

  if (effTok !== c0.token) return j({ ok: false, error: 'неверный токен' }, 403);
  const c = c0;

  if (body.action === 'status') return j(await setupStatus(c));

  if (body.action === 'list_chats') {
    const gu = await tg(c, 'getUpdates', { limit: 100, timeout: 0 });
    if (!gu.ok) return j({ ok: false, error: gu.error_code === 409 ? 'вебхук включён — сначала выключите его' : (gu.description || 'ошибка getUpdates') });
    const seen = {}, chats = [];
    for (const u of (gu.result || [])) {
      for (const key of ['message', 'channel_post']) {
        const m = u[key];
        if (m && m.chat) {
          const id = String(m.chat.id);
          if (!seen[id]) { seen[id] = 1; chats.push({ id, title: m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || id, type: m.chat.type }); }
        }
      }
    }
    return j({ ok: true, chats });
  }

  if (body.action === 'set_chat') {
    const id = clean(body.chat, 32);
    if (!/^-?\d{3,}$/.test(id)) return j({ ok: false, error: 'неверный chat id' }, 400);
    const st = await kv.get('settings', 'json').catch(() => ({})) || {};
    st.chat = id;
    await kv.put('settings', JSON.stringify(st));
    return j({ ok: true, chat: id });
  }

  if (body.action === 'set_wh') {
    const origin = new URL(req.url).origin;
    const p = { url: origin + '/webhook', allowed_updates: ['message'] };
    if (env && env.WEBHOOK_SECRET) p.secret_token = env.WEBHOOK_SECRET;
    const r = await tg(c, 'setWebhook', p);
    return j(r.ok ? { ok: true } : { ok: false, error: r.description || 'setWebhook failed' });
  }

  if (body.action === 'del_wh') {
    const r = await tg(c, 'deleteWebhook', {});
    return j(r.ok ? { ok: true } : { ok: false, error: r.description || 'failed' });
  }

  if (body.action === 'test') {
    const r = await tg(c, 'sendMessage', { chat_id: c.chat, text: '\u2705 Тест: этот чат назначен админским для чата сайта.' });
    return j(r.ok ? { ok: true } : { ok: false, error: r.description || 'бот не может написать в этот чат' });
  }

  return j(await setupStatus(c));
}

async function setupStatus(c) {
  const wh = c.token ? await tg(c, 'getWebhookInfo', {}) : { ok: false };
  return {
    ok: true,
    token_set: !!c.token,
    chat: c.chat || null,
    webhook: wh.ok ? { url: wh.result.url || '', pending: wh.result.pending_update_count || 0 } : null
  };
}

function setupHTML() {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Настройка чата СОКРЕМОНТ</title><style>
body{font-family:system-ui,sans-serif;background:#F4F6F8;color:#12212e;max-width:560px;margin:30px auto;padding:0 16px}
h1{font-size:20px}.card{background:#fff;border-radius:14px;padding:18px;margin-bottom:14px;box-shadow:0 4px 16px rgba(13,27,42,.08)}
button{border:0;border-radius:10px;padding:10px 16px;background:#2AABEE;color:#fff;font-size:14px;cursor:pointer}
button.gray{background:#E7ECF1;color:#33475b}button.red{background:#D0344A}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d6dee6;border-radius:10px;font-size:14px;margin-top:8px}
.row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #eef2f5}
.row:last-child{border-bottom:0}.row small{color:#7a8894}.st{font-size:13px;line-height:1.6}
#log{font-size:13px;background:#fff;border-radius:10px;padding:10px;margin-top:12px;display:none;white-space:pre-wrap}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.on{background:#27ae60}.off{background:#c0392b}
</style></head><body>
<h1>\uD83D\uDCDD Настройка чата СОКРЕМОНТ</h1>

<div class="card" id="tokCard" style="display:none">
  <b>Шаг 1. Токен бота</b>
  <input id="tokIn" placeholder="1234567890:AA...">
  <p style="margin-bottom:0"><button onclick="saveTok()">Сохранить токен</button></p>
</div>

<div class="card">
  <b>Состояние</b><div class="st" id="st">загрузка...</div>
  <p style="margin:10px 0 0">
    <button class="gray" onclick="act('test')">Тест: написать мне в чат</button>
    <button class="gray" onclick="act('del_wh')">Выключить вебхук</button>
    <button onclick="act('set_wh')">Включить вебхук</button>
  </p>
</div>

<div class="card">
  <b>Чат администратора</b>
  <p style="font-size:13px;color:#5b6b7b;margin:6px 0">Напишите боту любое сообщение в Telegram, затем нажмите кнопку.</p>
  <button class="gray" onclick="listChats()">Найти чаты</button>
  <div id="chats"></div>
</div>

<div id="log"></div>
<script>
var T = location.search.match(/[?&]t=([^&]+)/) ? decodeURIComponent(location.search.match(/[?&]t=([^&]+)/)[1]) : '';
function api(body){return fetch('/setup'+(T?'?t='+encodeURIComponent(T):''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json();});}
function log(s,m){var l=document.getElementById('log');l.style.display='block';l.style.color=m?'#c0392b':'#12212e';l.textContent=s;}
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function status(){api({action:'status'}).then(function(d){
  if(!d.ok){log(d.error||'ошибка',true);return;}
  var s='';
  s+='<span class="dot '+(d.token_set?'on':'off')+'"></span>токен: '+(d.token_set?'установлен':'НЕТ — введите ниже')+'<br>';
  s+='<span class="dot '+(d.chat?'on':'off')+'"></span>чат админа: '+(d.chat?esc(d.chat):'не выбран')+'<br>';
  if(d.webhook){s+='<span class="dot '+(d.webhook.url?'on':'off')+'"></span>вебхук: '+(d.webhook.url?esc(d.webhook.url)+' (ожидают: '+d.webhook.pending+')':'выключен');}
  document.getElementById('st').innerHTML=s;
  if(!d.token_set)document.getElementById('tokCard').style.display='block';
}).catch(function(e){log(String(e),true);});}
function saveTok(){var v=document.getElementById('tokIn').value.trim();if(!v)return log('введите токен',true);
  fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:v})}).then(function(r){return r.json();})
  .then(function(d){if(d.ok){log('токен сохранён. Обновите страницу с ?t='+v,false);}else log(d.error||'ошибка',true);});}
function act(a){api({action:a}).then(function(d){log(d.ok?('готово: '+a):(d.error||'ошибка'),!d.ok);status();}).catch(function(e){log(String(e),true);});}
function listChats(){api({action:'list_chats'}).then(function(d){
  var el=document.getElementById('chats');el.innerHTML='';
  if(!d.ok)return log(d.error||'ошибка',true);
  if(!d.chats.length){el.innerHTML='<p style="font-size:13px;color:#c0392b">Чатов не найдено. Напишите боту в Telegram и повторите.</p>';return;}
  d.chats.forEach(function(ch){
    var r=document.createElement('div');r.className='row';
    r.innerHTML='<div style="flex:1"><b>'+esc(ch.title)+'</b><br><small>'+esc(ch.id)+' · '+esc(ch.type)+'</small></div>';
    var b=document.createElement('button');b.textContent='Выбрать';
    b.onclick=function(){api({action:'set_chat',chat:ch.id}).then(function(dd){log(dd.ok?('чат выбран: '+ch.id):(dd.error||'ошибка'),!dd.ok);status();});};
    r.appendChild(b);el.appendChild(r);
  });
}).catch(function(e){log(String(e),true);});}
status();
</script></body></html>`;
}
