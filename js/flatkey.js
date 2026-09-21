// Ключ по ровному фону.
//
// Motion Control с scene_control=image отдаёт персонажа на однотонной заливке.
// Выкусывать её сегментацией человека — стрелять из пушки по воробьям: модель
// ещё и не обязана считать луковицу человеком. По цвету получается точнее,
// быстрее и без загрузки лишней модели.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Берёт цвет фона из углов кадра — там он есть почти всегда. */
export function sampleBackground(source, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const pad = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const spots = [[pad, pad], [w - pad, pad], [pad, h - pad], [w - pad, h - pad]];
  let r = 0, g = 0, b = 0;
  for (const [x, y] of spots) {
    const p = ctx.getImageData(x, y, 1, 1).data;
    r += p[0]; g += p[1]; b += p[2];
  }
  return { r: r / spots.length, g: g / spots.length, b: b / spots.length };
}

export class FlatKey {
  constructor() {
    this.cv = document.createElement("canvas");
    this.ctx = this.cv.getContext("2d", { willReadFrequently: true });
    this.soft = document.createElement("canvas");
    this.bg = null;
    this.ready = false;
    this.coverage = 0;
    this.lastSource = null; // чтобы пересчитать тот же кадр при смене допуска
  }

  /** Цвет фона фиксируем один раз, чтобы он не гулял от кадра к кадру. */
  calibrate(source, w, h) {
    this.bg = sampleBackground(source, w, h);
    return this.bg;
  }

  /**
   * @param tolerance — радиус в цветовом пространстве, 0..1
   * @param feather — размытие края в пикселях
   */
  update(source, { tolerance = 0.10, feather = 1.5 } = {}) {
    const w = source.videoWidth || source.naturalWidth || source.width;
    const h = source.videoHeight || source.naturalHeight || source.height;
    if (!w || !h) return false;
    if (this.cv.width !== w || this.cv.height !== h) {
      this.cv.width = w; this.cv.height = h;
      this.soft.width = w; this.soft.height = h;
    }
    if (!this.bg) this.calibrate(source, w, h);
    this.lastSource = source;

    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(source, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const { r: br, g: bg, b: bb } = this.bg;
    // Порог задаём в тех же единицах, что и расстояние: 0..441 для RGB.
    const hard = tolerance * 441;
    const softEdge = hard * 0.55; // ниже этого — точно фон, выше — плавный спад
    let keyed = 0;

    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.hypot(d[i] - br, d[i + 1] - bg, d[i + 2] - bb);
      if (dist <= softEdge) {
        d[i + 3] = 0;
        keyed++;
      } else if (dist < hard) {
        // Полупрозрачная кайма вместо рваного края.
        const a = clamp01((dist - softEdge) / (hard - softEdge));
        d[i + 3] = Math.round(d[i + 3] * a);
        keyed += 1 - a;
      }
    }
    this.ctx.putImageData(img, 0, 0);

    if (feather > 0) {
      const sctx = this.soft.getContext("2d");
      sctx.clearRect(0, 0, w, h);
      sctx.filter = `blur(${feather}px)`;
      sctx.drawImage(this.cv, 0, 0);
      sctx.filter = "none";
    }

    this.coverage = keyed / (d.length / 4);
    this.ready = true;
    return true;
  }

  /** Пересчитывает последний кадр — для живого подбора допуска на паузе. */
  reapply(opts) {
    return this.lastSource ? this.update(this.lastSource, opts) : false;
  }

  /** Готовый кадр с прозрачным фоном. */
  get frame() {
    return this.soft.width ? this.soft : this.cv;
  }
}
