// Режим «Я на фоне»: сегментация вырезает человека из кадра камеры,
// за ним оказывается сцена от Higgsfield. Тоже целиком локально.

import { drawCover } from "./scene.js";

export class Cutout {
  constructor() {
    this.person = document.createElement("canvas");
    this.alpha = document.createElement("canvas");
    this.personLabel = null; // какое значение маски означает «человек»
  }

  reset() {
    this.personLabel = null;
  }

  /**
   * Пересобирает вырезанного человека. Вызывается только на новом кадре камеры.
   * @param mask — categoryMask (MPMask) из ImageSegmenter
   * @param invert — ручная инверсия, если авто-определение промахнулось
   */
  update(video, mask, { invert = false, feather = 3 } = {}) {
    const mw = mask.width, mh = mask.height;
    const data = mask.getAsUint8Array();

    // Значение маски для человека определяем один раз: в центре кадра
    // человек есть почти всегда, в верхнем углу — почти никогда.
    if (this.personLabel === null) {
      const center = data[Math.floor(mh * 0.6) * mw + Math.floor(mw / 2)];
      const corner = data[2 * mw + 2];
      this.personLabel = center !== corner ? center : 0;
    }
    let target = this.personLabel;
    if (invert) target = target === 0 ? 255 : 0;

    if (this.alpha.width !== mw || this.alpha.height !== mh) {
      this.alpha.width = mw; this.alpha.height = mh;
    }
    const actx = this.alpha.getContext("2d", { willReadFrequently: true });
    const img = actx.createImageData(mw, mh);
    const px = img.data;
    for (let i = 0; i < data.length; i++) {
      // «человек» = значение, совпадающее с целевым (маска бинарная)
      px[i * 4 + 3] = (data[i] === target) ? 255 : 0;
    }
    actx.putImageData(img, 0, 0);

    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    if (this.person.width !== vw || this.person.height !== vh) {
      this.person.width = vw; this.person.height = vh;
    }
    const pctx = this.person.getContext("2d");
    pctx.globalCompositeOperation = "source-over";
    pctx.filter = "none";
    pctx.clearRect(0, 0, vw, vh);
    pctx.drawImage(video, 0, 0, vw, vh);
    // Оставляем только пиксели человека; блюр по альфе сглаживает края.
    pctx.globalCompositeOperation = "destination-in";
    pctx.filter = `blur(${feather}px)`;
    pctx.drawImage(this.alpha, 0, 0, vw, vh);
    pctx.filter = "none";
    pctx.globalCompositeOperation = "source-over";
    this.ready = true;
  }

  /** Рисует последний вырезанный кадр — можно вызывать каждый кадр отрисовки. */
  repaint(ctx, w, h, mirror = true) {
    if (!this.ready) return;
    drawCover(ctx, this.person, w, h, 0, 0, 1, mirror);
  }
}
