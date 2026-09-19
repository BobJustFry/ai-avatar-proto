// Запись канваса в WebM и снимок в PNG. Микрофон подмешивается, только если
// пользователь разрешит — без разрешения просто пишем видео.

import { downloadBlob, stamp } from "./pipeline.js";

const MIME = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const pickMime = () => MIME.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";

export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.rec = null;
    this.chunks = [];
    this.micStream = null;
  }

  get active() {
    return this.rec?.state === "recording";
  }

  async start() {
    const stream = this.canvas.captureStream(30);
    let withAudio = false;
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of this.micStream.getAudioTracks()) stream.addTrack(t);
      withAudio = true;
    } catch {
      // отказ от микрофона не мешает записи картинки
    }
    this.chunks = [];
    this.rec = new MediaRecorder(stream, { mimeType: pickMime() });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    return { withAudio };
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.rec) return resolve(null);
      this.rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.rec.mimeType || "video/webm" });
        this.micStream?.getTracks().forEach((t) => t.stop());
        this.micStream = null;
        this.rec = null;
        downloadBlob(blob, `avatar-${stamp()}.webm`);
        resolve(blob);
      };
      this.rec.stop();
    });
  }

  snapshot() {
    this.canvas.toBlob((blob) => blob && downloadBlob(blob, `avatar-${stamp()}.png`), "image/png");
  }
}
