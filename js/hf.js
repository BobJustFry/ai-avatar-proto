// Клиент к нашему серверу для шагов, которые считает Higgsfield.
// Ключ живёт только на сервере, браузер его не видит.

const API = "/api/hf";

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const toBase64 = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(",")[1]);
  fr.onerror = () => reject(new Error("не удалось прочитать файл"));
  fr.readAsDataURL(file);
});

/** Доступна ли генерация. Причина формулируется так, чтобы было ясно, что делать. */
export async function hfStatus() {
  try {
    const res = await fetch(`${API}/status`);
    if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
    const d = await res.json();
    if (!d.cli) {
      return { ready: false, reason: "CLI Higgsfield не найден на сервере: npm i -g @higgsfield/cli" };
    }
    if (!d.configured) {
      return { ready: false, reason: "Ключ Higgsfield не задан: заполните .env и перезапустите сервер." };
    }
    if (!d.authOk) {
      return { ready: false, reason: "Ключ Higgsfield не принят — проверьте пару ID и секрет в .env." };
    }
    const account = { credits: d.credits, plan: d.plan };
    if (d.genState === "blocked") {
      return {
        ...account,
        ready: false,
        state: "blocked",
        reason: "Тариф Higgsfield не давал приложению генерировать при прошлой попытке. "
          + "Если план сменился — нажмите «Проверить ещё раз».",
      };
    }
    // «unknown» — ключ рабочий, но генерацию ещё ни разу не пробовали.
    // Врать «всё готово» нельзя: доступность выяснится только на первой попытке.
    return { ...account, ready: true, state: d.genState === "ok" ? "ok" : "unknown", reason: "" };
  } catch (err) {
    return { ready: false, reason: `Сервер недоступен (${err.message}). Запустите run.cmd.` };
  }
}

/** Забыть прошлый отказ и проверить доступность заново. */
export async function hfRecheck() {
  return post("/recheck", {});
}

/** Ставит задание в очередь; возвращает его id, не дожидаясь результата. */
export async function makeSheet(file, { prompt, aspect = "9:16" } = {}) {
  return post("/sheet", { image: await toBase64(file), name: file.name, prompt, aspect });
}

export async function runSwap(sheetFile, videoFile, { resolution = "720p" } = {}) {
  return post("/swap", {
    image: await toBase64(sheetFile),
    video: await toBase64(videoFile),
    resolution,
  });
}

export async function makeBackground(prompt, { aspect = "9:16" } = {}) {
  return post("/background", { prompt, aspect });
}

/**
 * Ждёт задание опросом. Вебхука здесь нет и быть не может: приложение живёт на
 * localhost, снаружи его не видно. Зато задание не теряется при перезагрузке —
 * его всегда можно найти в библиотеке по id.
 */
export async function waitForJob(jobId, { onTick, intervalMs = 5000, timeoutMs = 20 * 60_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const res = await fetch(`${API}/job?id=${encodeURIComponent(jobId)}`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `статус задания: ${res.status}`);
    if (d.status === "completed" && d.url) return d.url;
    if (d.status === "failed" || d.status === "canceled") {
      throw new Error(`задание завершилось со статусом «${d.status}»`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("задание считается слишком долго — найдите его в библиотеке позже");
    }
    onTick?.(Math.round((Date.now() - started) / 1000), d.status);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Всё, что сгенерировано на аккаунте. */
export async function hfLibrary() {
  const res = await fetch(`${API}/library`);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `библиотека: ${res.status}`);
  return d.items ?? [];
}
