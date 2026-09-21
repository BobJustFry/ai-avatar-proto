// Сборка прототипа: источник (камера или файл) -> MediaPipe -> сигналы ->
// риг/вырезка -> канвас -> превью или готовый файл.

import { createFaceLandmarker, createSegmenter, openCamera } from "./tracker.js";
import { FaceSignals } from "./signals.js";
import { Rig } from "./rig.js";
import { Scenes, drawCover } from "./scene.js";
import { Cutout } from "./cutout.js";
import { FlatKey } from "./flatkey.js";
import { Recorder } from "./recorder.js";
import { SourceRecorder, VideoProcessor, downloadBlob, stamp } from "./pipeline.js";
import { WhipPublisher } from "./live.js";
import { LiveAvatarProvider } from "./provider.js";

const $ = (sel) => document.querySelector(sel);
const canvas = $("#out");
const ctx = canvas.getContext("2d");
const video = $("#cam");

const state = {
  mode: "avatar",
  parallax: true,
  debug: false,
  invertMask: false,
  keyTolerance: 0.10,
  running: false,   // крутится ли живое превью
  busy: false,      // идёт обработка файла
  hasCamera: false,
  provider: false,  // кадр даёт внешний фотореалистичный аватар
  voiceMode: "mic", // чем говорит аватар: "mic" — вашим голосом, "tts" — синтезом
};

const signals = new FaceSignals();
const rig = new Rig();
const scenes = new Scenes();
const cutout = new Cutout();
const flatkey = new FlatKey();
const recorder = new Recorder(canvas);
const srcRec = new SourceRecorder();
const processor = new VideoProcessor(canvas);
const whip = new WhipPublisher();
const provider = new LiveAvatarProvider();

let landmarker = null;
let segmenter = null;
let faceResult = null;
let sourceReady = false;
let lastVideoTime = -1;
let last = performance.now();
let fpsAvg = 0;

boot();

async function boot() {
  const msg = $("#boot-msg");
  try {
    msg.textContent = "Загружаю модель лица (~4 МБ)…";
    landmarker = await createFaceLandmarker();
    msg.textContent = "Загружаю сцены и аватара…";
    const list = await scenes.load();
    $("#scene").innerHTML = list.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
    reportAssets(await rig.load());
    fitFrame();
    msg.textContent = "Готово. Всё считается локально — ни видео, ни звук никуда не уходят.";
    $("#boot-btn").hidden = false;
    $("#boot-btn").onclick = startCamera;
    $("#boot-file").hidden = false;
    $("#boot-file").onclick = () => {
      $("#boot").hidden = true;
      render(signals.v);
      document.getElementById("dlg-video").showModal();
      $("#file").click();
    };
  } catch (err) {
    console.error(err);
    msg.textContent = `Не удалось загрузить модели: ${err.message}. Нужен интернет для CDN и https либо localhost.`;
  }
  wireUI();
}

async function startCamera() {
  const msg = $("#boot-msg");
  try {
    $("#boot-btn").disabled = true;
    msg.textContent = "Запрашиваю камеру…";
    await openCamera(video);
    $("#boot").hidden = true;
    state.hasCamera = true;
    startLoop();
  } catch (err) {
    console.error(err);
    $("#boot-btn").disabled = false;
    msg.textContent = `Камера недоступна: ${err.message}`;
  }
}

function startLoop() {
  if ((!state.hasCamera && !state.provider) || state.busy) return;
  state.running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

/** Вписывает кадр в сцену целиком, сохраняя пропорцию холста. */
function fitFrame() {
  const stage = $("#stage");
  const frame = document.querySelector(".frame");
  const cs = getComputedStyle(stage);
  const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return;
  const ar = canvas.width / canvas.height;
  const w = Math.min(availW, availH * ar);
  frame.style.width = `${Math.floor(w)}px`;
  frame.style.height = `${Math.floor(w / ar)}px`;
}

/** Меняет размер холста: от него зависит и кадрирование, и размер результата. */
function setFormat(value) {
  const [w, h] = value.split("x").map(Number);
  if (!w || !h) return;
  canvas.width = w;
  canvas.height = h;
  fitFrame();
  render(signals.v);
}

new ResizeObserver(fitFrame).observe(document.querySelector("#stage"));

function reportAssets(stats) {
  const parts = [`из файлов: ${stats.fromFile.length}`, `заглушек: ${stats.fromPlaceholder.length}`];
  if (stats.failed.length) parts.push(`без слоя: ${stats.failed.join(", ")}`);
  $("#asset-msg").textContent = parts.join(" · ");
}

// --- один кадр: трекинг источника и отрисовка -------------------------------

function analyze(el, dt) {
  const ts = performance.now();
  if (state.mode === "key") {
    flatkey.update(el, { tolerance: state.keyTolerance });
    const sig = signals.relax(dt);
    render(sig);
    return sig;
  }
  faceResult = landmarker.detectForVideo(el, ts);
  if (state.mode === "cutout" && segmenter) {
    const res = segmenter.segmentForVideo(el, ts);
    if (res?.categoryMask) cutout.update(el, res.categoryMask, { invert: state.invertMask });
    res?.close?.();
  }
  const sig = signals.update(faceResult, dt);
  render(sig);
  return sig;
}

function render(sig) {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  scenes.draw(ctx, w, h, sig, { parallax: state.parallax });
  if (state.mode === "avatar") {
    rig.draw(ctx, w, h, sig, signals.viseme, { follow: true });
  } else if (state.mode === "key") {
    if (flatkey.ready) drawCover(ctx, flatkey.frame, w, h, 0, 0, 1, false);
  } else {
    cutout.repaint(ctx, w, h, signals.mirror);
  }
  if (state.debug) drawDebug(sig);
}

function frame(now) {
  if (!state.running) return;
  requestAnimationFrame(frame);

  const dt = Math.min((now - last) / 1000, 0.1) || 0.016;
  last = now;
  fpsAvg = fpsAvg ? fpsAvg * 0.9 + (1 / dt) * 0.1 : 1 / dt;

  if (state.provider) {
    renderProvider();
    $("#fps").textContent = `${fpsAvg.toFixed(0)} fps`;
    $("#face").textContent = whip.active ? `эфир: ${whip.state}` : "провайдер";
    return;
  }

  if (video.readyState < 2) return;
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    analyze(video, dt);
  } else {
    render(signals.update(faceResult, dt)); // добиваем сглаживание между кадрами камеры
  }

  $("#fps").textContent = `${fpsAvg.toFixed(0)} fps`;
  $("#face").textContent = signals.present ? `визема: ${signals.viseme}` : "нет лица";
}

// --- фотореалистичный аватар провайдера --------------------------------------

// Кадр провайдера приходит со своим фоном, поэтому режем его той же
// сегментацией, что и человека в режиме «Я на фоне».
function renderProvider() {
  const el = provider.video;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  scenes.draw(ctx, w, h, signals.v, { parallax: false });
  if (!el || el.readyState < 2) return;

  if (segmenter) {
    const res = segmenter.segmentForVideo(el, performance.now());
    if (res?.categoryMask) cutout.update(el, res.categoryMask, { invert: state.invertMask });
    res?.close?.();
    cutout.repaint(ctx, w, h, false);
  } else {
    drawCover(ctx, el, w, h, 0, 0, 1, false);
  }
}

async function toggleProvider(on) {
  const hint = $("#provider-hint");
  if (!on) {
    state.provider = false;
    await provider.stop();
    hint.textContent = "Провайдер отключён, кадр снова ведёт локальный риг.";
    startLoop();
    return;
  }
  try {
    hint.textContent = "Поднимаю сессию провайдера…";
    provider.onState = (msg) => { hint.textContent = msg; };
    await ensureSegmenter();
    const avatarId = $("#avatar-id").value;
    if (!avatarId) throw new Error("не выбран аватар");
    await provider.start({ avatarId, quality: "very_high", voiceMode: state.voiceMode });
    state.provider = true;
    cutout.reset();
    startLoop();
  } catch (err) {
    console.error(err);
    $("#use-provider").checked = false;
    state.provider = false;
    hint.textContent = `Провайдер не поднялся: ${err.message}`;
  }
}

function applyVoiceModeUI() {
  const tts = state.voiceMode === "tts";
  $("#say-text").hidden = !tts;
  $("#say-row").hidden = !tts;
  $("#voice-id").hidden = !tts || !$("#voice-id").options.length;
}

async function setVoiceMode(mode) {
  state.voiceMode = mode;
  document.querySelectorAll(".seg-voice").forEach((b) => b.classList.toggle("on", b.dataset.voice === mode));
  applyVoiceModeUI();
  if (provider.active) await provider.setVoiceMode(mode);
}

async function say() {
  const text = $("#say-text").value.trim();
  if (!text) return;
  const btn = $("#say");
  btn.disabled = true;
  try {
    await provider.say(text, $("#voice-id").value || undefined);
  } catch (err) {
    $("#provider-hint").textContent = `Синтез не прошёл: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function fillVoices() {
  const sel = $("#voice-id");
  try {
    const { voices = [], current } = await provider.listVoices();
    if (!voices.length) return; // ключа синтеза нет — остаётся режим «мой голос»
    sel.innerHTML = voices.map((v) => `<option value="${v.id}">${v.name}</option>`).join("");
    if (current) sel.value = current;
    applyVoiceModeUI();
  } catch {
    // сервер не поднят: режим синтеза просто не покажет список
  }
}

async function fillAvatars() {
  const sel = $("#avatar-id");
  const hint = $("#provider-hint");
  try {
    const list = await provider.listAvatars();
    const items = Array.isArray(list) ? list : list.items ?? list.avatars ?? [];
    if (!items.length) {
      sel.hidden = true;
      hint.textContent = list.configured === false
        ? "Ключ провайдера не задан — доступен только локальный риг. Как включить: docs/streaming.md."
        : "Каталог аватаров пуст.";
      return;
    }
    sel.innerHTML = items
      .map((a) => `<option value="${a.id ?? a.avatar_id}">${a.name ?? a.id}</option>`)
      .join("");
    sel.hidden = false;
  } catch (err) {
    sel.hidden = true;
    hint.textContent = `Каталог аватаров недоступен: ${err.message}. Нужен запущенный server/live-server.mjs.`;
  }
}

async function toggleLive() {
  const btn = $("#go-live");
  const hint = $("#live-hint");
  if (whip.active) {
    await whip.stop();
    btn.classList.remove("on");
    btn.textContent = "В эфир";
    $("#live-badge").hidden = true;
    hint.textContent = "Эфир остановлен.";
    return;
  }
  try {
    btn.disabled = true;
    // Звук в эфир: голос аватара от провайдера либо обычный микрофон.
    let audioTrack = provider.audioTrack ?? null;
    if (!audioTrack) {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      audioTrack = mic?.getAudioTracks()[0] ?? null;
    }
    await whip.start(canvas, {
      url: $("#whip-url").value.trim(),
      token: $("#whip-token").value.trim() || undefined,
      audioTrack,
    });
    btn.classList.add("on");
    btn.textContent = "Остановить эфир";
    $("#live-badge").hidden = false;
    hint.textContent = audioTrack ? "В эфире, со звуком." : "В эфире, без звука.";
  } catch (err) {
    console.error(err);
    hint.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// --- конвейер видео → видео --------------------------------------------------

async function useSource(blobOrFile, label) {
  try {
    const meta = await processor.open(blobOrFile);
    sourceReady = true;
    $("#process").disabled = false;
    $("#src-info").textContent =
      `${label}: ${meta.width}×${meta.height}, ${meta.duration.toFixed(1)} с`;
  } catch (err) {
    sourceReady = false;
    $("#process").disabled = true;
    $("#src-info").textContent = `Не открылось: ${err.message}`;
  }
}

async function processSource() {
  if (!sourceReady || state.busy) return;
  state.busy = true;
  state.running = false;
  const btn = $("#process");
  btn.disabled = true;
  btn.textContent = "Обрабатываю…";
  $("#progress").hidden = false;

  // Исходник — обычная запись, а не зеркало, и нейтраль берём из него самого.
  signals.mirror = false;
  signals.beginAutoCalibrate(1.2);
  cutout.reset();
  flatkey.bg = null;
  if (state.mode === "cutout") await ensureSegmenter();

  try {
    const blob = await processor.run({
      onFrame: (el, dt) => analyze(el, dt),
      onProgress: (p) => { $("#bar").style.width = `${(p * 100).toFixed(1)}%`; },
    });
    downloadBlob(blob, `avatar-${stamp()}.webm`);
    $("#proc-hint").textContent = `Готово: ${(blob.size / 1e6).toFixed(1)} МБ, файл в загрузках.`;
  } catch (err) {
    console.error(err);
    $("#proc-hint").textContent = `Ошибка обработки: ${err.message}`;
  } finally {
    signals.mirror = true;
    cutout.reset();
    state.busy = false;
    btn.disabled = false;
    btn.textContent = "Обработать в аватара";
    $("#progress").hidden = true;
    $("#bar").style.width = "0%";
    startLoop();
  }
}

// --- интерфейс ---------------------------------------------------------------

function wireDialogs() {
  for (const btn of document.querySelectorAll("[data-open]")) {
    btn.onclick = () => document.getElementById(btn.dataset.open).showModal();
  }
  // Клик по затемнению закрывает: нативно <dialog> так не умеет.
  for (const dlg of document.querySelectorAll("dialog")) {
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }
}

function wireUI() {
  wireDialogs();
  for (const btn of document.querySelectorAll(".seg")) {
    btn.onclick = () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll(".seg").forEach((b) => b.classList.toggle("on", b === btn));
      toast({
        avatar: "Мимика управляет нарисованным персонажем, человека в кадре нет.",
        cutout: "Сегментация вырезает человека и ставит его на сгенерированный фон.",
        key: "Ровный фон вырезается по цвету — для готового результата замены.",
      }[state.mode]);
      if (state.mode === "cutout") ensureSegmenter();
      if (state.mode === "key") flatkey.bg = null;
    };
  }
  $("#scene").onchange = (e) => scenes.select(e.target.value);
  $("#format").onchange = (e) => setFormat(e.target.value);
  $("#tolerance").oninput = (e) => {
    state.keyTolerance = Number(e.target.value);
    $("#tol-value").textContent = state.keyTolerance.toFixed(2);
    // На паузе показываем результат сразу, не дожидаясь следующего кадра.
    if (!state.running && flatkey.ready) {
      flatkey.reapply({ tolerance: state.keyTolerance });
      render(signals.v);
    }
  };
  $("#parallax").onchange = (e) => { state.parallax = e.target.checked; };
  $("#debug").onchange = (e) => { state.debug = e.target.checked; };
  $("#invert-mask").onchange = (e) => { state.invertMask = e.target.checked; cutout.reset(); };
  $("#calib").onclick = () => { signals.calibrate(); flash($("#calib"), "Готово"); };
  $("#reload-rig").onclick = async () => {
    reportAssets(await rig.load());
    flash($("#reload-rig"), "Обновлено");
  };

  $("#use-provider").onchange = (e) => toggleProvider(e.target.checked);
  $("#go-live").onclick = toggleLive;
  for (const btn of document.querySelectorAll(".seg-voice")) {
    btn.onclick = () => setVoiceMode(btn.dataset.voice);
  }
  $("#say").onclick = say;
  fillAvatars();
  fillVoices();

  $("#pick-audio").onclick = () => $("#audio-file").click();
  $("#audio-file").onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const meta = await processor.openAudio(f);
      $("#audio-info").textContent = `Звук из «${f.name}», ${meta.duration.toFixed(1)} с.`;
      $("#drop-audio").hidden = false;
    } catch (err) {
      $("#audio-info").textContent = `Не открылось: ${err.message}`;
    }
  };
  $("#drop-audio").onclick = async () => {
    await processor.openAudio(null);
    $("#audio-file").value = "";
    $("#drop-audio").hidden = true;
    $("#audio-info").textContent = "Звук берётся из самого исходника.";
  };

  $("#pick-file").onclick = () => $("#file").click();
  $("#file").onchange = (e) => {
    const f = e.target.files?.[0];
    if (f) useSource(f, f.name);
  };
  $("#rec-src").onclick = async () => {
    const btn = $("#rec-src");
    if (srcRec.active) {
      const blob = await srcRec.stop();
      btn.classList.remove("on");
      btn.textContent = "● Записать с камеры";
      if (blob) await useSource(blob, "запись с камеры");
      return;
    }
    if (!state.hasCamera) {
      $("#src-info").textContent = "Сначала включите камеру или откройте файл.";
      return;
    }
    await srcRec.start(video.srcObject);
    btn.classList.add("on");
    btn.textContent = "■ Стоп";
    $("#src-info").textContent = "Идёт запись исходника…";
  };
  $("#process").onclick = processSource;

  $("#rec").onclick = async () => {
    const btn = $("#rec");
    if (recorder.active) {
      await recorder.stop();
      btn.classList.remove("on");
      btn.textContent = "● Запись";
      toast("Файл сохранён в загрузки.");
    } else {
      const { withAudio } = await recorder.start();
      btn.classList.add("on");
      btn.textContent = "■ Стоп";
      toast(withAudio ? "Пишу видео и микрофон." : "Пишу видео без звука.");
    }
  };
  $("#shot").onclick = () => recorder.snapshot();
}

let toastTimer = 0;
/** Короткое сообщение над тулбаром: панели с подсказками больше нет. */
function toast(text, ms = 3200) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 900);
}

async function ensureSegmenter() {
  if (segmenter) return;
  toast("Загружаю модель сегментации…");
  try {
    segmenter = await createSegmenter();
    cutout.reset();
    toast("Сегментация готова.");
  } catch (err) {
    toast(`Сегментация не загрузилась: ${err.message}`, 6000);
  }
}

// Доступ из консоли: можно прогнать рендер с искусственными сигналами,
// не включая камеру — удобно при подгонке слоёв.
window.__avatar = { state, signals, rig, scenes, cutout, flatkey, setFormat, processor, whip, provider, render, analyze, canvas, ctx };

function drawDebug(sig) {
  const w = canvas.width, h = canvas.height;
  const lm = signals.landmarks;
  ctx.save();
  if (lm) {
    ctx.fillStyle = "#6ea8fe";
    for (const p of lm) {
      const x = signals.mirror ? (1 - p.x) * w : p.x * w;
      ctx.fillRect(x - 1, p.y * h - 1, 2, 2);
    }
  }
  const lines = [
    `yaw ${sig.yaw.toFixed(2)}  pitch ${sig.pitch.toFixed(2)}  roll ${sig.roll.toFixed(2)}`,
    `blink ${sig.blinkL.toFixed(2)}/${sig.blinkR.toFixed(2)}  gaze ${sig.gazeX.toFixed(2)}/${sig.gazeY.toFixed(2)}`,
    `open ${sig.open.toFixed(2)}  round ${sig.round.toFixed(2)}  smile ${sig.wide.toFixed(2)}`,
    `scale ${sig.scale.toFixed(2)}  brow ${sig.browL.toFixed(2)}/${sig.browR.toFixed(2)}`,
  ];
  ctx.fillStyle = "#0b0d11c0";
  ctx.fillRect(10, h - 22 * lines.length - 20, 430, 22 * lines.length + 12);
  ctx.fillStyle = "#e7ebf0";
  ctx.font = "14px ui-monospace, monospace";
  lines.forEach((t, i) => ctx.fillText(t, 20, h - 22 * (lines.length - i) - 4));

  // Топ-8 блендшейпов — удобно смотреть, что вообще ловит модель.
  const top = Object.entries(signals.blendshapes)
    .filter(([k]) => k !== "_neutral")
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  ctx.font = "12px ui-monospace, monospace";
  top.forEach(([name, v], i) => {
    const y = 60 + i * 20;
    ctx.fillStyle = "#0b0d11c0";
    ctx.fillRect(w - 250, y - 12, 240, 16);
    ctx.fillStyle = "#f0a5c0";
    ctx.fillRect(w - 248, y - 10, 120 * v, 12);
    ctx.fillStyle = "#e7ebf0";
    ctx.fillText(`${name} ${v.toFixed(2)}`, w - 244, y);
  });
  ctx.restore();
}
