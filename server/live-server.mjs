// Минимальный сервер для лайв-режима. Нужен по одной причине: ключ провайдера
// не должен попадать в браузер. Заодно раздаёт статику, чтобы всё поднималось
// одной командой.
//
// Зависимостей нет: Node 22+ умеет fetch и WebSocket из коробки.
//
//   set LIVEAVATAR_API_KEY=...   (Windows: setx, или .env через свой запуск)
//   node server/live-server.mjs
//
// Роль этого процесса в терминах LiveAvatar — «агент»: он держит WebSocket и
// шлёт звук, а браузер только принимает видео из комнаты LiveKit.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const PORT = Number(process.env.PORT ?? 5173);
const API_KEY = process.env.LIVEAVATAR_API_KEY ?? "";
const API = process.env.LIVEAVATAR_API ?? "https://api.liveavatar.com";

// Синтез голоса. pcm_24000 у ElevenLabs — ровно тот формат, который ждёт
// аватар (PCM 16 бит, 24 кГц, моно), так что перекодировать ничего не нужно.
const TTS_KEY = process.env.ELEVENLABS_API_KEY ?? "";
const TTS_VOICE = process.env.ELEVENLABS_VOICE_ID ?? "";
const TTS_MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2";
const TTS_API = "https://api.elevenlabs.io/v1";

// Секунда звука: 24000 отсчётов по 2 байта. Провайдер просит чанки такого размера.
const CHUNK_BYTES = 24000 * 2;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".svg": "image/svg+xml",
};

/** Активные сессии: sessionId -> { ws, sessionToken, speaking } */
const sessions = new Map();

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function api(path, { method = "POST", key, bearer, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-API-KEY"] = key;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || data?.detail || text || res.statusText;
    throw new Error(`${path} → ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return data;
}

/** Открывает WebSocket агента и ждёт, пока сессия действительно подключится. */
function openAgentSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error("WebSocket не подтвердил подключение за 20 с")), 20_000);

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      // Слать команды можно только после state "connected".
      if (msg.type === "session.state_updated" && msg.state === "connected") {
        clearTimeout(timer);
        resolve(ws);
      }
      if (msg.type?.endsWith("error")) console.error("[liveavatar]", msg);
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket не открылся: ${e.message ?? "см. лог"}`));
    });
    ws.addEventListener("close", () => clearTimeout(timer));
  });
}

const send = (ws, payload) => ws.readyState === 1 && ws.send(JSON.stringify(payload));

async function ttsPcm24k(text, voiceId) {
  if (!TTS_KEY) throw new Error("не задан ELEVENLABS_API_KEY");
  const voice = voiceId || TTS_VOICE;
  if (!voice) throw new Error("не задан голос: ELEVENLABS_VOICE_ID или voiceId в запросе");
  const res = await fetch(`${TTS_API}/text-to-speech/${voice}?output_format=pcm_24000`, {
    method: "POST",
    headers: { "xi-api-key": TTS_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: TTS_MODEL }),
  });
  if (!res.ok) throw new Error(`синтез не удался (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Отдаёт готовый звук аватару чанками по секунде и закрывает фразу. */
function speakPcm(ws, pcm) {
  for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
    send(ws, { type: "agent.speak", audio: pcm.subarray(i, i + CHUNK_BYTES).toString("base64") });
  }
  send(ws, { type: "agent.speak_end" });
}

// --- API лайв-режима ---------------------------------------------------------

async function handleApi(req, res, path) {
  // Список голосов относится к синтезу — ключ провайдера для него не нужен.
  if (path === "/api/live/voices" && req.method === "GET") {
    if (!TTS_KEY) return json(res, 200, { voices: [] });
    const res2 = await fetch(`${TTS_API}/voices`, { headers: { "xi-api-key": TTS_KEY } });
    if (!res2.ok) return json(res, 502, { error: `список голосов: ${res2.status}` });
    const data = await res2.json();
    return json(res, 200, {
      voices: (data.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name })),
      current: TTS_VOICE,
    });
  }

  if (!API_KEY) return json(res, 500, { error: "не задан LIVEAVATAR_API_KEY" });

  if (path === "/api/live/avatars" && req.method === "GET") {
    const data = await api("/v1/avatars/public?page=1&page_size=50", { method: "GET", key: API_KEY });
    return json(res, 200, data?.data ?? data);
  }

  if (path === "/api/live/session" && req.method === "POST") {
    const { avatarId, quality = "very_high", sandbox = false } = await readJson(req);
    if (!avatarId) return json(res, 400, { error: "нужен avatarId" });

    const tokenRes = await api("/v1/sessions/token", {
      key: API_KEY,
      body: {
        mode: "LITE",
        avatar_id: avatarId,
        is_sandbox: !!sandbox,
        video_settings: { quality, encoding: "H264" },
      },
    });
    const sessionToken = tokenRes.data.session_token;

    const startRes = await api("/v1/sessions/start", { bearer: sessionToken });
    const s = startRes.data;
    if (!s.ws_url) throw new Error("сервер не вернул ws_url — проверьте, что режим токена LITE");

    const ws = await openAgentSocket(s.ws_url);
    sessions.set(s.session_id, { ws, sessionToken, speaking: false });
    send(ws, { type: "agent.start_listening" });

    return json(res, 200, {
      sessionId: s.session_id,
      livekitUrl: s.livekit_url,
      livekitToken: s.livekit_client_token,
    });
  }

  const body = req.method === "POST" ? await readJson(req) : {};
  const session = sessions.get(body.sessionId);
  if (!session) return json(res, 404, { error: "сессия не найдена" });

  if (path === "/api/live/audio") {
    if (!body.audio) return json(res, 400, { error: "нет audio" });
    send(session.ws, { type: "agent.speak", audio: body.audio });
    session.speaking = true;
    return json(res, 200, { ok: true });
  }

  if (path === "/api/live/say") {
    if (!body.text?.trim()) return json(res, 400, { error: "нет текста" });
    // Новая фраза перебивает предыдущую, иначе они склеятся в одну.
    if (session.speaking) send(session.ws, { type: "agent.interrupt" });
    const pcm = await ttsPcm24k(body.text.trim(), body.voiceId);
    speakPcm(session.ws, pcm);
    session.speaking = false; // speak_end уже отправлен
    return json(res, 200, { ok: true, seconds: +(pcm.length / CHUNK_BYTES).toFixed(1) });
  }

  if (path === "/api/live/interrupt") {
    send(session.ws, { type: "agent.interrupt" });
    session.speaking = false;
    return json(res, 200, { ok: true });
  }

  if (path === "/api/live/stop") {
    if (session.speaking) send(session.ws, { type: "agent.speak_end" });
    session.ws.close();
    sessions.delete(body.sessionId);
    await api("/v1/sessions/stop", { bearer: session.sessionToken, body: { reason: "USER_CLOSED" } })
      .catch((err) => console.warn("[liveavatar] stop:", err.message));
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "неизвестный метод" });
}

// --- статика -----------------------------------------------------------------

async function serveStatic(res, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  const file = join(ROOT, rel === "" ? "index.html" : rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? join(file, "index.html") : file;
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  try {
    if (path.startsWith("/api/live")) return await handleApi(req, res, path);
    await serveStatic(res, path);
  } catch (err) {
    console.error("[server]", err);
    json(res, 500, { error: err.message });
  }
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  console.log(API_KEY
    ? "LIVEAVATAR_API_KEY найден — лайв-режим с провайдером доступен"
    : "LIVEAVATAR_API_KEY не задан — работает всё, кроме провайдерского аватара");
  console.log(TTS_KEY
    ? "ELEVENLABS_API_KEY найден — доступен режим «Синтез голоса»"
    : "ELEVENLABS_API_KEY не задан — из голосовых режимов работает только «Мой голос»");
});
