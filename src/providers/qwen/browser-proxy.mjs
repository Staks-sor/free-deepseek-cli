// Невидимый Playwright-прокси для Qwen API.
//
// ЗАЧЕМ:
// Заголовок `bx-ua` — это криптоподпись запроса, генерируемая JS+WASM-бандлом
// chat.qwen.ai. Она привязана к URL + хешу body + nonce + bx-umidtoken.
// Поэтому скопировать `bx-ua` из cURL в .env и переиспользовать — не работает,
// сервер всегда отвечает `Bad_Request`.
//
// РЕШЕНИЕ:
// Держим один persistent Chromium с открытой страницей chat.qwen.ai.
// Все наши POST идут через `page.evaluate(fetch)` — браузер выполняет fetch
// в контексте страницы, их перехватчик автоматически подписывает запрос
// свежим `bx-ua` и кладёт куки/origin/referer.
//
// Для нас это прозрачный прокси — мы передаём url+body, получаем text ответа.
//
// Lifecycle: ленивый launch на первом вызове, держим контекст до закрытия процесса.

import { QWEN_AUTH_FILE, QWEN_BASE_URL, QWEN_BROWSER_PROFILE } from "./config.mjs";
import { applyQwenCookiesToContext, readQwenAuth } from "./auth-files.mjs";

let proxyPromise = null;

// Сброс singleton после re-login / refresh — следующий запрос поднимет прокси с новыми куками.
export function resetQwenBrowserProxy() {
  if (proxyPromise) {
    proxyPromise
      .then((proxy) => proxy.close?.())
      .catch(() => {});
  }
  proxyPromise = null;
}

// Возвращает singleton-инстанс прокси. Все вызовы делят один Chromium.
export function getQwenBrowserProxy({ debug = false } = {}) {
  if (!proxyPromise) {
    proxyPromise = createProxy({ debug }).catch((err) => {
      // При сбое сбрасываем, чтобы следующий вызов попробовал заново.
      proxyPromise = null;
      throw err;
    });
  }
  return proxyPromise;
}

async function createProxy({ debug }) {
  const { chromium } = await import("playwright");

  if (debug) console.log("[qwen-proxy] launching headless Chromium with profile…");

  const context = await chromium.launchPersistentContext(QWEN_BROWSER_PROFILE, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    locale: "ru-RU",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=site-per-process",
    ],
  });

  // Стелс — те же меры, что в browser-login.mjs.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "" },
        { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "" },
      ],
    });
    Object.defineProperty(navigator, "languages", { get: () => ["ru-RU", "ru", "en"] });
    if (!window.chrome) window.chrome = { runtime: {} };
  });

  const page = context.pages()[0] || (await context.newPage());

  // auth.json может быть свежее профиля (import-qwen, silent refresh). Подмешиваем куки до goto.
  const savedAuth = readQwenAuth(QWEN_AUTH_FILE);
  if (savedAuth?.cookies?.length) {
    const n = await applyQwenCookiesToContext(context, savedAuth.cookies);
    if (debug) console.log(`[qwen-proxy] injected ${n} cookies from auth.json`);
  }

  if (debug) {
    // Фильтр шума: console.groupEnd с именем «Error» из Qwen-овского JS (это
    // просто метка группы, не реальная ошибка), Mixed Content для favicon,
    // ERR_CONNECTION_REFUSED на 127.0.0.1, WebGL GPU stall, APLUS init и т.п.
    const SUPPRESS_PATTERNS = [
      /^endGroup:/,                  // console.groupEnd с любым лейблом — это закрытие группы
      /^clear:/,                     // console.clear
      /^debug: Error$/,              // именно строка «debug: Error» — внутренний маркер
      /Mixed Content.*favicon/i,
      /ERR_CONNECTION_REFUSED.*127\.0\.0\.1/i,
      /Failed to load resource:.*favicon/i,
      /Failed to load resource:.*net::ERR_/i,
      /GPU stall due to ReadPixels/i,
      /APLUS INIT SUCCESS/i,
      /Browser detection:/i,
      /Modern features support:/i,
      /^log:\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/, // голые таймстампы из их JS
    ];
    page.on("console", (msg) => {
      const text = `${msg.type()}: ${msg.text()}`;
      if (SUPPRESS_PATTERNS.some((re) => re.test(text))) return;
      console.log(`[qwen-proxy:console] ${text}`);
    });
    page.on("pageerror", (err) => {
      // indexedDB.open ошибки на headless безобидны — это известная проблема persistent context.
      if (/indexedDB\.open/i.test(err.message)) return;
      console.error(`[qwen-proxy:pageerror] ${err.message}`);
    });
  }

  await page.goto(QWEN_BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // Даём JS-бандлу проинициализировать перехватчик fetch (≈1–2 сек).
  await page.waitForTimeout(2000);

  if (debug) console.log("[qwen-proxy] ready");

  // Кэш: текущий chat_id, на котором стоит страница. Не навигируем зря.
  let currentChatId = null;

  // Graceful shutdown при завершении процесса.
  const close = async () => {
    try { await context.close(); } catch {}
  };
  process.once("exit", () => { close(); });
  process.once("SIGINT", () => { close().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { close().then(() => process.exit(0)); });

  // Навигация на /c/<chatId>. Это, похоже, ЕДИНСТВЕННЫЙ способ зарегистрировать
  // chat_id на сервере Qwen — после goto JS-бандл сам делает скрытую синхронизацию
  // (WebSocket / late POST), и сервер начинает принимать /completions для этого id.
  async function ensureChatPage(chatId) {
    if (currentChatId === chatId) return;
    if (debug) console.log(`[qwen-proxy] navigating to /c/${chatId}`);
    await page.goto(`${QWEN_BASE_URL}/c/${encodeURIComponent(chatId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // Подождём, пока SPA доделает свою регистрацию (WebSocket handshake и т.п.).
    await page.waitForTimeout(1500);
    currentChatId = chatId;
  }

  return {
    // Прокинуть fetch через контекст страницы. Перед запросом обязательно
    // переходим на /c/<chatId>, чтобы чат был зарегистрирован SPA-роутером.
    // Возвращает { ok, status, contentType, text } — Node парсит text сам.
    async proxyFetch({ url, body, chatId }) {
      if (chatId) await ensureChatPage(chatId);
      const result = await page.evaluate(
        async ({ url, body }) => {
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body,
              credentials: "include",
            });
            const text = await res.text();
            return {
              ok: res.ok,
              status: res.status,
              contentType: res.headers.get("content-type") || "",
              text,
            };
          } catch (e) {
            return { ok: false, status: 0, contentType: "", text: `__fetch_error__: ${e.message}` };
          }
        },
        { url, body },
      );
      return result;
    },
    async close() { await close(); },
  };
}
