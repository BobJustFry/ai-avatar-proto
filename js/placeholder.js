// Процедурная заглушка аватара: каждый слой рисуется кодом на прозрачном
// канвасе 1024x1024. Благодаря этому прототип работает сразу, без ассетов,
// а PNG от Higgsfield подставляются в те же слои без правок кода.

export const SIZE = 1024;

// Геометрия. Если рисуете свои слои — держите эти же позиции,
// либо поправьте pivot-ы в assets/avatar.json.
export const GEO = {
  head: { cx: 512, cy: 545, rx: 198, ry: 238 },
  eyeL: { cx: 428, cy: 548, rx: 54, ry: 35 },
  eyeR: { cx: 596, cy: 548, rx: 54, ry: 35 },
  browY: 468, browW: 116, browH: 20,
  mouth: { cx: 512, cy: 700 },
  neckY: 740,
};

const C = {
  skin: "#f1c6a2", skinShade: "#dfa981", skinLine: "#c98f6b",
  hair: "#3a2a3c", hairHi: "#4e3a52",
  white: "#fdfbf7", iris: "#3f6f9f", pupil: "#182430", glint: "#ffffff",
  brow: "#46313e", lash: "#2b2130",
  lip: "#c1616c", mouthIn: "#5a2530", tongue: "#c8737f", teeth: "#fbf6f0",
  cloth: "#44577a", clothHi: "#526a95",
};

function layer(draw) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = SIZE;
  const ctx = cv.getContext("2d");
  draw(ctx);
  return cv;
}

const ellipse = (ctx, cx, cy, rx, ry, fill, rot = 0) => {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
};

const roundRect = (ctx, x, y, w, h, r, fill) => {
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
};

const eyeWhite = (side) => layer((ctx) => {
  const e = GEO[side === "l" ? "eyeL" : "eyeR"];
  ellipse(ctx, e.cx, e.cy, e.rx, e.ry, C.white);
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2);
  ctx.clip();
  ellipse(ctx, e.cx, e.cy - e.ry * 0.9, e.rx, e.ry * 0.5, "#e6dfd6"); // тень от века
  ctx.restore();
});

const iris = (side) => layer((ctx) => {
  const e = GEO[side === "l" ? "eyeL" : "eyeR"];
  ellipse(ctx, e.cx, e.cy + 2, 25, 25, C.iris);
  ellipse(ctx, e.cx, e.cy + 2, 11, 11, C.pupil);
  ellipse(ctx, e.cx - 9, e.cy - 7, 6, 6, C.glint);
});

const eyelid = (side) => layer((ctx) => {
  const e = GEO[side === "l" ? "eyeL" : "eyeR"];
  // Перекрывает глаз целиком; риг сжимает слой по Y от верхнего края.
  ctx.beginPath();
  ctx.roundRect(e.cx - e.rx - 4, e.cy - e.ry - 6, (e.rx + 4) * 2, (e.ry + 8) * 2, 18);
  ctx.fillStyle = C.skin;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(e.cx - e.rx - 2, e.cy + e.ry + 1);
  ctx.lineTo(e.cx + e.rx + 2, e.cy + e.ry + 1);
  ctx.lineWidth = 7;
  ctx.strokeStyle = C.lash;
  ctx.lineCap = "round";
  ctx.stroke();
});

const brow = (side) => layer((ctx) => {
  const e = GEO[side === "l" ? "eyeL" : "eyeR"];
  ctx.save();
  ctx.translate(e.cx, GEO.browY);
  ctx.rotate((side === "l" ? -1 : 1) * 0.06);
  roundRect(ctx, 0, 0, GEO.browW, GEO.browH, GEO.browH / 2, C.brow);
  ctx.restore();
});

// Слои рта. Риг показывает один из них по виземе и тянет по вертикали.
const mouths = {
  closed: () => layer((ctx) => {
    const m = GEO.mouth;
    ctx.beginPath();
    ctx.moveTo(m.cx - 52, m.cy);
    ctx.quadraticCurveTo(m.cx, m.cy + 12, m.cx + 52, m.cy);
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.strokeStyle = C.lip;
    ctx.stroke();
  }),
  smile: () => layer((ctx) => {
    const m = GEO.mouth;
    ctx.beginPath();
    ctx.moveTo(m.cx - 74, m.cy - 8);
    ctx.quadraticCurveTo(m.cx, m.cy + 44, m.cx + 74, m.cy - 8);
    ctx.quadraticCurveTo(m.cx, m.cy + 16, m.cx - 74, m.cy - 8);
    ctx.fillStyle = C.mouthIn;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(m.cx - 62, m.cy - 2);
    ctx.quadraticCurveTo(m.cx, m.cy + 16, m.cx + 62, m.cy - 2);
    ctx.lineWidth = 14;
    ctx.strokeStyle = C.teeth;
    ctx.stroke();
  }),
  e: () => layer((ctx) => {
    const m = GEO.mouth;
    ellipse(ctx, m.cx, m.cy + 6, 70, 32, C.mouthIn);
    ellipse(ctx, m.cx, m.cy + 22, 44, 14, C.tongue);
  }),
  aa: () => layer((ctx) => {
    const m = GEO.mouth;
    ellipse(ctx, m.cx, m.cy + 18, 62, 72, C.mouthIn);
    ellipse(ctx, m.cx, m.cy + 56, 42, 26, C.tongue);
  }),
  o: () => layer((ctx) => {
    const m = GEO.mouth;
    ellipse(ctx, m.cx, m.cy + 8, 40, 44, C.lip);
    ellipse(ctx, m.cx, m.cy + 8, 27, 31, C.mouthIn);
  }),
};

const BUILD = {
  hair_back: () => layer((ctx) => {
    const h = GEO.head;
    ellipse(ctx, h.cx, h.cy - 20, h.rx + 46, h.ry + 34, C.hair);
    ellipse(ctx, h.cx, h.cy + 120, h.rx + 30, h.ry, C.hair);
  }),
  body: () => layer((ctx) => {
    const h = GEO.head;
    // шея
    roundRect(ctx, h.cx, GEO.neckY + 40, 118, 150, 40, C.skinShade);
    // плечи
    ctx.beginPath();
    ctx.moveTo(h.cx - 340, SIZE);
    ctx.quadraticCurveTo(h.cx - 300, 840, h.cx, 830);
    ctx.quadraticCurveTo(h.cx + 300, 840, h.cx + 340, SIZE);
    ctx.closePath();
    ctx.fillStyle = C.cloth;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(h.cx - 90, 836);
    ctx.quadraticCurveTo(h.cx, 930, h.cx + 90, 836);
    ctx.fillStyle = C.clothHi;
    ctx.fill();
  }),
  head: () => layer((ctx) => {
    const h = GEO.head;
    // уши
    ellipse(ctx, h.cx - h.rx + 8, h.cy + 40, 34, 48, C.skinShade);
    ellipse(ctx, h.cx + h.rx - 8, h.cy + 40, 34, 48, C.skinShade);
    // лицо
    ctx.beginPath();
    ctx.moveTo(h.cx - h.rx, h.cy - 40);
    ctx.quadraticCurveTo(h.cx - h.rx, h.cy - h.ry, h.cx, h.cy - h.ry);
    ctx.quadraticCurveTo(h.cx + h.rx, h.cy - h.ry, h.cx + h.rx, h.cy - 40);
    ctx.quadraticCurveTo(h.cx + h.rx - 10, h.cy + h.ry, h.cx, h.cy + h.ry);
    ctx.quadraticCurveTo(h.cx - h.rx + 10, h.cy + h.ry, h.cx - h.rx, h.cy - 40);
    ctx.closePath();
    ctx.fillStyle = C.skin;
    ctx.fill();
    // нос
    ctx.beginPath();
    ctx.moveTo(h.cx - 4, h.cy + 42);
    ctx.quadraticCurveTo(h.cx + 26, h.cy + 96, h.cx - 14, h.cy + 104);
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.strokeStyle = C.skinLine;
    ctx.stroke();
    // румянец
    ctx.globalAlpha = 0.35;
    ellipse(ctx, h.cx - 132, h.cy + 96, 46, 26, "#e9907f");
    ellipse(ctx, h.cx + 132, h.cy + 96, 46, 26, "#e9907f");
    ctx.globalAlpha = 1;
  }),
  hair_front: () => layer((ctx) => {
    const h = GEO.head;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(h.cx, h.cy, h.rx + 4, h.ry + 4, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(h.cx - h.rx - 10, h.cy - 120);
    ctx.quadraticCurveTo(h.cx - 90, h.cy - 40, h.cx - 10, h.cy - 130);
    ctx.quadraticCurveTo(h.cx + 90, h.cy - 20, h.cx + h.rx + 10, h.cy - 150);
    ctx.lineTo(h.cx + h.rx + 10, h.cy - h.ry - 40);
    ctx.lineTo(h.cx - h.rx - 10, h.cy - h.ry - 40);
    ctx.closePath();
    ctx.fillStyle = C.hair;
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(h.cx - 40, h.cy - h.ry - 10);
    ctx.quadraticCurveTo(h.cx + 60, h.cy - 130, h.cx + 150, h.cy - 96);
    ctx.lineWidth = 16;
    ctx.strokeStyle = C.hairHi;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }),
  eye_white_l: () => eyeWhite("l"),
  eye_white_r: () => eyeWhite("r"),
  iris_l: () => iris("l"),
  iris_r: () => iris("r"),
  eyelid_l: () => eyelid("l"),
  eyelid_r: () => eyelid("r"),
  brow_l: () => brow("l"),
  brow_r: () => brow("r"),
  mouth_closed: mouths.closed,
  mouth_smile: mouths.smile,
  mouth_e: mouths.e,
  mouth_aa: mouths.aa,
  mouth_o: mouths.o,
};

/** Заглушка для слоя по id, либо null если такого слоя мы рисовать не умеем. */
export function placeholderLayer(id) {
  return BUILD[id] ? BUILD[id]() : null;
}

/** Процедурная сцена-градиент, когда файла фона нет. */
export function placeholderScene(palette = ["#2a3f63", "#8a5f7d", "#f0b892"], w = 1280, h = 720) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, w * 0.4, h);
  palette.forEach((c, i) => g.addColorStop(i / (palette.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 0.16;
  for (let i = 0; i < 7; i++) {
    ellipse(ctx, w * (0.1 + i * 0.13), h * (0.2 + (i % 3) * 0.28), 150 + i * 40, 150 + i * 40, "#ffffff");
  }
  ctx.globalAlpha = 1;
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.85);
  v.addColorStop(0, "#00000000");
  v.addColorStop(1, "#000000a0");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
  return cv;
}
