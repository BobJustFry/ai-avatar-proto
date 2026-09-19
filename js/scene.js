// Фон: картинка, видео-луп или процедурный градиент. Слой один и тот же
// для оба режимов, поэтому сцены от Higgsfield переиспользуются как есть.

import { placeholderScene } from "./placeholder.js";

const BUILTIN = [
  { id: "studio", name: "Студия (градиент)", type: "gradient", palette: ["#1d2b44", "#3d5a80", "#98c1d9"] },
  { id: "sunset", name: "Закат (градиент)", type: "gradient", palette: ["#2b1b3d", "#8a4a6d", "#f0a072"] },
  { id: "neon", name: "Неон (градиент)", type: "gradient", palette: ["#0b1026", "#3a1f6d", "#12b3a8"] },
];

// Насколько фон сдвигается при повороте головы.
const PARALLAX = { x: 40, y: 26, zoom: 1.1 };

export class Scenes {
  constructor() {
    this.list = BUILTIN;
    this.current = null;
    this.sources = new Map();
  }

  async load(url = "assets/scenes.json") {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const extra = await res.json();
        if (Array.isArray(extra) && extra.length) this.list = [...extra, ...BUILTIN];
      }
    } catch {
      // файла нет — остаются встроенные градиенты
    }
    this.select(this.list[0].id);
    return this.list;
  }

  select(id) {
    const scene = this.list.find((s) => s.id === id) ?? this.list[0];
    this.current = scene;
    if (!this.sources.has(scene.id)) this.sources.set(scene.id, this.#makeSource(scene));
    return scene;
  }

  #makeSource(scene) {
    // ready:false — файла ещё нет, сразу показываем градиент по палитре.
    if (scene.ready === false) return { kind: "canvas", el: placeholderScene(scene.palette) };
    if (scene.type === "video" && scene.src) {
      const v = document.createElement("video");
      Object.assign(v, { src: scene.src, loop: true, muted: true, autoplay: true, playsInline: true });
      v.play().catch(() => {});
      return { kind: "video", el: v, fallback: placeholderScene(scene.palette) };
    }
    if (scene.type === "image" && scene.src) {
      const img = new Image();
      img.src = scene.src;
      return { kind: "image", el: img, fallback: placeholderScene(scene.palette) };
    }
    return { kind: "canvas", el: placeholderScene(scene.palette) };
  }

  draw(ctx, w, h, sig, { parallax = true } = {}) {
    const src = this.sources.get(this.current.id);
    let el = src.el;
    const ready = src.kind === "video"
      ? el.readyState >= 2
      : src.kind === "image" ? el.complete && el.naturalWidth > 0 : true;
    if (!ready) el = src.fallback;

    const zoom = parallax ? PARALLAX.zoom : 1;
    const dx = parallax ? -sig.yaw * PARALLAX.x : 0;
    const dy = parallax ? -sig.pitch * PARALLAX.y : 0;
    drawCover(ctx, el, w, h, dx, dy, zoom);
  }
}

/** Рисует источник «по обложке»: заполняет кадр, лишнее обрезает. */
export function drawCover(ctx, src, w, h, dx = 0, dy = 0, zoom = 1, mirror = false) {
  const sw = src.videoWidth || src.naturalWidth || src.width;
  const sh = src.videoHeight || src.naturalHeight || src.height;
  if (!sw || !sh) return;
  const k = Math.max(w / sw, h / sh) * zoom;
  const dw = sw * k, dh = sh * k;
  const x = (w - dw) / 2 + dx, y = (h - dh) / 2 + dy;
  if (mirror) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(src, w - x - dw, y, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(src, x, y, dw, dh);
  }
}
