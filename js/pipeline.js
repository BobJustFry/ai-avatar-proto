// Конвейер «видео на входе → видео с аватаром на выходе».
// Исходник проигрывается в реальном времени, каждый кадр проходит трекинг и
// отрисовку, а MediaRecorder пишет канвас вместе с оригинальной звуковой дорожкой.
// Поэтому голос в результате — ваш, а лицо и фон — синтетические.

const MIME = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const pickMime = () => MIME.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";

/** Запись исходника с камеры и микрофона — чтобы не выходить из вкладки. */
export class SourceRecorder {
  constructor() {
    this.rec = null;
    this.chunks = [];
    this.mic = null;
  }

  get active() {
    return this.rec?.state === "recording";
  }

  async start(cameraStream) {
    const stream = new MediaStream(cameraStream.getVideoTracks());
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of this.mic.getAudioTracks()) stream.addTrack(t);
    } catch {
      // без микрофона запишем немое видео
    }
    this.chunks = [];
    this.rec = new MediaRecorder(stream, { mimeType: pickMime() });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    return { withAudio: !!this.mic };
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.rec) return resolve(null);
      const rec = this.rec;
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || "video/webm" });
        this.mic?.getTracks().forEach((t) => t.stop());
        this.mic = null;
        this.rec = null;
        resolve(blob);
      };
      rec.stop();
    });
  }
}

export class VideoProcessor {
  constructor(canvas) {
    this.canvas = canvas;
    this.video = document.createElement("video");
    Object.assign(this.video, { playsInline: true, preload: "auto" });
    this.audioCtx = null;
    this.audioSrc = null;
    this.cancelled = false;
    // Отдельный источник звука: картинку даёт результат замены, речь — исходник.
    this.audioEl = null;
    this.audioUrl = null;
  }

  /** Подключает звук из другого файла. Без него звук берётся из основного видео. */
  async openAudio(fileOrBlob) {
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    if (!fileOrBlob) { this.audioEl = null; this.audioUrl = null; return null; }
    this.audioUrl = URL.createObjectURL(fileOrBlob);
    const el = document.createElement("video");
    Object.assign(el, { playsInline: true, preload: "auto", src: this.audioUrl });
    await new Promise((resolve, reject) => {
      el.onloadedmetadata = resolve;
      el.onerror = () => reject(new Error("не удалось прочитать файл со звуком"));
    });
    this.audioEl = el;
    return { duration: el.duration };
  }

  /** Загружает источник и возвращает его метаданные. */
  async open(fileOrBlob) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(fileOrBlob);
    this.video.src = this.url;
    await new Promise((resolve, reject) => {
      this.video.onloadedmetadata = resolve;
      this.video.onerror = () => reject(new Error("не удалось прочитать видео"));
    });
    return {
      duration: this.video.duration,
      width: this.video.videoWidth,
      height: this.video.videoHeight,
    };
  }

  cancel() {
    this.cancelled = true;
    this.video.pause();
  }

  /**
   * Прогоняет источник через onFrame и пишет результат с канваса.
   * @param onFrame (videoEl, dt) — ваш трекинг и отрисовка одного кадра
   * @param onProgress (0..1)
   * @param schedule — чем гнать цикл; по умолчанию rAF, но его можно подменить
   *        (например таймером, когда вкладка заведомо скрыта)
   * @param pauseWhenHidden — замирать ли целиком, когда вкладку убрали
   * @returns Blob готового видео
   */
  async run({ onFrame, onProgress, fps = 30, schedule = requestAnimationFrame, pauseWhenHidden = true }) {
    const v = this.video;
    this.cancelled = false;
    v.currentTime = 0;

    const stream = this.canvas.captureStream(fps);
    // Звук тянем через WebAudio: элемент при этом молчит в колонках,
    // но дорожка в записи остаётся полноценной.
    const soundEl = this.audioEl ?? v;
    if (this.audioEl) this.audioEl.currentTime = 0;
    try {
      this.audioCtx ??= new AudioContext();
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
      // createMediaElementSource можно звать по разу на элемент, поэтому кешируем.
      this.audioSrc ??= this.audioCtx.createMediaElementSource(soundEl);
      const dest = this.audioCtx.createMediaStreamDestination();
      this.audioSrc.connect(dest);
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    } catch (err) {
      console.warn("Звук исходника подмешать не удалось:", err);
    }

    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: pickMime() });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    const done = new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || "video/webm" }));
    });

    rec.start(250);
    // Результат замены приходит без звука, а немое видео браузер останавливает
    // в фоновой вкладке ради энергосбережения. Сообщаем это человеческим языком,
    // вместо того чтобы падать с AbortError.
    try {
      await v.play();
    } catch (err) {
      rec.stop();
      throw new Error(
        err.name === "AbortError"
          ? "браузер остановил воспроизведение — вкладка должна оставаться видимой"
          : `не удалось запустить исходник: ${err.message}`,
      );
    }
    if (this.audioEl) await this.audioEl.play().catch(() => {});

    // В скрытой вкладке requestAnimationFrame замирает, а запись — нет:
    // без этого звук уехал бы относительно картинки. Замираем целиком.
    let hiddenPause = false;
    let last = performance.now();
    let step;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenPause = true;
        v.pause();
        this.audioEl?.pause();
        if (rec.state === "recording") rec.pause();
      } else if (hiddenPause) {
        hiddenPause = false;
        if (rec.state === "paused") rec.resume();
        last = performance.now();
        v.play().catch(() => {});
        this.audioEl?.play().catch(() => {});
        schedule(step);
      }
    };
    if (pauseWhenHidden) document.addEventListener("visibilitychange", onVisibility);

    await new Promise((resolve) => {
      step = (now = performance.now()) => {
        if (this.cancelled || v.ended) return resolve();
        if (v.paused) return; // пауза по скрытой вкладке — ждём возврата
        const dt = Math.min((now - last) / 1000, 0.1) || 1 / fps;
        last = now;
        onFrame(v, dt);
        onProgress?.(v.duration ? v.currentTime / v.duration : 0);
        schedule(step);
      };
      v.onended = resolve;
      schedule(step);
    });
    document.removeEventListener("visibilitychange", onVisibility);

    this.audioEl?.pause();
    // Хвост: даём рекордеру дописать последние кадры.
    await new Promise((r) => setTimeout(r, 200));
    rec.stop();
    onProgress?.(1);
    return done;
  }

  dispose() {
    this.video.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

/** Метка времени для имён файлов: 2026-09-19T07-30-11. */
export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
