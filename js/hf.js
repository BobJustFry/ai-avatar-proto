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
    if (d.trialBlocked) {
      return {
        ready: false,
        reason: "Тариф Higgsfield не даёт приложению генерировать. Сделайте этот шаг "
          + "снаружи и загрузите готовый файл кнопкой ниже.",
      };
    }
    return { ready: true, reason: "", credits: d.credits ?? "?" };
  } catch (err) {
    return { ready: false, reason: `Сервер недоступен (${err.message}). Запустите run.cmd.` };
  }
}

/** Чистовой лист персонажа из произвольного фото. */
export async function makeSheet(file, { prompt, aspect = "9:16" } = {}) {
  return post("/sheet", { image: await toBase64(file), name: file.name, prompt, aspect });
}

/** Замена: персонаж с листа повторяет движение из видео. */
export async function runSwap(sheetFile, videoFile, { resolution = "720p" } = {}) {
  return post("/swap", {
    image: await toBase64(sheetFile),
    video: await toBase64(videoFile),
    resolution,
  });
}

/** Фон по описанию. */
export async function makeBackground(prompt, { aspect = "9:16" } = {}) {
  return post("/background", { prompt, aspect });
}
