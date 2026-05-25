// HTTP-клиент chat.qwen.ai.
// API: POST /api/v2/chat/completions?chat_id=<id> со стримингом SSE.
// Auth — через cookies (JWT в куке `token`).
//
// Flow:
//   1. createChat() — создаём chat_id (как DeepSeek createSession)
//   2. complete(chatId, prompt) — шлём сообщение, парсим стрим
//
// Note: реверс на основе одного cURL — некоторые поля (response shape для createChat,
// формат SSE-событий) могут потребовать корректировки после первой попытки.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QWEN_BASE_URL, QWEN_DEFAULT_MODEL } from "./config.mjs";
import { qwenBaseHeaders } from "./headers.mjs";
import { isQwenAuthError } from "./auth-manager.mjs";
import { getQwenBrowserProxy } from "./browser-proxy.mjs";

function throwIfQwenAuthFailure(status, text, context) {
  const snippet = String(text || "").slice(0, 800);
  const err = new Error(`Qwen ${context} failed: HTTP ${status}: ${snippet}`);
  if (status === 401 || status === 403 || isQwenAuthError(err)) {
    err.isAuthError = true;
  }
  throw err;
}

// Через какой путь шлём запросы:
//  - "browser" (по умолчанию) — через невидимый Playwright. Запросы автоматически
//    подписываются JS-бандлом chat.qwen.ai (bx-ua и т.д.). РАБОЧИЙ режим.
//  - "direct" — старый прямой fetch с bx-ua из .env. НЕ РАБОТАЕТ из-за anti-bot.
//    Оставлен как fallback и для отладки.
const QWEN_TRANSPORT = process.env.QWEN_TRANSPORT || "browser";

// Куда дампим исходящие запросы и сырой стрим при DEEPSEEK_DEBUG_QWEN=1.
// Юзер потом diff'ает с рабочим cURL — сразу видно, где расхождение.
const QWEN_DEBUG_DIR = path.join(os.tmpdir(), "qwen-debug");

// Дефолтная модель Qwen. Можно переопределить через .env: QWEN_MODEL=qwen3-max.
// Per-chat выбор передаётся параметром в createChat()/complete() — он приоритетней.
const ENV_DEFAULT_MODEL = process.env.QWEN_MODEL || QWEN_DEFAULT_MODEL;

export class QwenChatClient {
  constructor({ token, cookieHeader, debug = false }) {
    this.token = token;
    this.cookieHeader = cookieHeader;
    this.debug = debug;
  }

  setAuth({ token, cookieHeader }) {
    if (token) this.token = token;
    if (cookieHeader) this.cookieHeader = cookieHeader;
  }

  // Создание нового чата на сервере.
  //
  // ВАЖНО: Qwen-сервер НЕ создаёт чат сам на первом /completions, как мы думали.
  // Нужен предварительный POST /api/v2/chats/new — он возвращает server-issued
  // chat_id, который потом идёт в /completions?chat_id=...
  //
  // Поток (повторяет SPA-флоу):
  //   1. POST /chats/new {title, models, chat_mode, chat_type, timestamp_ms, project_id:""}
  //   2. Сервер возвращает { success, data: { id, title, ... } }
  //   3. Возвращаем data.id
  async createChat({ title = "Новый чат", model = ENV_DEFAULT_MODEL } = {}) {
    if (QWEN_TRANSPORT !== "browser") {
      // В direct-режиме fallback на клиентский UUID (всё равно direct не работает из-за анти-бота).
      const fallbackId = randomUUID();
      console.log(`[qwen] (direct transport) client-side chat_id: ${fallbackId}`);
      return fallbackId;
    }

    const proxy = await getQwenBrowserProxy({ debug: this.debug });
    const url = `${QWEN_BASE_URL}/api/v2/chats/new`;
    const body = JSON.stringify({
      title,
      models: [model],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(), // ВНИМАНИЕ: миллисекунды (в /completions — секунды)
      project_id: "",
    });

    // chatId: null — навигировать никуда не нужно, остаёмся на главной.
    const result = await proxy.proxyFetch({ url, body, chatId: null });
    if (!result.ok) {
      throwIfQwenAuthFailure(result.status, result.text, "createChat");
    }

    let json;
    try {
      json = JSON.parse(result.text);
    } catch {
      throw new Error(`Qwen createChat: non-JSON response: ${result.text.slice(0, 500)}`);
    }

    // Структура ответа: { success: true, data: { id: "uuid", ... } }.
    // На всякий случай проверим несколько мест где сервер мог положить id.
    const id = json?.data?.id || json?.data?.chat_id || json?.id || json?.chat_id;
    if (!id) {
      throw new Error(`Qwen createChat: no id in response: ${JSON.stringify(json).slice(0, 500)}`);
    }
    if (json.success === false) {
      throw new Error(`Qwen createChat: server returned success=false: ${JSON.stringify(json).slice(0, 500)}`);
    }

    console.log(`[qwen] server-issued chat_id: ${id}`);
    return id;
  }

  // Отправка сообщения в существующий чат. parentId — id предыдущего assistant-сообщения
  // для chain-of-context (как parent_message_id у DeepSeek).
  async complete({
    chatId,
    prompt,
    parentId = null,
    thinking = true,
    search = true,
    onText = null,
    model = ENV_DEFAULT_MODEL,
  }) {
    const fid = randomUUID();
    // childrenIds — это id будущего ассистент-сообщения. Фронт Qwen его pre-genерирует,
    // вероятно сервер ожидает что мы укажем какой именно UUID будет у ответа.
    const childId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);

    const body = {
      stream: true,
      version: "2.1",
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model,
      parent_id: parentId,
      messages: [
        {
          fid,
          parentId,
          childrenIds: [childId],
          role: "user",
          content: prompt,
          user_action: "chat",
          files: [],
          timestamp,
          models: [model],
          chat_type: "t2t",
          feature_config: {
            thinking_enabled: Boolean(thinking),
            output_schema: "phase",
            research_mode: "normal",
            auto_thinking: Boolean(thinking),
            thinking_mode: thinking ? "Auto" : "Off",
            thinking_format: "summary",
            auto_search: Boolean(search),
          },
          extra: { meta: { subChatType: "t2t" } },
          sub_chat_type: "t2t",
          parent_id: parentId,
        },
      ],
      timestamp,
    };

    const headers = {
      ...qwenBaseHeaders(this.cookieHeader),
      Referer: `${QWEN_BASE_URL}/c/${chatId}`,
    };

    const url = `${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`;
    const bodyStr = JSON.stringify(body);

    if (this.debug) {
      console.log(
        `[qwen] POST (transport=${QWEN_TRANSPORT}) /completions?chat_id=${chatId} thinking=${thinking} search=${search}`,
      );
      try {
        fs.mkdirSync(QWEN_DEBUG_DIR, { recursive: true });
        const dump = { url, method: "POST", transport: QWEN_TRANSPORT, headers, body };
        fs.writeFileSync(
          path.join(QWEN_DEBUG_DIR, "last-request.json"),
          JSON.stringify(dump, null, 2),
        );
        console.log(`[qwen] dumped request → ${path.join(QWEN_DEBUG_DIR, "last-request.json")}`);
      } catch (e) {
        console.error(`[qwen] failed to dump request: ${e.message}`);
      }
    }

    // ОСНОВНОЙ ПУТЬ: запрос через невидимый Playwright (browser-proxy).
    // Бандл chat.qwen.ai сам подписывает запрос свежим bx-ua.
    if (QWEN_TRANSPORT === "browser") {
      const proxy = await getQwenBrowserProxy({ debug: this.debug });
      const result = await proxy.proxyFetch({ url, body: bodyStr, chatId });

      if (this.debug) {
        try {
          fs.mkdirSync(QWEN_DEBUG_DIR, { recursive: true });
          fs.writeFileSync(
            path.join(QWEN_DEBUG_DIR, "last-response.txt"),
            `# transport=browser, status=${result.status}, content-type=${result.contentType}, bytes=${result.text?.length || 0}\n\n${result.text || ""}`,
          );
          console.log(`[qwen] dumped response → ${path.join(QWEN_DEBUG_DIR, "last-response.txt")}`);
        } catch {}
      }

      if (!result.ok) {
        throwIfQwenAuthFailure(result.status, result.text, "completion (browser)");
      }

      return parseQwenResponseText(result.text, result.contentType, onText);
    }

    // FALLBACK: прямой fetch с bx-ua из .env (обычно ломается на Bad_Request).
    const res = await fetch(url, { method: "POST", headers, body: bodyStr });

    if (!res.ok) {
      const text = await res.text();
      throwIfQwenAuthFailure(res.status, text, "completion");
    }

    const contentType = String(res.headers.get("content-type") || "");
    console.log(`[qwen] response content-type: ${contentType}`);

    if (contentType.includes("application/json")) {
      const text = await res.text();
      console.log(`[qwen] non-SSE response body (first 1000 chars):\n${text.slice(0, 1000)}`);
      let json;
      try { json = JSON.parse(text); } catch {
        return { text: `⚠️ Qwen вернул не-JSON и не-SSE. Тело:\n\n${text.slice(0, 800)}`, lastMessageId: null, thinkingText: "" };
      }
      const found = extractTextRecursively(json);
      if (found.text) {
        return { text: found.text, lastMessageId: found.messageId, thinkingText: found.isThinking ? found.text : "" };
      }
      return {
        text: `⚠️ Qwen вернул JSON, но текста в нём нет. Тело:\n\n${JSON.stringify(json, null, 2).slice(0, 1200)}\n\nПрисылай мне это сообщение.`,
        lastMessageId: null,
        thinkingText: "",
      };
    }

    return await parseQwenStream(res, onText, this.debug);
  }
}

// Парсит полный текст ответа (от browser-proxy — он отдаёт весь body одним куском).
// Поддерживает оба варианта: одиночный JSON и SSE-стрим из много "data: {...}" блоков.
// Если передан onText callback, вызывает его для каждого найденного текстового кусочка.
function parseQwenResponseText(text, contentType, onText) {
  const ct = String(contentType || "").toLowerCase();

  // Одиночный JSON-ответ (обычно — ошибка или non-streaming endpoint).
  if (ct.includes("application/json") || text.trim().startsWith("{")) {
    try {
      const json = JSON.parse(text);
      const found = extractTextRecursively(json);
      if (found.text) {
        return { text: found.text, lastMessageId: found.messageId, thinkingText: found.isThinking ? found.text : "" };
      }
      return {
        text: `⚠️ Qwen вернул JSON, но текста в нём нет:\n\n${JSON.stringify(json, null, 2).slice(0, 1200)}`,
        lastMessageId: null,
        thinkingText: "",
      };
    } catch {
      // не JSON — падаем дальше на SSE-парсинг
    }
  }

  // SSE: разделяем по \n\n, парсим каждое событие.
  const events = text.split(/\r?\n\r?\n/).filter(Boolean);
  let fullText = "";
  let thinkingBuf = "";
  let lastMessageId = null;

  for (const raw of events) {
    const ev = parseSseEvent(raw);
    if (!ev.data || ev.data === "[DONE]") continue;
    let parsed;
    try { parsed = JSON.parse(ev.data); } catch { continue; }
    const found = extractTextRecursively(parsed);
    if (found.text) {
      if (found.isThinking) {
        thinkingBuf += found.text;
      } else {
        fullText += found.text;
        onText?.(found.text);
      }
    }
    if (found.messageId) lastMessageId = String(found.messageId);
  }

  if (!fullText && !thinkingBuf) {
    return {
      text:
        `⚠️ Qwen ответил (${text.length} байт), но парсер ничего не извлёк.\n\n` +
        `Сырой ответ (первые 1500 символов):\n\n${text.slice(0, 1500)}`,
      lastMessageId,
      thinkingText: "",
    };
  }
  return { text: fullText, lastMessageId, thinkingText: thinkingBuf };
}

// Парсер SSE-стрима Qwen.
// Формат у них точно не реверсили — ищем text/content рекурсивно по всему объекту.
// При DEEPSEEK_DEBUG_QWEN=1 печатаем КАЖДОЕ событие целиком для отладки.
async function parseQwenStream(res, onText, debug) {
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  let rawAccumulated = ""; // полный сырой стрим — для диагностики
  let fullText = "";
  let lastMessageId = null;
  let thinkingBuf = "";
  let eventCount = 0;
  let firstFewRaw = []; // первые 3 события сохраняем целиком для диагностики

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;
    rawAccumulated += chunk;

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const event = parseSseEvent(rawEvent);
      if (!event.data) continue;
      if (event.data === "[DONE]") {
        if (debug) console.error(`[qwen-sse] got [DONE] after ${eventCount} events, text="${fullText.slice(0,200)}"`);
        return { text: fullText, lastMessageId, thinkingText: thinkingBuf };
      }

      eventCount += 1;

      let parsed;
      try { parsed = JSON.parse(event.data); } catch {
        if (debug) console.error("[qwen-sse] non-JSON event:", event.data.slice(0, 300));
        continue;
      }

      // Сохраняем первые 3 события целиком — даже без debug. Если в конце текст пустой,
      // печатаем эти примеры в throw-сообщение или console чтобы было видно формат.
      if (firstFewRaw.length < 3) firstFewRaw.push(event.data);

      if (debug) console.error("[qwen-sse]", JSON.stringify(parsed));

      // ЖАДНЫЙ extract: рекурсивно ходим по объекту и собираем все строки из
      // полей, похожих на content/text/delta. Это работает, даже если формат
      // отличается от наших предположений (OpenAI-style choices[0].delta.content).
      const found = extractTextRecursively(parsed);
      if (found.text) {
        if (found.isThinking) {
          thinkingBuf += found.text;
        } else {
          fullText += found.text;
          onText?.(found.text);
        }
      }
      if (found.messageId) lastMessageId = String(found.messageId);
    }
  }

  // При debug — всегда дампим полный сырой стрим в файл, независимо от того,
  // распарсилось что-то или нет. Это даёт сравнение с тем, что приходит на фронт Qwen.
  if (debug) {
    try {
      fs.mkdirSync(QWEN_DEBUG_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(QWEN_DEBUG_DIR, "last-response.txt"),
        `# events=${eventCount}, bytes=${rawAccumulated.length}, extracted=${fullText.length}\n\n${rawAccumulated}`,
      );
      console.log(`[qwen] dumped response → ${path.join(QWEN_DEBUG_DIR, "last-response.txt")}`);
    } catch (e) {
      console.error(`[qwen] failed to dump response: ${e.message}`);
    }
  }

  // Если ничего не извлекли — печатаем СЫРОЙ стрим в чат целиком (первые 1500 символов).
  // Это всегда даёт юзеру что-то полезное, по чему я смогу починить парсер.
  if (!fullText && !thinkingBuf) {
    console.error(`[qwen-sse] no text extracted. Raw stream (${rawAccumulated.length} chars):\n${rawAccumulated.slice(0, 2000)}`);
    return {
      text:
        `⚠️ Qwen ответил, но парсер ничего не извлёк (events: ${eventCount}, raw bytes: ${rawAccumulated.length}).\n\n` +
        `Сырой стрим (первые 1500 символов):\n\n${rawAccumulated.slice(0, 1500)}\n\n` +
        `Присылай мне это сообщение целиком — поправлю парсер.`,
      lastMessageId,
      thinkingText: "",
    };
  }

  return { text: fullText, lastMessageId, thinkingText: thinkingBuf };
}

// Рекурсивно ищет в объекте поля content / text / delta и собирает строки.
// Возвращает первое найденное (Qwen обычно посылает по одному chunk за event).
// Различает thinking (поле phase === "think" / type === "think") и обычный ответ.
function extractTextRecursively(node, isThinking = false) {
  let text = "";
  let messageId = null;
  let foundThinking = isThinking;

  if (!node || typeof node !== "object") return { text, messageId, isThinking: foundThinking };

  // Проверка thinking phase в текущем узле.
  if (node.phase === "think" || node.phase === "thinking" || node.type === "think") {
    foundThinking = true;
  }

  // Прямые поля с текстом.
  if (typeof node.content === "string") text += node.content;
  if (typeof node.text === "string") text += node.text;
  if (typeof node.delta === "string") text += node.delta;
  if (typeof node.delta_content === "string") text += node.delta_content;

  // ID сообщения.
  if (typeof node.response_id === "string" || typeof node.response_id === "number") messageId = node.response_id;
  if (typeof node.message_id === "string" || typeof node.message_id === "number") messageId = node.message_id;
  if (typeof node.id === "string" && (node.role === "assistant" || node.role === "ai")) messageId = node.id;

  // Рекурсия в массивы.
  if (Array.isArray(node)) {
    for (const item of node) {
      const sub = extractTextRecursively(item, foundThinking);
      text += sub.text;
      if (sub.messageId) messageId = sub.messageId;
      if (sub.isThinking) foundThinking = sub.isThinking;
    }
    return { text, messageId, isThinking: foundThinking };
  }

  // Рекурсия в объект. ВАЖНО: не пропускаем delta/content — они могут быть
  // объектами (например, OpenAI-формат Qwen: choices[0].delta — это объект
  // с полями {role, content, phase, status}, и текст внутри content).
  // Пропускаем только метаданные (phase/type) — они не контейнеры с текстом.
  for (const [key, value] of Object.entries(node)) {
    if (["phase", "type"].includes(key)) continue;
    if (typeof value !== "object" || value === null) continue;
    const sub = extractTextRecursively(value, foundThinking);
    text += sub.text;
    if (sub.messageId) messageId = sub.messageId;
    if (sub.isThinking) foundThinking = sub.isThinking;
  }

  return { text, messageId, isThinking: foundThinking };
}

function parseSseEvent(raw) {
  const event = { event: "", data: "" };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event.event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      event.data += (event.data ? "\n" : "") + line.slice(5).trimStart();
    }
  }
  return event;
}
