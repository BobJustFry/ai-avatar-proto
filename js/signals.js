// Из 478 точек + 52 блендшейпов MediaPipe делаем небольшой набор сигналов,
// которыми удобно управлять ригом. Все координаты — в «зеркальном» пространстве
// (x' = 1 - x), чтобы аватар повторял движения как отражение в зеркале:
// правая сторона пользователя = правая сторона экрана.

// Индексы точек. L/R здесь — сторона ЭКРАНА после зеркалирования,
// и она совпадает со стороной субъекта: левый глаз субъекта виден слева.
const I = {
  nose: 1, top: 10, chin: 152, cheekA: 234, cheekB: 454,
  eyeL: { outer: 263, inner: 362, top: 386, bottom: 374, iris: 473 },
  eyeR: { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468 },
};

// Нос ниже линии глаз примерно на эту долю высоты лица при взгляде прямо.
const PITCH_BASE = 0.2;
// Во сколько «долей лица» укладывается поворот на ±1.
const YAW_RANGE = 0.16;
const PITCH_RANGE = 0.1;

// Постоянные времени сглаживания, сек. Моргание — самое быстрое.
const TAU = { pose: 0.055, blink: 0.018, mouth: 0.03, gaze: 0.05, brow: 0.05 };

const clamp = (v, a = -1, b = 1) => Math.min(b, Math.max(a, v));
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });

// Кадронезависимая экспоненциальная фильтрация.
const ease = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

export class FaceSignals {
  constructor() {
    this.present = false;
    this.lostFor = 0;
    this.auto = null;
    // Живое превью зеркалим (так привычнее), обработку файла — нет,
    // иначе результат окажется отражением исходной записи.
    this.mirror = true;
    // Нейтральная поза, которую вычитаем. Меняется кнопкой «Калибровать».
    this.neutral = { yawRatio: 0, pitchRatio: PITCH_BASE, roll: 0 };
    this.rawPose = { ...this.neutral };
    this.blendshapes = {};
    this.landmarks = null;
    this.v = {
      yaw: 0, pitch: 0, roll: 0, x: 0.5, y: 0.5, scale: 1,
      blinkL: 0, blinkR: 0, gazeX: 0, gazeY: 0,
      browL: 0, browR: 0, open: 0, wide: 0, round: 0, smile: 0,
    };
    this.viseme = "closed";
  }

  calibrate() {
    this.neutral = { ...this.rawPose };
    this.auto = null;
  }

  /**
   * Автокалибровка по первым секундам записи: нейтралью считаем медиану позы.
   * Для файла это удобнее кнопки — человек в начале ролика обычно смотрит в камеру.
   */
  beginAutoCalibrate(seconds = 1.2) {
    this.auto = { t: 0, seconds, yawRatio: [], pitchRatio: [], roll: [] };
  }

  #collectAuto(dt) {
    const a = this.auto;
    a.t += dt;
    for (const k of ["yawRatio", "pitchRatio", "roll"]) a[k].push(this.rawPose[k]);
    if (a.t < a.seconds) return;
    const median = (arr) => arr.slice().sort((x, y) => x - y)[arr.length >> 1];
    this.neutral = {
      yawRatio: median(a.yawRatio),
      pitchRatio: median(a.pitchRatio),
      roll: median(a.roll),
    };
    this.auto = null;
  }

  /** @param result — то, что вернул FaceLandmarker.detectForVideo */
  update(result, dt) {
    const lm = result?.faceLandmarks?.[0];
    if (!lm) {
      this.lostFor += dt;
      if (this.lostFor > 0.3) this.present = false;
      // Плавно возвращаем аватара в нейтраль, а не бросаем в последней позе.
      this.relax(dt);
      return this.v;
    }
    this.present = true;
    this.lostFor = 0;
    this.landmarks = lm;

    const bs = {};
    for (const c of result.faceBlendshapes?.[0]?.categories ?? []) bs[c.categoryName] = c.score;
    this.blendshapes = bs;

    // Зеркалим по x один раз — дальше вся математика в экранных координатах.
    const p = (i) => ({ x: this.mirror ? 1 - lm[i].x : lm[i].x, y: lm[i].y, z: lm[i].z });

    const nose = p(I.nose);
    const eyeLine = mid(p(I.eyeL.outer), p(I.eyeR.outer));
    const faceW = Math.abs(p(I.cheekB).x - p(I.cheekA).x) || 1e-6;
    const faceH = Math.abs(p(I.chin).y - p(I.top).y) || 1e-6;

    // Крен: наклон линии глаз. Точки берём в порядке экрана, иначе при
    // выключенном зеркале угол уезжает на 180 градусов.
    const e1 = p(I.eyeL.outer), e2 = p(I.eyeR.outer);
    const [lp, rp] = e1.x <= e2.x ? [e1, e2] : [e2, e1];
    const rawRoll = Math.atan2(rp.y - lp.y, rp.x - lp.x);
    const yawRatio = (nose.x - eyeLine.x) / faceW;
    const pitchRatio = (nose.y - eyeLine.y) / faceH;
    this.rawPose = { yawRatio, pitchRatio, roll: rawRoll };
    if (this.auto) this.#collectAuto(dt);

    const yaw = clamp((yawRatio - this.neutral.yawRatio) / YAW_RANGE);
    const pitch = clamp((pitchRatio - this.neutral.pitchRatio) / PITCH_RANGE);
    const roll = clamp((rawRoll - this.neutral.roll) / 0.5);

    // Положение и размер головы в кадре — для сдвига аватара за пользователем.
    const center = mid(eyeLine, p(I.chin));
    const scale = clamp(faceH / 0.42, 0.5, 2.2);

    const gaze = this.#gaze(p);

    const t = this.v;
    t.yaw = ease(t.yaw, yaw, dt, TAU.pose);
    t.pitch = ease(t.pitch, pitch, dt, TAU.pose);
    t.roll = ease(t.roll, roll, dt, TAU.pose);
    t.x = ease(t.x, center.x, dt, TAU.pose);
    t.y = ease(t.y, center.y, dt, TAU.pose);
    t.scale = ease(t.scale, scale, dt, 0.12);

    // Блендшейпы названы по сторонам субъекта. Без зеркала сторона субъекта
    // и сторона экрана расходятся, поэтому пары меняем местами.
    const sideL = this.mirror ? "Left" : "Right";
    const sideR = this.mirror ? "Right" : "Left";
    t.blinkL = ease(t.blinkL, bs[`eyeBlink${sideL}`] ?? 0, dt, TAU.blink);
    t.blinkR = ease(t.blinkR, bs[`eyeBlink${sideR}`] ?? 0, dt, TAU.blink);
    t.gazeX = ease(t.gazeX, gaze.x, dt, TAU.gaze);
    t.gazeY = ease(t.gazeY, gaze.y, dt, TAU.gaze);

    const browUp = bs.browInnerUp ?? 0;
    t.browL = ease(t.browL, browUp + (bs[`browOuterUp${sideL}`] ?? 0) - 2 * (bs[`browDown${sideL}`] ?? 0), dt, TAU.brow);
    t.browR = ease(t.browR, browUp + (bs[`browOuterUp${sideR}`] ?? 0) - 2 * (bs[`browDown${sideR}`] ?? 0), dt, TAU.brow);

    const smile = ((bs.mouthSmileLeft ?? 0) + (bs.mouthSmileRight ?? 0)) / 2;
    const round = Math.max(bs.mouthPucker ?? 0, bs.mouthFunnel ?? 0);
    t.open = ease(t.open, bs.jawOpen ?? 0, dt, TAU.mouth);
    t.wide = ease(t.wide, smile, dt, TAU.mouth);
    t.round = ease(t.round, round, dt, TAU.mouth);
    t.smile = t.wide;

    this.viseme = pickViseme(t);
    return t;
  }

  #gaze(p) {
    let x = 0, y = 0;
    for (const eye of [I.eyeL, I.eyeR]) {
      const outer = p(eye.outer), inner = p(eye.inner);
      const iris = p(eye.iris);
      const c = mid(outer, inner);
      const w = dist(outer, inner) || 1e-6;
      const h = Math.abs(p(eye.bottom).y - p(eye.top).y) || 1e-6;
      x += clamp((iris.x - c.x) / (w * 0.35));
      y += clamp((iris.y - c.y) / (h * 0.8));
    }
    return { x: x / 2, y: y / 2 };
  }

  relax(dt) {
    const t = this.v;
    for (const k of ["yaw", "pitch", "roll", "blinkL", "blinkR", "gazeX", "gazeY", "browL", "browR", "open", "wide", "round", "smile"]) {
      t[k] = ease(t[k], 0, dt, 0.25);
    }
    t.x = ease(t.x, 0.5, dt, 0.25);
    t.y = ease(t.y, 0.5, dt, 0.25);
    t.scale = ease(t.scale, 1, dt, 0.25);
    this.viseme = "closed";
    return t;
  }
}

// Какой слой рта показать. Порядок проверок = приоритет.
function pickViseme(t) {
  if (t.round > 0.38 && t.open < 0.55) return "o";
  if (t.open > 0.45) return "aa";
  if (t.open > 0.14) return "e";
  if (t.wide > 0.28) return "smile";
  return "closed";
}
