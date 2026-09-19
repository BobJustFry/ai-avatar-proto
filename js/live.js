// Вывод готового кадра в прямой эфир по WHIP (WebRTC-HTTP Ingestion Protocol,
// RFC 9725). Это то, что принимают Cloudflare Stream, Livepeer, Dolby, Cloudflare
// Realtime и почти любой современный медиасервер (MediaMTX, Janus, OME).
// Браузер не умеет RTMP, поэтому путь на Twitch/YouTube — либо WHIP-шлюз,
// либо OBS: см. docs/streaming.md.

const ICE = [{ urls: "stun:stun.l.google.com:19302" }];

/** Ждём сбор ICE, но не бесконечно: половина серверов и так работает с trickle. */
function iceReady(pc, timeoutMs = 2500) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export class WhipPublisher {
  constructor() {
    this.pc = null;
    this.resourceUrl = null;
    this.token = null;
    this.stream = null;
  }

  get active() {
    return !!this.pc && this.pc.connectionState !== "closed";
  }

  /**
   * @param canvas — источник картинки
   * @param url — WHIP endpoint
   * @param token — Bearer, если требует провайдер
   * @param audioTrack — дорожка микрофона или голоса аватара
   * @param fps, bitrate — параметры кодирования
   */
  async start(canvas, { url, token, audioTrack, fps = 30, bitrate = 4_000_000 } = {}) {
    if (!url) throw new Error("не задан WHIP URL");
    this.token = token || null;

    const stream = canvas.captureStream(fps);
    if (audioTrack) stream.addTrack(audioTrack);
    this.stream = stream;

    const pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: "max-bundle" });
    this.pc = pc;
    for (const track of stream.getTracks()) {
      // sendonly: мы только публикуем, обратный поток не нужен
      pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
    }

    // Битрейт задаём до обмена SDP, иначе браузер уедет на свои ~2.5 Мбит.
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const params = sender.getParameters();
      params.encodings = [{ maxBitrate: bitrate, maxFramerate: fps }];
      await sender.setParameters(params).catch(() => {});
    }

    await pc.setLocalDescription(await pc.createOffer());
    await iceReady(pc);

    const headers = { "Content-Type": "application/sdp" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: pc.localDescription.sdp });
    } catch (err) {
      await this.stop();
      throw new Error(`WHIP недоступен (${err.message}). Частая причина — CORS: эндпоинт должен разрешать запрос из браузера.`);
    }
    if (!res.ok) {
      await this.stop();
      throw new Error(`WHIP ответил ${res.status} ${res.statusText}`);
    }

    const location = res.headers.get("Location");
    this.resourceUrl = location ? new URL(location, url).toString() : null;
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    return { resourceUrl: this.resourceUrl };
  }

  /** Состояние соединения для индикатора в интерфейсе. */
  get state() {
    return this.pc?.connectionState ?? "closed";
  }

  async stop() {
    // По спецификации сессия закрывается DELETE по выданному Location.
    if (this.resourceUrl) {
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
      await fetch(this.resourceUrl, { method: "DELETE", headers }).catch(() => {});
      this.resourceUrl = null;
    }
    this.pc?.close();
    this.pc = null;
    this.stream = null;
  }
}
