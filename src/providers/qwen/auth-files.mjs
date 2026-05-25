// IO для Qwen-auth.json. Структура аналогична deepseek/auth/files.mjs,
// но с другим набором полей под их API.
//
// Хранимое:
// {
//   "version": 1,
//   "savedAt": ISO timestamp,
//   "baseUrl": "https://chat.qwen.ai",
//   "profileDir": "/Users/.../qwen-browser-profile",
//   "token": "eyJ...",         ← JWT из куки `token` или localStorage
//   "userId": "5be644f7-...",  ← cnaui (опционально)
//   "cookies": [               ← массив cookies в Playwright-формате
//     { name, value, domain, path, httpOnly, secure, ... },
//     ...
//   ]
// }

import fs from "node:fs";
import path from "node:path";
import { QWEN_BASE_URL } from "./config.mjs";

export function readQwenAuth(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
    return {
      token: raw.token || "",
      userId: raw.userId || "",
      cookieHeader: qwenCookieHeaderFromArray(cookies),
      cookies,
      source: file,
    };
  } catch {
    return null;
  }
}

export function writeQwenAuth(file, { cookies, token, userId, profileDir }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    baseUrl: QWEN_BASE_URL,
    profileDir,
    token,
    userId,
    cookies,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

// Cookie-заголовок из массива Playwright-cookies. Включает ВСЕ куки,
// которые относятся к qwen.ai (включая антибот-токены типа tfstk, isg, acw_tc и т.п.).
// Иначе их антибот-движок может отрезать запросы.
export function qwenCookieHeaderFromArray(parsed) {
  if (!Array.isArray(parsed)) {
    throw new Error("Qwen cookie data must be an array from Playwright context.cookies().");
  }
  const usable = parsed.filter((cookie) => cookie?.name && "value" in cookie);
  return usable.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

// Playwright addCookies() ожидает объекты с domain/path. Нормализуем сохранённые куки.
export function playwrightCookiesFromSaved(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies
    .filter((c) => c?.name && "value" in c)
    .map((c) => {
      const entry = {
        name: String(c.name),
        value: String(c.value),
        domain: String(c.domain || ".qwen.ai"),
        path: String(c.path || "/"),
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: c.sameSite || "Lax",
      };
      if (typeof c.expires === "number" && c.expires > 0) {
        entry.expires = c.expires;
      }
      return entry;
    });
}

// Подмешать куки из auth.json в Chromium-контекст (browser-proxy / refresh).
// Без этого import-qwen и рассинхрон профиля с auth.json ломают «авто»-вход.
export async function applyQwenCookiesToContext(context, cookies) {
  const normalized = playwrightCookiesFromSaved(cookies);
  if (!normalized.length) return 0;
  await context.addCookies(normalized);
  return normalized.length;
}
