--9de8920d958146fbf77eec78fa7bf45782c3e49e9c1e73d5a9831a719fd7
Content-Disposition: form-data; name="worker.js"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export class ChatStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async tg(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  async getLog(sid) {
    return (await this.state.storage.get("log:" + sid)) || [];
  }

  async saveLog(sid, log) {
    if (log.length > 100) log = log.slice(-100);
    await this.state.storage.put("log:" + sid, log);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (path === "/health") {
      const owner = await this.state.storage.get("owner_chat_id");
      return json({ ok: true, ts: Date.now(), ownerSet: !!owner });
    }

    if (path === "/msg" && request.method === "POST") {
      let data;
      try {
        data = await request.json();
      } catch (e) {
        return json({ ok: false, error: "bad json" });
      }
      if (data.hp) return json({ ok: true });
      const sid = String(data.sid || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
      const text = String(data.text || "").slice(0, 1000).trim();
      const name = String(data.name || "Гость").replace(/[\r\n]/g, " ").slice(0, 60);
      if (!sid || !text) return json({ ok: false, error: "bad input" });
      const now = Date.now();
      const rl = (await this.state.storage.get("rl:" + sid)) || { c: 0, at: 0 };
      const cnt = now - rl.at < 60000 ? rl.c : 0;
      if (cnt > 10) return json({ ok: false, error: "Слишком много сообщений, подожди минуту" });
      await this.state.storage.put("rl:" + sid, { c: cnt + 1, at: now });

      const ownerId = await this.state.storage.get("owner_chat_id");
      const cid = String(data.cid || "").slice(0, 64);
      const log = await this.getLog(sid);
      log.push({ from: "user", name, text, ts: now, cid });
      await this.saveLog(sid, log);
      await this.state.storage.put("active_sid", sid);

      if (ownerId) {
        await this.tg("sendMessage", {
          chat_id: ownerId,
          text: `💬 Сообщение с сайта\nОт: ${name}\n\n${text}`,
        }).catch(() => {});
      }
      return json({ ok: true, ts: now });
    }

    if (path === "/poll" && request.method === "GET") {
      const sid = String(url.searchParams.get("sid") || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
      const since = parseInt(url.searchParams.get("since") || "0") || 0;
      if (!sid) return json({ ok: false });
      const log = await this.getLog(sid);
      const msgs = log
        .filter((m) => m.ts > since)
        .map((m) => ({ from: m.from, name: m.name, text: m.text, ts: m.ts }));
      return json({ ok: true, msgs });
    }

    if (path === "/voice" && request.method === "GET") {
      const fid = String(url.searchParams.get("fid") || "").slice(0, 200);
      if (!fid) return json({ ok: false });
      const gf = await this.tg("getFile", { file_id: fid });
      if (!gf.ok || !gf.result || !gf.result.file_path) return json({ ok: false, error: "file gone" }, 404);
      const fr = await fetch(`https://api.telegram.org/file/bot${this.env.BOT_TOKEN}/${gf.result.file_path}`);
      if (!fr.ok) return json({ ok: false, error: "fetch fail" }, 502);
      return new Response(fr.body, {
        headers: { "Content-Type": "audio/ogg", "Cache-Control": "private, max-age=3600", ...CORS },
      });
    }

    if (path === "/tgwebhook" && request.method === "POST") {
      let update;
      try {
        update = await request.json();
      } catch (e) {
        return new Response("ok");
      }
      const msg = update.message;
      if (msg && msg.chat) {
        const savedOwner = await this.state.storage.get("owner_chat_id");
        if (!savedOwner) {
          if (msg.text) {
            await this.state.storage.put("owner_chat_id", String(msg.chat.id));
            await this.tg("sendMessage", {
              chat_id: msg.chat.id,
              text: "✅ Чат подключён! Сообщения с сайта будут приходить сюда. Отвечай простым сообщением — оно уйдёт посетителю. Можно отправлять и голосовые 🎤",
            }).catch(() => {});
          }
        } else if (String(msg.chat.id) === savedOwner) {
          const sid = await this.state.storage.get("active_sid");
          if (sid) {
            const v = msg.voice || msg.audio;
            const log = await this.getLog(sid);
            if (v && v.file_id) {
              log.push({ from: "bot", type: "voice", fid: String(v.file_id), dur: v.duration || 0, ts: Date.now() });
              await this.saveLog(sid, log);
              await this.tg("sendMessage", { chat_id: savedOwner, text: "🎤 Голосовое отправлено посетителю на сайте." }).catch(() => {});
            } else if (msg.text) {
              log.push({ from: "bot", text: String(msg.text).slice(0, 1000), ts: Date.now() });
              await this.saveLog(sid, log);
            } else {
              await this.tg("sendMessage", { chat_id: savedOwner, text: "Пока поддерживаются только текст и голосовые 🎤" }).catch(() => {});
            }
          }
        }
      }
      return new Response("ok");
    }

    if (path === "/setup") {
      const wh = await this.tg("setWebhook", { url: "https://" + url.host + "/tgwebhook" });
      const gu = await this.tg("getUpdates", { limit: 10 });
      let chatId = null;
      for (const u of gu.result || []) {
        if (u.message && u.message.chat) chatId = u.message.chat.id;
      }
      if (chatId) await this.state.storage.put("owner_chat_id", String(chatId));
      return json({ webhook: wh.ok, chatId, updatesCount: (gu.result || []).length });
    }

    return new Response("not found", { status: 404, headers: CORS });
  }
}

export default {
  async fetch(request, env) {
    const id = env.CHAT_DO.idFromName("main");
    return env.CHAT_DO.get(id).fetch(request);
  },
};

--9de8920d958146fbf77eec78fa7bf45782c3e49e9c1e73d5a9831a719fd7--
