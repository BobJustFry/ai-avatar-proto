// Фотореалистичный аватар от внешнего провайдера.
//
// Важно понимать разницу с локальным ригом: провайдерские аватары ведутся
// ЗВУКОМ, а не вашим лицом. Мимика и повороты головы генерируются моделью из
// речи; ваши собственные движения в кадр не переносятся. Взамен получается
// фотореализм, которого плоский риг не даёт.
//
// Реализован LiveAvatar (HeyGen) в режиме LITE: мы шлём свой звук, он рендерит
// видео. Ключ провайдера в браузер не попадает — всё через server/live-server.mjs.
//
// Голос у аватара бывает двух видов:
//   "mic"    — говорит вашим голосом: микрофон уходит провайдеру как есть;
//   "tts"    — синтез: текст уходит на сервер, тот озвучивает и шлёт готовый звук.
// Сессия у обоих одна и та же, меняется только источник звука.

const LIVEKIT_ESM = "https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.esm.mjs";

// Провайдер требует PCM 16 бит, 24 кГц, моно; чанк ~1 секунда.
const SAMPLE_RATE = 24000;

// AudioWorklet собирает секундные куски микрофона. Инлайним, чтобы не плодить
// файлов: воркер обязан быть отдельным модулем, но может жить в blob-URL.
const TAP_WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.parts = []; this.count = 0; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    this.parts.push(new Float32Array(ch));
    this.count += ch.length;
    if (this.count >= sampleRate) {
      const out = new Float32Array(this.count);
      let o = 0;
      for (const p of this.parts) { out.set(p, o); o += p.length; }
      this.port.postMessage(out, [out.buffer]);
      this.parts = []; this.count = 0;
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;

function floatToBase64Pcm16(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  const CHUNK = 0x8000; // btoa давится слишком длинным apply
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export class LiveAvatarProvider {
  constructor({ api = "/api/live" } = {}) {
    this.api = api;
    this.voiceMode = "mic";
    this.session = null;
    this.room = null;
    this.video = null;     // HTMLVideoElement с аватаром
    this.audioTrack = null; // голос, который слышит зритель
    this.mic = null;
    this.audioCtx = null;
    this.onState = () => {};
  }

  get active() {
    return !!this.session;
  }

  async #post(path, body) {
    const res = await fetch(`${this.api}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  async listAvatars() {
    const res = await fetch(`${this.api}/avatars`);
    if (!res.ok) throw new Error(`не удалось получить список аватаров: ${res.status}`);
    return res.json();
  }

  async listVoices() {
    const res = await fetch(`${this.api}/voices`);
    if (!res.ok) throw new Error(`не удалось получить список голосов: ${res.status}`);
    return res.json();
  }

  /**
   * Поднимает сессию и начинает гнать микрофон в провайдера.
   * @param avatarId — id из каталога провайдера
   * @param quality — very_high самый качественный, он же самый дорогой по трафику
   */
  async start({ avatarId, quality = "very_high", sandbox = false, voiceMode = "mic" } = {}) {
    this.voiceMode = voiceMode;
    this.onState("сессия…");
    this.session = await this.#post("/session", { avatarId, quality, sandbox });

    this.onState("подключаюсь к комнате…");
    const { Room, RoomEvent } = await import(LIVEKIT_ESM);
    const room = new Room({ adaptiveStream: false, dynacast: false });
    this.room = room;

    const gotVideo = new Promise((resolve) => {
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === "video") {
          this.video = track.attach();
          this.video.muted = true;
          this.video.playsInline = true;
          resolve();
        } else if (track.kind === "audio") {
          // Голос аватара: в эфир его отдаём отдельной дорожкой.
          this.audioTrack = track.mediaStreamTrack;
        }
      });
    });
    room.on(RoomEvent.Disconnected, () => this.onState("комната отключилась"));

    await room.connect(this.session.livekitUrl, this.session.livekitToken);
    await Promise.race([gotVideo, new Promise((_, rej) =>
      setTimeout(() => rej(new Error("аватар не прислал видео за 20 с")), 20_000))]);

    if (this.voiceMode === "mic") await this.#startMic();
    this.onState(this.voiceMode === "mic" ? "говорит вашим голосом" : "готов озвучивать текст");
    return this.video;
  }

  async #startMic() {
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    // Контекст на 24 кГц: браузер сам передискретизирует вход, руками не надо.
    this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "text/javascript" }));
    await this.audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const src = this.audioCtx.createMediaStreamSource(this.mic);
    const tap = new AudioWorkletNode(this.audioCtx, "pcm-tap");
    tap.port.onmessage = (e) => this.#sendAudio(e.data);
    // Узел должен быть подключён к графу, иначе часть браузеров его не запускает.
    // Через нулевой gain, чтобы не получить эхо собственного голоса в колонках.
    const mute = this.audioCtx.createGain();
    mute.gain.value = 0;
    src.connect(tap);
    tap.connect(mute);
    mute.connect(this.audioCtx.destination);
  }

  #sendAudio(float32) {
    if (!this.session) return;
    const audio = floatToBase64Pcm16(float32);
    // Не ждём ответа: очередь чанков важнее, чем подтверждение каждого.
    this.#post("/audio", { sessionId: this.session.sessionId, audio })
      .catch((err) => this.onState(`звук не ушёл: ${err.message}`));
  }

  /** Переключение между «мой голос» и синтезом на живой сессии. */
  async setVoiceMode(mode) {
    if (mode === this.voiceMode) return;
    this.voiceMode = mode;
    if (mode === "mic") {
      if (this.session) await this.#startMic();
      this.onState("говорит вашим голосом");
    } else {
      this.#stopMic();
      this.interrupt();
      this.onState("готов озвучивать текст");
    }
  }

  /** Синтез: сервер озвучит текст и отдаст звук аватару. */
  async say(text, voiceId) {
    if (!this.session) throw new Error("сессия не поднята");
    const r = await this.#post("/say", { sessionId: this.session.sessionId, text, voiceId });
    this.onState(`сказал ${r.seconds ?? "?"} с`);
    return r;
  }

  #stopMic() {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  /** Обрывает текущую фразу — например, когда вы начали говорить заново. */
  interrupt() {
    if (this.session) this.#post("/interrupt", { sessionId: this.session.sessionId }).catch(() => {});
  }

  async stop() {
    this.#stopMic();
    await this.room?.disconnect().catch(() => {});
    this.room = null;
    if (this.session) {
      await this.#post("/stop", { sessionId: this.session.sessionId }).catch(() => {});
      this.session = null;
    }
    this.video = null;
    this.audioTrack = null;
    this.onState("остановлено");
  }
}
