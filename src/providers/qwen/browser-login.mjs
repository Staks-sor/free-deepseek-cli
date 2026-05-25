// Login flow для chat.qwen.ai через Playwright.
//
// АЛЬТЕРНАТИВА: если Playwright блокируется антиботом Alibaba (а это бывает),
// используй importQwenFromJson(path) — он принимает JSON-файл cookies, экспортированный
// расширением Chrome (типа "Cookie Editor" или "EditThisCookie"), и сохраняет
// их в qwen-auth.json без Playwright.
//
// Алгоритм:
// 1. Поднимаем persistent Chromium с СОБСТВЕННЫМ профилем (QWEN_BROWSER_PROFILE) —
//    чтобы Google-сессии Qwen не смешивались с DeepSeek.
// 2. Открываем chat.qwen.ai.
// 3. Юзер логинится сам (Google OAuth / email-пароль).
// 4. Ждём, пока в cookies появится `token` (JWT). Это и есть финальный сигнал логина.
// 5. Сохраняем cookies + token в qwen-auth.json.
//
// В отличие от DeepSeek у нас здесь НЕТ:
// - PoW WASM-loader'a
// - Сетевого "Authorization Bearer" detection (можно добавить позже)
// - Сложного авто-заполнения формы (не делаем до сбора фидбэка)

import fs from "node:fs";
import { launchPersistentDeepSeekContext } from "../../browser/launch.mjs";
import {
  QWEN_AUTH_FILE,
  QWEN_BASE_URL,
  QWEN_BROWSER_PROFILE,
  QWEN_REQUIRED_COOKIES,
  QWEN_TOKEN_COOKIE_NAME,
} from "./config.mjs";
import {
  applyQwenCookiesToContext,
  qwenCookieHeaderFromArray,
  writeQwenAuth,
} from "./auth-files.mjs";

// Импорт куки из JSON-файла, экспортированного из обычного Chrome
// (расширения "Cookie Editor", "EditThisCookie", и т.п.).
// Формат: массив объектов с полями name, value, domain, path, ...
//
// Это РАБОЧИЙ обходной путь, когда Playwright блокируется антиботом chat.qwen.ai.
// Юзер сам логинится в своём обычном Chrome → экспортит куки → мы импортим.
export async function importQwenFromJson(jsonPath, authFile = QWEN_AUTH_FILE) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Файл не найден: ${jsonPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Не валидный JSON в ${jsonPath}: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Ожидался массив cookies, получено: ${typeof parsed}`);
  }

  // Фильтруем только куки для qwen.ai (на случай если файл содержит и другие домены).
  const qwenCookies = parsed.filter((c) => {
    const d = String(c?.domain || "");
    return d.includes("qwen.ai");
  });

  if (qwenCookies.length === 0) {
    throw new Error(`В файле нет cookies для qwen.ai. Проверь экспорт.`);
  }

  // Ищем критичный token.
  const tokenCookie = qwenCookies.find((c) => c.name === QWEN_TOKEN_COOKIE_NAME);
  if (!tokenCookie?.value) {
    throw new Error(
      `В файле нет cookie "${QWEN_TOKEN_COOKIE_NAME}" — без него API Qwen не работает.\n` +
        `Залогинься в chat.qwen.ai, потом снова экспортируй cookies.`,
    );
  }

  const looksLikeJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tokenCookie.value);
  if (!looksLikeJwt) {
    console.warn(
      `⚠️ token не выглядит как JWT (3 части через точку). Возможно файл устарел или повреждён.`,
    );
  }

  // Приводим к Playwright-формату на всякий случай (некоторые экспортеры дают разный shape).
  const normalized = qwenCookies.map((c) => ({
    name: String(c.name),
    value: String(c.value),
    domain: String(c.domain),
    path: c.path || "/",
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: c.sameSite || "Lax",
    expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate) : -1,
  }));

  const userId =
    qwenCookies.find((c) => c.name === "cnaui")?.value ||
    qwenCookies.find((c) => c.name === "aui")?.value ||
    "";

  const profileDir = QWEN_BROWSER_PROFILE;
  writeQwenAuth(authFile, {
    cookies: normalized,
    token: tokenCookie.value,
    userId,
    profileDir,
  });

  // Синхронизируем куки в persistent-профиль — иначе browser-proxy не увидит сессию.
  try {
    await syncQwenCookiesToProfile(normalized, profileDir);
    console.log(`🔄 Cookies synced to browser profile (${profileDir})`);
  } catch (error) {
    console.warn(`⚠️ Could not sync cookies to profile: ${error.message}`);
    console.warn("   API через browser-transport может не работать до npm run login-qwen.");
  }

  console.log(`✅ Imported ${normalized.length} Qwen cookies (token: ${tokenCookie.value.slice(0, 24)}...)`);
  console.log(`💾 Saved to ${authFile}`);
  if (userId) console.log(`👤 user_id = ${userId}`);
  return { token: tokenCookie.value, userId, cookies: normalized };
}

// Главный entry-point для `npm run login-qwen`.
export async function loginQwenAndSave(authFile = QWEN_AUTH_FILE) {
  const profileDir = QWEN_BROWSER_PROFILE;
  const { chromium } = await import("playwright");
  // Переиспользуем launch-функцию от DeepSeek — она запускает реальный Chrome.
  const context = await launchPersistentDeepSeekContext(chromium, profileDir, false);

  // Стелс-меры против антибота Alibaba. Маскируем самые палевные follow-up
  // признаки автоматизации — navigator.webdriver, plugins, permissions API.
  // Делаем ДО первой навигации, чтобы их JS никогда не увидел "true" значения.
  await context.addInitScript(() => {
    // 1. Главный палевный флаг — webdriver. Скрываем через property descriptor.
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // 2. У автоматизированных браузеров navigator.plugins обычно пустой массив.
    // Подделываем "нормальный" список с одним PDF Viewer.
    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "" },
        { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "" },
      ],
    });

    // 3. languages — Playwright-Chromium иногда выставляет в один элемент. Делаем "ru-RU,ru,en".
    Object.defineProperty(navigator, "languages", { get: () => ["ru-RU", "ru", "en"] });

    // 4. window.chrome — в обычном Chrome есть, антибот может проверять.
    if (!window.chrome) {
      window.chrome = { runtime: {} };
    }
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(QWEN_BASE_URL, { waitUntil: "domcontentloaded" });

  console.log("🔓 Qwen login window открыто (chat.qwen.ai).");
  console.log("   • Залогинься любым способом (Google OAuth, email/пароль).");
  console.log("   • НИЧЕГО нажимать в терминале не нужно.");
  console.log("   • Окно закроется автоматически, когда появится JWT-токен.");

  let captured;
  try {
    captured = await waitForQwenToken(context);
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }

  writeQwenAuth(authFile, {
    cookies: captured.cookies,
    token: captured.token,
    userId: captured.userId,
    profileDir,
  });
  await context.close();

  console.log("✅ Qwen login successful.");
  console.log(`💾 Saved auth to ${authFile}`);
  return {
    token: captured.token,
    userId: captured.userId,
    cookieHeader: qwenCookieHeaderFromArray(captured.cookies),
    cookies: captured.cookies,
    source: authFile,
  };
}

// Ждём, пока в cookies появится валидный JWT в `token`.
// JWT — 3 части через точку, каждая base64url. Простой regex отсеивает «пустые» значения.
async function waitForQwenToken(context, { timeoutMs = 5 * 60 * 1000, intervalMs = 1000 } = {}) {
  const startedAt = Date.now();
  let lastSeen = "";
  while (Date.now() - startedAt < timeoutMs) {
    let cookies;
    try {
      cookies = await context.cookies(QWEN_BASE_URL);
    } catch {
      throw new Error("Qwen login window was closed before authentication completed.");
    }

    const tokenCookie = cookies.find((c) => c.name === QWEN_TOKEN_COOKIE_NAME);
    const allRequired = QWEN_REQUIRED_COOKIES.every((n) => cookies.some((c) => c.name === n));
    const token = tokenCookie?.value || "";
    const looksLikeJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

    if (allRequired && looksLikeJwt) {
      // cnaui — user UUID (опционально).
      const userId = cookies.find((c) => c.name === "cnaui")?.value
        || cookies.find((c) => c.name === "aui")?.value
        || "";
      return { cookies, token, userId };
    }

    if (token && token !== lastSeen) {
      lastSeen = token;
      console.log(`[qwen-login] token cookie found (${token.length} chars) — checking format...`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Qwen login timeout (${Math.round(timeoutMs / 1000)}s). Не дождались валидного JWT в куках. Попробуй снова.`,
  );
}

// Считать JWT и куки из уже открытого контекста (после goto на chat.qwen.ai).
async function captureQwenAuthFromContext(context, authFile, profileDir) {
  const cookies = await context.cookies(QWEN_BASE_URL);
  const tokenCookie = cookies.find((c) => c.name === QWEN_TOKEN_COOKIE_NAME);
  const token = tokenCookie?.value || "";
  const looksLikeJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

  if (!looksLikeJwt) {
    throw new Error(
      "В профиле Qwen нет валидного JWT (cookie token). Залогинься: npm run login-qwen",
    );
  }

  const userId =
    cookies.find((c) => c.name === "cnaui")?.value ||
    cookies.find((c) => c.name === "aui")?.value ||
    "";

  writeQwenAuth(authFile, { cookies, token, userId, profileDir });
  return {
    token,
    userId,
    cookieHeader: qwenCookieHeaderFromArray(cookies),
    cookies,
    source: authFile,
  };
}

// Тихий refresh: headless Chromium с тем же профилем, что при login-qwen.
// Если Google-сессия в профиле жива — обновляем auth.json без окна.
export async function refreshQwenAuthFromProfile(authFile = QWEN_AUTH_FILE) {
  if (!fs.existsSync(authFile)) {
    throw new Error(`Qwen auth file not found: ${authFile}`);
  }

  let profileDir = QWEN_BROWSER_PROFILE;
  try {
    const saved = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (saved?.profileDir) profileDir = saved.profileDir;
  } catch {
    // используем дефолтный профиль
  }

  const { chromium } = await import("playwright");
  const context = await launchPersistentDeepSeekContext(chromium, profileDir, true);
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(QWEN_BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2000);
    return await captureQwenAuthFromContext(context, authFile, profileDir);
  } finally {
    await context.close().catch(() => {});
  }
}

// Записать импортированные/обновлённые куки в persistent-профиль для browser-proxy.
export async function syncQwenCookiesToProfile(cookies, profileDir = QWEN_BROWSER_PROFILE) {
  const { chromium } = await import("playwright");
  const context = await launchPersistentDeepSeekContext(chromium, profileDir, true);
  try {
    await applyQwenCookiesToContext(context, cookies);
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(QWEN_BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1500);
  } finally {
    await context.close().catch(() => {});
  }
}
