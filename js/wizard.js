// Мастер: пять шагов от исходной записи до готового ролика.
//
// Локальные шаги (выбор файлов, ключ, фон, сведение со звуком) работают сразу.
// Два шага считаются на стороне Higgsfield — чистовой лист персонажа и сама
// замена. Пока приложение не имеет доступа к API, для них есть ручной мост:
// сделать снаружи и загрузить готовый файл кнопкой.

import { VideoProcessor, downloadBlob, stamp } from "./pipeline.js";
import { FlatKey } from "./flatkey.js";
import { drawCover } from "./scene.js";
import { hfStatus, hfRecheck, hfLibrary, subscribeJobs, waitForJob, makeSheet, makeBackground, runSwap, runObjectSwap } from "./hf.js";

const $ = (s) => document.querySelector(s);
const canvas = $("#out");
const ctx = canvas.getContext("2d");

const processor = new VideoProcessor(canvas);
const flatkey = new FlatKey();

const state = {
  src: null,        // { file, url, el, duration, w, h }
  charFile: null,   // фото персонажа «как есть»
  sheet: null,      // { url, img } — чистовой лист
  bg: null,         // { kind: 'image'|'video'|'none', url, el }
  swap: null,       // { file, url, el, w, h } — результат замены
  format: "auto",
  tolerance: 0.1,
  busy: false,
  mode: "character", // character — персонаж и фон, object — предмет в кадре
  // Что делаем с обстановкой: keep — оставить снятую, replace — подставить
  // свою, plate — получить ровную заливку и решить потом.
  bgMode: "keep",
};

// --- шаги --------------------------------------------------------------------

function openStep(n) {
  for (const li of document.querySelectorAll(".step")) {
    li.classList.toggle("open", Number(li.dataset.step) === n);
  }
  $("#status").textContent = `шаг ${n} из 5`;
}

const markDone = (n, done = true) =>
  document.querySelector(`.step[data-step="${n}"]`)?.classList.toggle("done", done);

/** Переключает тип замены: меняется и набор шагов, и что считается готовым. */
function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  for (const b of document.querySelectorAll("#modes .mode")) {
    b.classList.toggle("on", b.dataset.mode === mode);
  }
  // Фон относится только к персонажу: в режиме предмета сцена остаётся вашей.
  if (mode === "object") {
    state.bg = null;
    state.bgMode = "keep";
    markDone(3, false);
  }
  refresh();
}

function wireSteps() {
  for (const h of document.querySelectorAll(".step h2")) {
    h.onclick = () => openStep(Number(h.parentElement.dataset.step));
  }
}

// --- превью ------------------------------------------------------------------

let previewAr = 16 / 9;

/** Вписывает кадр превью в колонку: по ширине и по высоте одновременно. */
function fitPreview() {
  const col = $("#preview");
  const frame = $("#preview .frame");
  const availW = col.clientWidth;
  const availH = Math.max(220, Math.min(window.innerHeight - 200, 620));
  if (!availW) return;
  const width = Math.min(availW, availH * previewAr);
  frame.style.width = `${Math.floor(width)}px`;
  frame.style.height = `${Math.floor(width / previewAr)}px`;
}

function fitCanvas(w, h) {
  canvas.width = w;
  canvas.height = h;
  previewAr = w / h;
  fitPreview();
}

function showEmpty(on, text) {
  const el = $("#empty");
  el.hidden = !on;
  if (text) el.textContent = text;
}

/** Рисует что-нибудь одно во весь кадр — для промежуточных превью. */
function previewSource(source, note) {
  const w = source.videoWidth || source.naturalWidth;
  const h = source.videoHeight || source.naturalHeight;
  if (!w || !h) return;
  fitCanvas(w, h);
  ctx.clearRect(0, 0, w, h);
  drawCover(ctx, source, w, h);
  showEmpty(false);
  if (note) $("#preview-info").textContent = note;
}

/** Композит: фон, поверх — персонаж с вырезанной заливкой. */
function previewComposite(note) {
  const [w, h] = outputSize();
  fitCanvas(w, h);
  ctx.clearRect(0, 0, w, h);
  // Когда обстановка остаётся своей, вырезать нечего — показываем кадр как есть.
  if (state.bgMode !== "replace" && state.swap?.el) {
    drawCover(ctx, state.swap.el, w, h);
    showEmpty(false);
    if (note) $("#preview-info").textContent = note;
    return;
  }
  drawBackground(w, h);
  if (flatkey.ready) drawCover(ctx, flatkey.frame, w, h);
  showEmpty(false);
  if (note) $("#preview-info").textContent = note;
}

function drawBackground(w, h) {
  const bg = state.bg;
  if (bg?.el && (bg.el.readyState >= 2 || bg.el.complete)) {
    drawCover(ctx, bg.el, w, h);
  } else {
    // «без фона» — шахматка, чтобы прозрачность была видна
    const s = 24;
    for (let y = 0; y < h; y += s) {
      for (let x = 0; x < w; x += s) {
        ctx.fillStyle = ((x / s + y / s) % 2) ? "#1a1f27" : "#141920";
        ctx.fillRect(x, y, s, s);
      }
    }
  }
}

/** Размер выходного кадра: явный или унаследованный от результата замены. */
function outputSize() {
  if (state.format !== "auto") return state.format.split("x").map(Number);
  const el = state.swap?.el ?? state.src?.el;
  return el ? [el.videoWidth, el.videoHeight] : [1280, 720];
}

/** Кладёт миниатюру в шаг. Клик возвращает картинку в большое превью. */
function addThumb(containerSel, src, caption, onOpen) {
  const box = $(containerSel);
  const old = box.querySelector(`figure[data-caption="${caption}"]`);
  if (old) old.remove();
  const fig = document.createElement("figure");
  fig.dataset.caption = caption;
  fig.innerHTML = `<img alt="${caption}"><figcaption>${caption}</figcaption>`;
  fig.querySelector("img").src = src;
  fig.onclick = onOpen;
  box.append(fig);
}

/** Кадр из видео как картинка — для миниатюры результата замены. */
function frameToUrl(el) {
  const cv = document.createElement("canvas");
  cv.width = 160;
  cv.height = Math.round(160 * el.videoHeight / el.videoWidth) || 160;
  cv.getContext("2d").drawImage(el, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.8);
}

// --- загрузка файлов ---------------------------------------------------------

function loadVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    Object.assign(el, { src: url, muted: true, playsInline: true, preload: "auto" });
    el.onloadeddata = () => resolve({ file, url, el, duration: el.duration, w: el.videoWidth, h: el.videoHeight });
    el.onerror = () => reject(new Error("не удалось прочитать видео"));
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ file, url, img });
    img.onerror = () => reject(new Error("не удалось прочитать изображение"));
    img.src = url;
  });
}

/** Кадр из видео в заданной секунде — для превью и калибровки ключа. */
async function seekTo(el, time) {
  if (Math.abs(el.currentTime - time) < 0.05) return;
  await new Promise((resolve) => {
    const done = () => { el.removeEventListener("seeked", done); resolve(); };
    el.addEventListener("seeked", done);
    el.currentTime = time;
    setTimeout(done, 1500);
  });
}

// --- шаг 1: исходник ---------------------------------------------------------

async function pickSource(file) {
  try {
    state.src = await loadVideo(file);
    const { duration, w, h } = state.src;
    $("#src-info").textContent = `${file.name} · ${duration.toFixed(1)} с · ${w}×${h}`;
    await seekTo(state.src.el, Math.min(1, duration / 3));
    previewSource(state.src.el, "Кадр исходника.");
    markDone(1);
    refresh();
    openStep(2);
  } catch (err) {
    $("#src-info").textContent = `Не открылось: ${err.message}`;
  }
}

// --- шаг 2: персонаж ---------------------------------------------------------

async function pickCharacter(file) {
  try {
    const { url, img } = await loadImage(file);
    state.charFile = { file, url, img };
    $("#char-info").textContent = `${file.name} · ${img.naturalWidth}×${img.naturalHeight}`;
    previewSource(img, "Фото персонажа. Для генерации из него делается чистовой лист.");
    addThumb("#thumbs-char", url, "исходное фото",
      () => previewSource(img, "Исходное фото персонажа."));
    refresh();
  } catch (err) {
    $("#char-info").textContent = `Не открылось: ${err.message}`;
  }
}

function setSheet(entry, note) {
  state.sheet = entry;
  $("#sheet-info").textContent = note;
  previewSource(entry.img, "Чистовой лист персонажа.");
  addThumb("#thumbs-char", entry.url, "чистовой лист",
    () => previewSource(entry.img, "Чистовой лист персонажа."));
  markDone(2);
  refresh();
}

// --- шаг 3: фон --------------------------------------------------------------

async function pickBackground(file) {
  try {
    if (file.type.startsWith("video/")) {
      const v = await loadVideo(file);
      v.el.loop = true;
      await v.el.play().catch(() => {});
      state.bg = { kind: "video", url: v.url, el: v.el };
    } else {
      const im = await loadImage(file);
      state.bg = { kind: "image", url: im.url, el: im.img };
    }
    state.bgMode = "replace";
    $("#bg-info").textContent = `Фон заменяется на «${file.name}».`;
    addThumb("#thumbs-bg", state.bg.url, "фон", () => previewComposite("Фон."));
    markDone(3);
    previewComposite("Фон выбран.");
    refresh();
  } catch (err) {
    $("#bg-info").textContent = `Не открылось: ${err.message}`;
  }
}

// --- шаг 4: замена -----------------------------------------------------------

async function useSwapResult(file) {
  try {
    state.swap = await loadVideo(file);
    const { duration, w, h } = state.swap;
    $("#swap-info").textContent = `Результат: ${duration.toFixed(1)} с · ${w}×${h}`;
    await seekTo(state.swap.el, Math.min(1, duration / 3));
    flatkey.bg = null;
    flatkey.update(state.swap.el, { tolerance: state.tolerance });
    addThumb("#thumbs-swap", frameToUrl(state.swap.el), "замена",
      () => previewComposite("Результат замены на фоне."));
    markDone(4);
    previewComposite("Так будет выглядеть сборка.");
    refresh();
    openStep(5);
  } catch (err) {
    $("#swap-info").textContent = `Не открылось: ${err.message}`;
  }
}

// --- шаг 5: сборка -----------------------------------------------------------

async function assemble() {
  if (!state.swap || state.busy) return;
  state.busy = true;
  const btn = $("#assemble");
  btn.disabled = true;
  btn.textContent = "Собираю…";
  $("#progress").hidden = false;

  try {
    await processor.open(state.swap.file);
    await processor.openAudio(state.src ? state.src.file : null);
    const [w, h] = outputSize();
    fitCanvas(w, h);
    flatkey.bg = null;

    const blob = await processor.run({
      onFrame: (el) => {
        ctx.clearRect(0, 0, w, h);
        if (state.mode === "object" || state.bgMode !== "replace" || !state.bg) {
          // Без фона вырезать нечего: шахматка из превью не должна попасть
          // в файл, поэтому кадр идёт как есть — меняется только звук и формат.
          drawCover(ctx, el, w, h);
          return;
        }
        flatkey.update(el, { tolerance: state.tolerance });
        drawBackground(w, h);
        drawCover(ctx, flatkey.frame, w, h);
      },
      onProgress: (p) => { $("#bar").style.width = `${(p * 100).toFixed(1)}%`; },
    });
    downloadBlob(blob, `avatar-${stamp()}.webm`);
    $("#assemble-info").textContent = `Готово: ${(blob.size / 1e6).toFixed(1)} МБ, файл в загрузках.`;
    markDone(5);
  } catch (err) {
    console.error(err);
    $("#assemble-info").textContent = `Ошибка: ${err.message}`;
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = "Собрать ролик";
    $("#progress").hidden = true;
    $("#bar").style.width = "0%";
  }
}

// --- шаги, которые считает Higgsfield ----------------------------------------

/** Скачивает результат генерации к себе, чтобы дальше работать с файлом. */
async function fetchAsFile(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`не удалось забрать результат (${res.status})`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type });
}

/** Обёртка для долгих шагов: блокировка кнопки и честный текст ошибки. */
async function longStep(btn, info, label, fn) {
  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    $(info).textContent = err.message;
  } finally {
    delete btn.dataset.busy;
    refresh();
  }
}

function generateSheet() {
  return longStep($("#make-sheet"), "#sheet-info", "Рисую…", async () => {
    const { jobId } = await makeSheet(state.charFile.file, { aspect: sheetAspect() });
    $("#sheet-info").textContent = `Задание ${jobId.slice(0, 8)} поставлено в очередь…`;
    loadLibrary();
    const url = await waitForJob(jobId, {
      onTick: (sec) => { $("#sheet-info").textContent = `Рисую, прошло ${sec} с. Результат не потеряется: он появится в библиотеке.`; },
    });
    const entry = await loadImage(await fetchAsFile(url, "sheet.png"));
    setSheet(entry, "Чистовой лист готов.");
    loadLibrary();
  });
}

function generateBackground() {
  const prompt = $("#bg-prompt").value.trim();
  if (!prompt) {
    $("#bg-prompt").hidden = false;
    $("#bg-info").textContent = "Опишите фон словами и нажмите ещё раз.";
    return;
  }
  return longStep($("#gen-bg"), "#bg-info", "Рисую…", async () => {
    const { jobId } = await makeBackground(prompt, { aspect: sheetAspect() });
    $("#bg-info").textContent = `Задание ${jobId.slice(0, 8)} в очереди…`;
    loadLibrary();
    const url = await waitForJob(jobId, {
      onTick: (sec) => { $("#bg-info").textContent = `Рисую фон, прошло ${sec} с.`; },
    });
    const im = await loadImage(await fetchAsFile(url, "background.png"));
    state.bg = { kind: "image", url: im.url, el: im.img };
    state.bgMode = "replace";
    $("#bg-info").textContent = "Фон сгенерирован и будет подставлен.";
    addThumb("#thumbs-bg", im.url, "фон", () => previewComposite("Фон."));
    markDone(3);
    previewComposite("Фон сгенерирован.");
  });
}

function generateSwap() {
  return longStep($("#run-swap"), "#swap-info", "Заменяю…", async () => {
    const sheetFile = state.sheet.file ?? await fetchAsFile(state.sheet.url, "sheet.png");
    const { jobId } = await runSwap(sheetFile, state.src.file, {
      resolution: $("#quality").value,
      // Оставляем снятую сцену или получаем ровную заливку под подстановку.
      backgroundSource: state.bgMode === "keep" ? "input_video" : "input_image",
    });
    $("#swap-info").textContent = `Задание ${jobId.slice(0, 8)} в очереди…`;
    loadLibrary();
    const url = await waitForJob(jobId, {
      onTick: (sec) => { $("#swap-info").textContent = `Считается, прошло ${sec} с. Результат не потеряется: он появится в библиотеке.`; },
    });
    await useSwapResult(await fetchAsFile(url, "swap.mp4"));
    loadLibrary();
  });
}

function generateObject() {
  const prompt = $("#object-prompt").value.trim();
  if (!prompt) {
    $("#swap-info").textContent = "Опишите словами, что заменить в кадре.";
    return;
  }
  return longStep($("#run-object"), "#swap-info", "Заменяю…", async () => {
    const { jobId } = await runObjectSwap(state.charFile.file, state.src.file, {
      prompt,
      resolution: $("#quality").value === "1080p" ? "1080p" : "720p",
    });
    $("#swap-info").textContent = `Задание ${jobId.slice(0, 8)} в очереди…`;
    loadLibrary();
    const url = await waitForJob(jobId, {
      onTick: (sec) => { $("#swap-info").textContent = `Считается, прошло ${sec} с. Результат не потеряется: он появится в библиотеке.`; },
    });
    await useSwapResult(await fetchAsFile(url, "object.mp4"));
    loadLibrary();
  });
}

/** Пропорция листа берётся от исходника — персонаж должен лечь в тот же кадр. */
function sheetAspect() {
  const el = state.src?.el;
  if (!el?.videoWidth) return "9:16";
  const r = el.videoWidth / el.videoHeight;
  if (r > 1.5) return "16:9";
  if (r > 1.15) return "4:3";
  if (r > 0.9) return "1:1";
  if (r > 0.72) return "3:4";
  return "9:16";
}

// --- библиотека --------------------------------------------------------------

/**
 * Список всего, что сгенерировано на аккаунте. Вебхука у локального приложения
 * быть не может, и вкладку легко закрыть, поэтому источник правды — не память
 * страницы, а сам Higgsfield.
 */
function renderLibrary(items) {
  const box = $("#lib-items");
  if (!items.length) {
    $("#lib-info").textContent = "Пока пусто: ни одной генерации на аккаунте.";
    box.replaceChildren();
    return;
  }
  const working = items.filter((i) => i.status !== "completed" && i.status !== "failed").length;
  $("#lib-info").textContent = working
    ? `В работе: ${working}. Список обновляется сам, ждать у экрана не нужно.`
    : "Нажмите на результат, чтобы посмотреть, или выберите, куда его подставить.";
  box.replaceChildren(...items.map(renderLibCard));
}

async function loadLibrary() {
  const box = $("#lib-items");
  try {
    const items = await hfLibrary();
    if (!items.length) {
      $("#lib-info").textContent = "Пока пусто: ни одной генерации на аккаунте.";
      box.replaceChildren();
      return;
    }
    renderLibrary(items);
  } catch (err) {
    $("#lib-info").textContent = `Библиотека недоступна: ${err.message}`;
  }
}

function renderLibCard(item) {
  const failed = item.status === "failed" || item.status === "canceled";
  const card = document.createElement("div");
  card.className = "lib-card"
    + (item.status === "completed" ? "" : failed ? " failed" : " pending");
  const when = new Date(item.createdAt).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });

  const media = item.url
    ? (item.kind === "video"
      ? Object.assign(document.createElement("video"), { src: item.url, muted: true, preload: "metadata" })
      : Object.assign(document.createElement("img"), { src: item.url, alt: item.model }))
    : Object.assign(document.createElement("div"), {
      className: "placeholder",
      textContent: failed ? "не получилось" : "готовится",
    });

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = item.status === "completed"
    ? (item.kind === "video" ? "видео" : "фото")
    : failed ? "ошибка" : "в работе";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${item.model} · ${when}`;

  card.append(media, badge, meta);

  if (item.status === "completed" && item.url) {
    const use = document.createElement("div");
    use.className = "lib-use";
    if (item.kind === "image") {
      use.append(
        libButton("персонаж", async () => {
          const entry = await loadImage(await fetchAsFile(item.url, "sheet.png"));
          setSheet(entry, "Лист взят из библиотеки.");
          openStep(2);
        }),
        libButton("фон", async () => {
          const im = await loadImage(await fetchAsFile(item.url, "background.png"));
          state.bg = { kind: "image", url: im.url, el: im.img };
          $("#bg-info").textContent = "Фон взят из библиотеки.";
          addThumb("#thumbs-bg", im.url, "фон", () => previewComposite("Фон."));
          markDone(3);
          previewComposite("Фон из библиотеки.");
          refresh();
        }),
      );
    } else {
      use.append(libButton("как замену", async () => {
        await useSwapResult(await fetchAsFile(item.url, "swap.mp4"));
      }));
    }
    card.append(use);
    media.onclick = () => window.open(item.url, "_blank", "noopener");
  }
  return card;
}

function libButton(label, fn) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    const was = b.textContent;
    b.textContent = "…";
    try { await fn(); } catch (err) { $("#lib-info").textContent = err.message; }
    b.textContent = was;
    b.disabled = false;
  };
  return b;
}

// --- доступность кнопок ------------------------------------------------------

function refresh() {
  const blocked = !hf.ready;

  $("#make-sheet").disabled = !state.charFile || blocked;
  $("#use-as-sheet").disabled = !state.charFile;
  $("#gen-bg").disabled = blocked;
  $("#run-swap").disabled = !(state.src && state.sheet) || blocked;
  $("#run-object").disabled = !(state.src && state.charFile) || blocked;
  $("#assemble").disabled = !state.swap || state.busy;

  // Подсказка должна называть недостающее и вести к нему, а не перечислять
  // всё подряд: человек смотрит на выключенную кнопку и не понимает, что не так.
  if (!state.busy) {
    const missing = [];
    if (!state.src) missing.push({ what: "исходное видео", step: 1 });
    if (state.mode === "character") {
      if (!state.sheet) missing.push({ what: "чистовой лист персонажа", step: 2 });
    } else if (!state.charFile) {
      missing.push({ what: "фото предмета", step: 2 });
    }
    if (missing.length && hf.ready) {
      const info = $("#swap-info");
      info.replaceChildren(
        document.createTextNode(`Не хватает: ${missing.map((m) => m.what).join(" и ")}. `),
      );
      for (const m of missing) {
        const a = document.createElement("button");
        a.className = "linkish";
        a.textContent = `перейти к шагу ${m.step}`;
        a.onclick = () => openStep(m.step);
        info.append(a);
      }
    }
    $("#assemble-info").textContent = state.swap
      ? $("#assemble-info").textContent
      : "Не хватает результата замены — сделайте шаг 4 или возьмите готовое видео из библиотеки.";
  }

  // Выключенная кнопка сама по себе ничего не объясняет: человек жмёт, ничего
  // не происходит, и это выглядит поломкой. Пишем причину прямо на ней.
  for (const [sel, normal] of [
    ["#make-sheet", "Сделать чистовой лист"],
    ["#run-swap", "Заменить персонажа"],
    ["#run-object", "Заменить предмет"],
    ["#gen-bg", "Сгенерировать фон"],
  ]) {
    const btn = $(sel);
    if (btn.dataset.busy === "1") continue;
    btn.textContent = blocked ? "Недоступно на этом тарифе" : normal;
    btn.classList.toggle("blocked", blocked);
  }

  // Ручной путь в этом случае — основной, а не запасной.
  $("#pick-swap").classList.toggle("primary", blocked);
  $("#use-as-sheet").classList.toggle("primary", blocked);
}

// --- состояние доступа к Higgsfield ------------------------------------------

const hf = { ready: false, reason: "Проверяю доступ к Higgsfield…" };

async function checkHiggsfield() {
  const res = await hfStatus();
  hf.ready = res.ready;
  hf.reason = res.reason;

  // Состояние объявляем сразу и вверху: мастер, который выглядит рабочим и
  // молча ничего не делает, — худшее, что можно предложить.
  const notice = $("#notice");
  notice.hidden = false;
  notice.classList.toggle("ok", res.state === "ok");
  notice.classList.toggle("warn", res.state === "unknown");
  const balance = res.credits != null
    ? ` План ${res.plan ?? "?"}, кредитов: ${res.credits}.`
    : "";
  $("#recheck").hidden = res.state !== "blocked";
  if (res.state === "ok") {
    $("#notice-title").textContent = "Всё готово.";
    $("#notice-text").textContent =
      "Мастер проходится целиком: шаги 2 и 4 считаются автоматически." + balance;
  } else if (res.state === "unknown") {
    $("#notice-title").textContent = "Генерация ещё не проверена.";
    $("#notice-text").textContent = balance +
      " Ключ принят, но доступна ли генерация на вашем тарифе, выяснится "
      + "только на первой попытке — счёт кредитов заранее узнать нельзя. Если тариф "
      + "её не даст, мастер сразу переключится на ручной путь и больше не будет "
      + "предлагать кнопки, которые не работают.";
  } else {
    $("#notice-title").textContent = "Шаги 2 и 4 сейчас не работают.";
    $("#notice-text").textContent =
      `${res.reason}${balance} Шаги 1, 3 и 5 работают как обычно: выбор исходника, фон и сборка `
      + "готового ролика со звуком. Чистовой лист и замену нужно получить снаружи "
      + "и подставить кнопками «Фото уже чистовое» и «Загрузить готовый результат замены».";
  }

  if (!state.sheet) $("#sheet-info").textContent = res.ready ? "Листа пока нет." : res.reason;
  if (!state.swap) $("#swap-info").textContent = res.ready ? "Нужны исходник и чистовой лист." : res.reason;
  refresh();
}

// --- сборка интерфейса -------------------------------------------------------

function wire() {
  wireSteps();
  for (const b of document.querySelectorAll("#modes .mode")) {
    b.onclick = () => setMode(b.dataset.mode);
  }
  setMode("character");
  $("#run-object").onclick = generateObject;

  $("#pick-src").onclick = () => $("#src-file").click();
  $("#src-file").onchange = (e) => e.target.files[0] && pickSource(e.target.files[0]);

  $("#pick-char").onclick = () => $("#char-file").click();
  $("#char-file").onchange = (e) => e.target.files[0] && pickCharacter(e.target.files[0]);
  $("#use-as-sheet").onclick = () =>
    state.charFile && setSheet(state.charFile, `Как чистовой лист взято «${state.charFile.file.name}».`);

  $("#pick-bg").onclick = () => $("#bg-file").click();
  $("#bg-file").onchange = (e) => e.target.files[0] && pickBackground(e.target.files[0]);
  $("#bg-keep").onclick = () => {
    state.bgMode = "keep";
    state.bg = null;
    $("#bg-info").textContent = "Обстановка остаётся вашей: персонаж встанет в ваш кадр.";
    markDone(3);
    if (state.swap) previewComposite("Кадр из вашей сцены.");
    refresh();
  };
  $("#no-bg").onclick = () => {
    state.bgMode = "plate";
    state.bg = null;
    $("#bg-info").textContent = "Персонаж придёт на ровной заливке — фон подставите позже.";
    markDone(3);
    previewComposite("Ровная заливка.");
    refresh();
  };
  $("#gen-bg").onclick = generateBackground;
  $("#make-sheet").onclick = generateSheet;
  $("#run-swap").onclick = generateSwap;

  $("#pick-swap").onclick = () => $("#swap-file").click();
  $("#swap-file").onchange = (e) => e.target.files[0] && useSwapResult(e.target.files[0]);

  $("#format").onchange = (e) => {
    state.format = e.target.value;
    if (state.swap) previewComposite();
  };
  $("#tolerance").oninput = (e) => {
    state.tolerance = Number(e.target.value);
    $("#tol-value").textContent = state.tolerance.toFixed(2);
    if (flatkey.ready) {
      flatkey.reapply({ tolerance: state.tolerance });
      previewComposite();
    }
  };
  $("#assemble").onclick = assemble;

  $("#lib-refresh").onclick = loadLibrary;
  loadLibrary();
  // Дальше список поддерживает сервер: он один следит за заданиями и шлёт
  // изменения во все открытые вкладки.
  subscribeJobs(renderLibrary);

  $("#recheck").onclick = async () => {
    const btn = $("#recheck");
    btn.disabled = true;
    btn.textContent = "Проверяю…";
    await hfRecheck().catch(() => {});
    await checkHiggsfield();
    btn.disabled = false;
    btn.textContent = "Проверить ещё раз";
  };

  showEmpty(true, "Здесь появится кадр");
  fitPreview();
  new ResizeObserver(fitPreview).observe($("#preview"));
  refresh();
  checkHiggsfield();
}

wire();
window.__wizard = { state, flatkey, processor, previewComposite };
