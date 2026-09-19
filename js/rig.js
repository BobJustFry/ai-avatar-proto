// Риг: набор слоёв 1024x1024 в одной системе координат (как экспорт слоёв из PSD)
// плюс правила, чем каждый слой управляется. Ассеты от Higgsfield кладутся
// в assets/layers/ под теми же именами — код при этом не меняется.

import { placeholderLayer, SIZE, GEO } from "./placeholder.js";

// Насколько сильно сигналы двигают слои.
const GAIN = {
  roll: 0.30,      // рад на единицу крена
  headX: 46, headY: 34,
  bodyX: 12, bodyY: 8,
  iris: 15, irisYaw: 9,
  brow: 22,
  followX: 0.35, followY: 0.25, // насколько аватар едет за головой в кадре
};

export const DEFAULT_MANIFEST = {
  name: "placeholder",
  size: [SIZE, SIZE],
  headPivot: [512, 790],
  layers: [
    { id: "hair_back", group: "head" },
    { id: "body", group: "body" },
    { id: "head", group: "head" },
    { id: "eye_white_l", group: "head" },
    { id: "eye_white_r", group: "head" },
    { id: "iris_l", group: "head", bind: "iris", side: "l" },
    { id: "iris_r", group: "head", bind: "iris", side: "r" },
    { id: "eyelid_l", group: "head", bind: "eyelid", side: "l", pivot: [GEO.eyeL.cx, GEO.eyeL.cy - GEO.eyeL.ry - 6] },
    { id: "eyelid_r", group: "head", bind: "eyelid", side: "r", pivot: [GEO.eyeR.cx, GEO.eyeR.cy - GEO.eyeR.ry - 6] },
    { id: "brow_l", group: "head", bind: "brow", side: "l" },
    { id: "brow_r", group: "head", bind: "brow", side: "r" },
    { id: "mouth_closed", group: "head", bind: "mouth", viseme: "closed", pivot: [GEO.mouth.cx, GEO.mouth.cy - 30] },
    { id: "mouth_smile", group: "head", bind: "mouth", viseme: "smile", pivot: [GEO.mouth.cx, GEO.mouth.cy - 30] },
    { id: "mouth_e", group: "head", bind: "mouth", viseme: "e", pivot: [GEO.mouth.cx, GEO.mouth.cy - 30] },
    { id: "mouth_aa", group: "head", bind: "mouth", viseme: "aa", pivot: [GEO.mouth.cx, GEO.mouth.cy - 30] },
    { id: "mouth_o", group: "head", bind: "mouth", viseme: "o", pivot: [GEO.mouth.cx, GEO.mouth.cy - 30] },
    { id: "hair_front", group: "head" },
  ],
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(src));
    img.src = src;
  });
}

export class Rig {
  constructor() {
    this.manifest = DEFAULT_MANIFEST;
    this.images = new Map();
    this.stats = { fromFile: [], fromPlaceholder: [], failed: [] };
  }

  async load(manifestUrl = "assets/avatar.json") {
    try {
      const res = await fetch(manifestUrl, { cache: "no-store" });
      if (res.ok) this.manifest = await res.json();
    } catch {
      // манифеста нет — работаем на встроенном
    }
    const dir = this.manifest.dir ?? "assets/layers/";
    // assets:false — слои ещё не нарисованы, не долбимся в несуществующие файлы.
    const useFiles = this.manifest.assets !== false;
    this.images.clear();
    this.stats = { fromFile: [], fromPlaceholder: [], failed: [] };

    await Promise.all(this.manifest.layers.map(async (l) => {
      const src = l.src ?? `${dir}${l.id}.png`;
      try {
        if (!useFiles) throw new Error("assets disabled");
        this.images.set(l.id, await loadImage(src));
        this.stats.fromFile.push(l.id);
      } catch {
        const ph = placeholderLayer(l.id);
        if (ph) {
          this.images.set(l.id, ph);
          this.stats.fromPlaceholder.push(l.id);
        } else {
          this.stats.failed.push(l.id);
        }
      }
    }));
    return this.stats;
  }

  /**
   * Рисует аватара по сигналам лица.
   * @param sig — объект из FaceSignals.v, viseme — текущая визема.
   */
  draw(ctx, w, h, sig, viseme, { zoom = 1.18, follow = true } = {}) {
    const [rw, rh] = this.manifest.size ?? [SIZE, SIZE];
    const [px, py] = this.manifest.headPivot ?? [rw / 2, rh * 0.77];
    const scale = (h / rh) * zoom;

    const followX = follow ? (sig.x - 0.5) * w * GAIN.followX : 0;
    const followY = follow ? (sig.y - 0.5) * h * GAIN.followY : 0;

    ctx.save();
    // Рига ставим по центру кадра, низ рига — по низу кадра.
    ctx.translate(w / 2 + followX, h - rh * scale + followY);
    ctx.scale(scale, scale);
    ctx.translate(-rw / 2, 0);

    for (const l of this.manifest.layers) {
      const img = this.images.get(l.id);
      if (!img) continue;
      if (l.bind === "mouth" && l.viseme !== viseme) continue;

      ctx.save();
      this.#applyGroup(ctx, l.group, sig, px, py);
      const visible = this.#applyBind(ctx, l, sig);
      if (visible) ctx.drawImage(img, 0, 0, rw, rh);
      ctx.restore();
    }
    ctx.restore();
  }

  #applyGroup(ctx, group, sig, px, py) {
    if (group === "head") {
      ctx.translate(px, py);
      ctx.rotate(sig.roll * GAIN.roll);
      ctx.translate(sig.yaw * GAIN.headX, sig.pitch * GAIN.headY);
      // лёгкое сжатие по оси поворота — дешёвая имитация объёма
      ctx.scale(1 - Math.abs(sig.yaw) * 0.06, 1 - Math.abs(sig.pitch) * 0.035);
      ctx.translate(-px, -py);
    } else if (group === "body") {
      // корпус чуть отстаёт от головы в противоход
      ctx.translate(-sig.yaw * GAIN.bodyX, Math.abs(sig.pitch) * GAIN.bodyY);
    }
  }

  /** @returns false если слой в этом кадре рисовать не надо */
  #applyBind(ctx, l, sig) {
    switch (l.bind) {
      case "iris": {
        ctx.translate(sig.gazeX * GAIN.iris + sig.yaw * GAIN.irisYaw, sig.gazeY * 10 + sig.pitch * 6);
        return true;
      }
      case "eyelid": {
        const blink = clamp(l.side === "l" ? sig.blinkL : sig.blinkR, 0, 1);
        if (blink < 0.03) return false;
        const [ax, ay] = l.pivot ?? [512, 500];
        ctx.translate(ax, ay);
        ctx.scale(1, blink);
        ctx.translate(-ax, -ay);
        return true;
      }
      case "brow": {
        const v = clamp(l.side === "l" ? sig.browL : sig.browR, -1.2, 1.5);
        ctx.translate(0, -v * GAIN.brow);
        return true;
      }
      case "mouth": {
        const [ax, ay] = l.pivot ?? [512, 670];
        let sx = 1, sy = 1;
        if (l.viseme === "aa" || l.viseme === "e") sy = 0.7 + clamp(sig.open, 0, 1) * 0.75;
        if (l.viseme === "o") { sx = sy = 0.75 + clamp(sig.round, 0, 1) * 0.5; }
        if (l.viseme === "smile") sx = 0.9 + clamp(sig.wide, 0, 1) * 0.25;
        ctx.translate(ax, ay);
        ctx.scale(sx, sy);
        ctx.translate(-ax, -ay);
        return true;
      }
      default:
        return true;
    }
  }
}
