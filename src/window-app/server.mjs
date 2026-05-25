// HTTP-сервер окна чатов на 127.0.0.1:port. Биндится только на loopback —
// снаружи недоступен. Реализует все REST-эндпойнты, которые рисует фронт.
// На SIGINT/SIGTERM/SIGHUP — graceful shutdown, фронт замечает через heartbeat и закрывается.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { openAppWindow } from "../browser/launch.mjs";
import { runCodeTask } from "../code-agent/run.mjs";
import { COMMAND_CATALOG, loadSettings, saveSettings } from "../state/settings.mjs";
import { conversationList, makeConversationTitle, shouldAutoTitle } from "../state/conversations.mjs";
import { startTask, isRunning, getRunningIds } from "./task-runner.mjs";
import { getStateFile, loadWindowState, saveWindowState } from "../state/window-state.mjs";
import { readJsonBody, sendHtml, sendJson } from "./http.mjs";
import { renderWindowHtml } from "./ui-html.mjs";

export async function runWindowApp({ client, workspaceRoot, port, modelType, thinkingEnabled, searchEnabled }) {
  const state = loadWindowState(workspaceRoot);

  // Lazy init Qwen-клиента + авто-relogin (как DeepSeek AuthManager).
  let qwenClient = null;
  let qwenAuthManager = null;

  async function getQwenAuthManager() {
    if (!qwenAuthManager) {
      const { getQwenAuthManager: factory } = await import("../providers/qwen/auth-manager.mjs");
      qwenAuthManager = factory({ autoVisible: true });
    }
    return qwenAuthManager;
  }

  async function buildQwenClientFromAuth(auth) {
    const { QwenChatClient } = await import("../providers/qwen/client.mjs");
    return new QwenChatClient({
      token: auth.token,
      cookieHeader: auth.cookieHeader,
      debug: Boolean(process.env.DEEPSEEK_DEBUG_QWEN),
    });
  }

  // Гарантирует валидный auth: тихий refresh из профиля → окно логина.
  async function ensureQwenAuth({ forceVisible = false } = {}) {
    const { QWEN_AUTH_FILE } = await import("../providers/qwen/config.mjs");
    const { readQwenAuth } = await import("../providers/qwen/auth-files.mjs");
    const existing = readQwenAuth(QWEN_AUTH_FILE);
    if (existing?.token && !forceVisible) {
      return existing;
    }
    const manager = await getQwenAuthManager();
    return manager.refresh({ forceVisible: forceVisible || !existing?.token });
  }

  async function getOrCreateQwenClient({ forceRebuild = false } = {}) {
    if (qwenClient && !forceRebuild) return qwenClient;
    const auth = await ensureQwenAuth();
    qwenClient = await buildQwenClientFromAuth(auth);
    return qwenClient;
  }

  // Вызов Qwen API с авто-refresh сессии при auth-ошибке (до 2 попыток).
  async function qwenApiCall(fn) {
    const { isQwenAuthError } = await import("../providers/qwen/auth-manager.mjs");
    let client = await getOrCreateQwenClient();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await fn(client);
      } catch (error) {
        if (!isQwenAuthError(error) || attempt >= 1) throw error;
        console.log("[qwen] auth error, refreshing session…");
        const manager = await getQwenAuthManager();
        const fresh = await manager.refresh({ forceVisible: attempt > 0 });
        client = await buildQwenClientFromAuth(fresh);
        qwenClient = client;
      }
    }
    throw new Error("unreachable: qwenApiCall retry budget");
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/") {
        return sendHtml(res, renderWindowHtml());
      }

      // Lifeline для фронта. Если этот endpoint не отвечает 3 раза подряд → окно закрывается.
      if (req.method === "GET" && url.pathname === "/api/heartbeat") {
        return sendJson(res, { ok: true, ts: Date.now() });
      }

      // Список провайдеров + статус auth. UI рисует picker по этому ответу.
      if (req.method === "GET" && url.pathname === "/api/providers") {
        const { listProviders } = await import("../providers/registry.mjs");
        const providers = listProviders().map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          hasAuth: p.hasAuth(),
        }));
        return sendJson(res, { providers });
      }

      // Подключить провайдера из UI (открывает окно логина в фоне).
      const providerLoginMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/login$/);
      if (req.method === "POST" && providerLoginMatch) {
        const providerId = providerLoginMatch[1];
        const { getProvider } = await import("../providers/registry.mjs");
        const provider = getProvider(providerId);
        if (!provider) {
          return sendJson(res, { error: `Unknown provider: ${providerId}` }, 404);
        }
        try {
          await provider.login();
          if (providerId === "qwen") {
            const { resetQwenBrowserProxy } = await import("../providers/qwen/browser-proxy.mjs");
            resetQwenBrowserProxy();
            qwenClient = null;
          }
          return sendJson(res, { ok: true, hasAuth: provider.hasAuth() });
        } catch (error) {
          return sendJson(res, { error: error.message }, 500);
        }
      }

      // Загрузка файла (картинки) на DeepSeek через наш прокси.
      // Фронт шлёт base64 (картинки бывают мегабайты — лимит 30 МБ).
      // Возвращаем file_id, который потом юзается в ref_file_ids массиве completion.
      if (req.method === "POST" && url.pathname === "/api/upload") {
        const body = await readJsonBody(req, 30_000_000);
        if (!body.dataBase64 || !body.name) {
          return sendJson(res, { error: "Поля name + dataBase64 обязательны." }, 400);
        }
        try {
          const buffer = Buffer.from(body.dataBase64, "base64");
          const fileId = await client.uploadFile(
            buffer,
            String(body.mimeType || "application/octet-stream"),
            String(body.name),
          );
          console.log(`[upload] ${body.name} (${buffer.length}b) -> file_id=${fileId}`);
          return sendJson(res, { fileId });
        } catch (error) {
          console.error(`[upload] FAILED for ${body.name}: ${error.message}`);
          return sendJson(res, { error: error.message }, 500);
        }
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        return sendJson(res, {
          workspaceRoot,
          stateFile: getStateFile(),
          activeConversationId: state.activeConversationId,
          conversations: conversationList(state),
          runningTaskIds: getRunningIds(),
        });
      }

      // ===== Файловый браузер для модалки «Новый чат» =====

      if (req.method === "POST" && url.pathname === "/api/browse/mkdir") {
        const body = await readJsonBody(req);
        const parentRaw = String(body.parent || "").trim();
        const name = String(body.name || "").trim();
        if (!parentRaw) return sendJson(res, { error: "parent обязателен" }, 400);
        if (!name) return sendJson(res, { error: "Имя папки не может быть пустым." }, 400);
        if (name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.startsWith("..")) {
          return sendJson(res, { error: "Имя не может содержать /, \\, или быть '.', '..'." }, 400);
        }
        const parent = path.resolve(parentRaw);
        const target = path.join(parent, name);
        const safeRoots = [os.homedir(), path.resolve(workspaceRoot), path.join(os.homedir(), "Documents")];
        const isUnderSafe = safeRoots.some((r) => target === r || target.startsWith(r + path.sep));
        if (!isUnderSafe) {
          return sendJson(res, { error: `Создание разрешено только под ${os.homedir()}/.` }, 400);
        }
        if (fs.existsSync(target)) {
          return sendJson(res, { error: `Папка уже существует: ${target}` }, 409);
        }
        try {
          fs.mkdirSync(target, { recursive: false });
        } catch (error) {
          return sendJson(res, { error: `Не удалось создать: ${error.message}` }, 500);
        }
        return sendJson(res, { path: target });
      }

      if (req.method === "GET" && url.pathname === "/api/browse") {
        const requested = url.searchParams.get("path");
        const showHidden = url.searchParams.get("hidden") === "1";
        let target;
        try {
          let p = (requested || os.homedir()).trim();
          if (p.startsWith("~/") || p === "~") p = path.join(os.homedir(), p.slice(1));
          target = path.resolve(p);
        } catch {
          return sendJson(res, { error: "Невалидный путь" }, 400);
        }
        if (!fs.existsSync(target)) {
          return sendJson(res, { error: `Папка не существует: ${target}` }, 404);
        }
        if (!fs.statSync(target).isDirectory()) {
          return sendJson(res, { error: `Не папка: ${target}` }, 400);
        }
        let raw;
        try {
          raw = fs.readdirSync(target, { withFileTypes: true });
        } catch (error) {
          return sendJson(res, { error: `Не могу прочитать папку: ${error.message}` }, 403);
        }
        const folders = raw
          .filter((entry) => {
            try { return entry.isDirectory(); } catch { return false; }
          })
          .filter((entry) => (showHidden ? true : !entry.name.startsWith(".")))
          .map((entry) => ({
            name: entry.name,
            path: path.join(target, entry.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
          .slice(0, 500);
        const parent = path.dirname(target);
        return sendJson(res, {
          path: target,
          parent: parent !== target ? parent : null,
          entries: folders,
          home: os.homedir(),
          truncated: raw.filter((e) => { try { return e.isDirectory(); } catch { return false; } }).length > 500,
        });
      }

      // ===== Проекты (workspace'ы из чатов) =====

      if (req.method === "GET" && url.pathname === "/api/projects") {
        const seen = new Set();
        const projects = [];
        for (const c of state.conversations) {
          const w = String(c.workspace || workspaceRoot);
          if (seen.has(w)) continue;
          seen.add(w);
          projects.push({
            path: w,
            name: path.basename(w) || w,
            exists: fs.existsSync(w),
          });
        }
        if (!seen.has(workspaceRoot)) {
          projects.unshift({
            path: workspaceRoot,
            name: path.basename(workspaceRoot) || workspaceRoot,
            exists: fs.existsSync(workspaceRoot),
            isDefault: true,
          });
        }
        return sendJson(res, { projects, defaultWorkspace: workspaceRoot, home: os.homedir() });
      }

      // ===== Settings (whitelist команд для /code) =====

      if (req.method === "GET" && url.pathname === "/api/settings") {
        const current = loadSettings();
        const catalog = Object.entries(COMMAND_CATALOG).map(([name, meta]) => ({
          name,
          description: meta.description,
          risk: meta.risk,
        }));
        return sendJson(res, {
          allowedCommands: current.allowedCommands,
          catalog,
        });
      }

      if (req.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readJsonBody(req);
        const saved = saveSettings({ allowedCommands: body.allowedCommands });
        return sendJson(res, { allowedCommands: saved.allowedCommands });
      }

      // ===== Conversations =====

      if (req.method === "POST" && url.pathname === "/api/conversations") {
        const body = await readJsonBody(req);

        let workspace = String(body.workspace || workspaceRoot).trim() || workspaceRoot;
        if (workspace.startsWith("~/") || workspace === "~") {
          workspace = path.join(os.homedir(), workspace.slice(1));
        }
        workspace = path.resolve(workspace);

        const exists = fs.existsSync(workspace);
        if (!exists) {
          if (!body.createFolder) {
            return sendJson(
              res,
              { error: `Папка не существует: ${workspace}. Поставь галочку «Создать папку», если хочешь чтобы я её создал.` },
              400,
            );
          }
          const safeRoots = [os.homedir(), path.resolve(workspaceRoot), path.join(os.homedir(), "Documents")];
          const isUnderSafe = safeRoots.some((root) => workspace === root || workspace.startsWith(root + path.sep));
          if (!isUnderSafe) {
            return sendJson(
              res,
              { error: `Создание новой папки разрешено только под ${os.homedir()}/. Укажи путь в твоей домашней директории.` },
              400,
            );
          }
          try {
            fs.mkdirSync(workspace, { recursive: true });
          } catch (error) {
            return sendJson(res, { error: `Не удалось создать папку: ${error.message}` }, 500);
          }
        } else if (!fs.statSync(workspace).isDirectory()) {
          return sendJson(res, { error: `Путь существует, но это не папка: ${workspace}` }, 400);
        }

        // Сессию DeepSeek создаём только для DeepSeek-чатов. У Qwen своя модель чатов,
        // там нет понятия "сессии перед сообщением" в том же виде.
        const _provider = String(body.provider || "deepseek");
        const sessionId = _provider === "deepseek" ? await client.createSession() : null;
        const now = new Date().toISOString();
        const rawTitle = String(body.title || "").trim();
        // Провайдер и режим фиксируются при создании чата.
        const allowedProviders = new Set(["deepseek", "qwen"]);
        const provider = allowedProviders.has(String(body.provider)) ? String(body.provider) : "deepseek";
        // Допустимые режимы per-provider. Если режим не из набора — fallback на дефолт провайдера.
        const PROVIDER_MODES = {
          deepseek: { allowed: ["fast", "expert", "vision"], default: "fast" },
          qwen: { allowed: ["default"], default: "default" },
        };
        const modeCfg = PROVIDER_MODES[provider];
        const mode = modeCfg.allowed.includes(String(body.mode)) ? String(body.mode) : modeCfg.default;
        const conversation = {
          id: randomUUID(),
          sessionId,
          provider,
          title: rawTitle || "New chat",
          autoTitle: !rawTitle,
          workspace,
          mode,
          parentMessageId: null,
          // Отдельный chain для /code, чтобы Coding Agent system-prompt не загрязнял обычный чат.
          codeParentMessageId: null,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        state.conversations.unshift(conversation);
        state.activeConversationId = conversation.id;
        saveWindowState(workspaceRoot, state);
        return sendJson(res, { conversation });
      }

      const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (req.method === "GET" && conversationMatch) {
        const conversation = state.conversations.find((item) => item.id === conversationMatch[1]);
        if (!conversation) return sendJson(res, { error: "Conversation not found" }, 404);
        state.activeConversationId = conversation.id;
        saveWindowState(workspaceRoot, state);
        return sendJson(res, { conversation, running: isRunning(conversation.id) });
      }

      // Обновление настроек чата: модель (для Qwen) и coderMode toggle.
      // Тело: { model?: string, coderMode?: boolean }
      if (req.method === "PATCH" && conversationMatch) {
        const id = conversationMatch[1];
        const conversation = state.conversations.find((item) => item.id === id);
        if (!conversation) return sendJson(res, { error: "Conversation not found" }, 404);
        const body = await readJsonBody(req);
        if (typeof body.model === "string" && body.model.length > 0) {
          conversation.model = body.model;
        }
        if (typeof body.coderMode === "boolean") {
          conversation.coderMode = body.coderMode;
        }
        conversation.updatedAt = new Date().toISOString();
        saveWindowState(workspaceRoot, state);
        return sendJson(res, { conversation });
      }

      if (req.method === "DELETE" && conversationMatch) {
        const id = conversationMatch[1];
        const beforeCount = state.conversations.length;
        state.conversations = state.conversations.filter((item) => item.id !== id);
        if (state.conversations.length === beforeCount) {
          return sendJson(res, { error: "Conversation not found" }, 404);
        }
        if (state.activeConversationId === id) {
          state.activeConversationId = state.conversations[0]?.id || null;
        }
        saveWindowState(workspaceRoot, state);
        return sendJson(res, {
          activeConversationId: state.activeConversationId,
          conversations: conversationList(state),
        });
      }

      const messageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (req.method === "POST" && messageMatch) {
        const body = await readJsonBody(req);
        const conversation = state.conversations.find((item) => item.id === messageMatch[1]);
        if (!conversation) return sendJson(res, { error: "Conversation not found" }, 404);

        const prompt = String(body.content || "").trim();
        if (!prompt) return sendJson(res, { error: "Message is empty" }, 400);

        // Маршрутизация по провайдеру.
        const convProvider = conversation.provider || "deepseek";
        if (convProvider === "qwen") {
          // Пушим user-сообщение СРАЗУ, до запроса к Qwen, чтобы оно отображалось
          // в UI пока ждём ответ (4-5 сек). Иначе пользовательское сообщение
          // «исчезает» с экрана до момента, как придёт ответ.
          conversation.messages.push({
            role: "user",
            content: prompt,
            createdAt: new Date().toISOString(),
          });
          conversation.updatedAt = new Date().toISOString();
          saveWindowState(workspaceRoot, state);

          // Lazy-init Qwen-клиента — создаём один раз за life сервера.
          try {
            let qwenClient = await getOrCreateQwenClient();
            // Lazy createChat: на первом сообщении. Модель — из чата.
            if (!conversation.sessionId) {
              conversation.sessionId = await qwenApiCall((c) =>
                c.createChat({ model: conversation.model || undefined }),
              );
              saveWindowState(workspaceRoot, state);
              qwenClient = await getOrCreateQwenClient();
            }

            // /code-режим или Coder-mode (per-chat toggle) → запускаем code-agent.
            // ASYNC: задача идёт в фоне через task-runner. Возвращаем conversation
            // сразу с running:true, UI делает polling до завершения.
            const slashCode = prompt === "/code" || prompt.startsWith("/code ");
            const coderMode = conversation.coderMode === true;
            if (slashCode || coderMode) {
              const task = slashCode ? prompt.slice(5).trim() : prompt;
              if (!task) {
                conversation.messages.push({
                  role: "assistant",
                  content: "Напиши задачу после /code. Например: /code создай файл notes.txt с текстом hello",
                  createdAt: new Date().toISOString(),
                });
                conversation.updatedAt = new Date().toISOString();
                saveWindowState(workspaceRoot, state);
                return sendJson(res, { conversation });
              }

              if (isRunning(conversation.id)) {
                conversation.messages.push({
                  role: "assistant",
                  content: "⏳ В этом чате уже выполняется задача. Подожди завершения.",
                  createdAt: new Date().toISOString(),
                });
                conversation.updatedAt = new Date().toISOString();
                saveWindowState(workspaceRoot, state);
                return sendJson(res, { conversation, running: true });
              }

              const { createQwenAgentAdapter } = await import("../providers/qwen/agent-adapter.mjs");
              const adapter = createQwenAgentAdapter(qwenClient);
              const workspacePath = path.resolve(conversation.workspace || workspaceRoot);
              const baseOptions = {
                sessionId: conversation.sessionId,
                thinkingEnabled: body.thinking === true,
                searchEnabled: false,
              };
              const parentId = conversation.codeParentMessageId || null;

              startTask(conversation.id, "code", async () => {
                try {
                  const codeResult = await runCodeTask(adapter, baseOptions, workspacePath, task, parentId);
                  conversation.codeParentMessageId = codeResult.parentMessageId ?? conversation.codeParentMessageId;
                  const toolText = codeResult.toolLogs.length ? `${codeResult.toolLogs.join("\n")}\n\n` : "";
                  conversation.messages.push({
                    role: "assistant",
                    content: `${toolText}${codeResult.message}`.trimEnd(),
                    createdAt: new Date().toISOString(),
                  });
                } catch (err) {
                  conversation.messages.push({
                    role: "assistant",
                    content: `⚠️ /code error: ${err.message}`,
                    createdAt: new Date().toISOString(),
                  });
                }
                conversation.updatedAt = new Date().toISOString();
                saveWindowState(workspaceRoot, state);
              }, "Qwen /code");

              return sendJson(res, { conversation, running: true });
            }

            const result = await qwenApiCall((c) =>
              c.complete({
                chatId: conversation.sessionId,
                prompt,
                parentId: conversation.parentMessageId,
                thinking: body.thinking === true,
                search: body.search === true,
                model: conversation.model || undefined,
              }),
            );
            conversation.parentMessageId = result.lastMessageId ?? conversation.parentMessageId;
            const finalText = result.thinkingText
              ? `🧠 ${result.thinkingText.trim()}\n\n---\n\n${result.text.trim()}`
              : result.text.trim();
            conversation.messages.push({
              role: "assistant",
              content: finalText || "[empty]",
              createdAt: new Date().toISOString(),
            });
            conversation.updatedAt = new Date().toISOString();
            saveWindowState(workspaceRoot, state);
          } catch (error) {
            conversation.messages.push({
              role: "assistant",
              content: `⚠️ Qwen error: ${error.message}`,
              createdAt: new Date().toISOString(),
            });
            conversation.updatedAt = new Date().toISOString();
            saveWindowState(workspaceRoot, state);
          }
          return sendJson(res, { conversation });
        }
        if (convProvider !== "deepseek") {
          conversation.messages.push({
            role: "assistant",
            content: `⚠️ Провайдер "${convProvider}" не поддерживается этим CLI.`,
            createdAt: new Date().toISOString(),
          });
          conversation.updatedAt = new Date().toISOString();
          saveWindowState(workspaceRoot, state);
          return sendJson(res, { conversation });
        }

        // Режим берём ИЗ ЧАТА (зафиксирован при создании). Переключить нельзя —
        // DeepSeek завязывает parent_message_id chain на одну модель.
        // Тумблеры (thinking/search) — можно переключать per-message.
        const messageMode = String(conversation.mode || "fast");
        // thinking: в Expert по умолчанию true, юзер может перебить тумблером в обе стороны.
        // search: чистый юзер-флаг, без переопределения от режима.
        const useThinking = effectiveThinkingForMode(messageMode, body.thinking, thinkingEnabled);
        const useSearch = body.search === true || (body.search !== false && searchEnabled);
        const effectiveModelType = mapModeToModelType(messageMode, modelType);
        // file_id'ы загруженных картинок для vision-режима. Фронт сначала зальёт
        // файлы через /api/upload, потом шлёт их id здесь.
        const refFileIds = Array.isArray(body.refFileIds)
          ? body.refFileIds.filter((id) => typeof id === "string" && id.length > 0)
          : [];

        const now = new Date().toISOString();
        const isFirstUserMessage = !conversation.messages.some((message) => message.role === "user");
        if (isFirstUserMessage && shouldAutoTitle(conversation)) {
          conversation.title = makeConversationTitle(prompt);
        }
        conversation.messages.push({ role: "user", content: prompt, createdAt: now });
        conversation.updatedAt = now;
        state.activeConversationId = conversation.id;
        saveWindowState(workspaceRoot, state);

        const dsSlashCode = prompt === "/code" || prompt.startsWith("/code ");
        const dsCoderMode = conversation.coderMode === true;
        if (dsSlashCode || dsCoderMode) {
          const task = dsSlashCode ? prompt.slice(5).trim() : prompt;
          if (!task) {
            conversation.messages.push({
              role: "assistant",
              content: "Напиши задачу после /code. Например: /code создай файл notes.txt с текстом hello",
              createdAt: new Date().toISOString(),
            });
            conversation.updatedAt = new Date().toISOString();
            saveWindowState(workspaceRoot, state);
            return sendJson(res, { conversation });
          }

          if (isRunning(conversation.id)) {
            conversation.messages.push({
              role: "assistant",
              content: "⏳ В этом чате уже выполняется задача. Подожди завершения.",
              createdAt: new Date().toISOString(),
            });
            conversation.updatedAt = new Date().toISOString();
            saveWindowState(workspaceRoot, state);
            return sendJson(res, { conversation, running: true });
          }

          // КРИТИЧНО: /code держит СВОЙ parent_message_id chain, отдельный от обычного чата.
          // Иначе system-prompt «You are a coding agent, no internet» цепляется к обычным
          // сообщениям, и модель отказывается отвечать на вопросы про реальный мир.
          //
          // ASYNC: запускаем через task-runner, чтобы UI не блокировался и можно было
          // параллельно запустить /code в других чатах. Возвращаем conversation сразу,
          // фронт делает polling /api/state до завершения.
          const workspacePath = path.resolve(conversation.workspace || workspaceRoot);
          const baseOptions = {
            sessionId: conversation.sessionId,
            modelType: effectiveModelType,
            thinkingEnabled: useThinking,
            searchEnabled: useSearch,
          };
          const parentId = conversation.codeParentMessageId || null;

          startTask(conversation.id, "code", async () => {
            try {
              const codeResult = await runCodeTask(client, baseOptions, workspacePath, task, parentId);
              conversation.codeParentMessageId = codeResult.parentMessageId ?? conversation.codeParentMessageId;
              const toolText = codeResult.toolLogs.length ? `${codeResult.toolLogs.join("\n")}\n\n` : "";
              conversation.messages.push({
                role: "assistant",
                content: `${toolText}${codeResult.message}`.trimEnd(),
                createdAt: new Date().toISOString(),
              });
            } catch (err) {
              conversation.messages.push({
                role: "assistant",
                content: `⚠️ /code error: ${err.message}`,
                createdAt: new Date().toISOString(),
              });
            }
            conversation.updatedAt = new Date().toISOString();
            saveWindowState(workspaceRoot, state);
          }, "DeepSeek /code");

          return sendJson(res, { conversation, running: true });
        }

        const result = await client.complete({
          sessionId: conversation.sessionId,
          prompt,
          parentMessageId: conversation.parentMessageId,
          modelType: effectiveModelType,
          thinkingEnabled: useThinking,
          searchEnabled: useSearch,
          refFileIds,
        });

        conversation.parentMessageId = result.lastAssistantMessageId ?? conversation.parentMessageId;
        conversation.messages.push({
          role: "assistant",
          content: result.text.trimEnd(),
          createdAt: new Date().toISOString(),
        });
        conversation.updatedAt = new Date().toISOString();
        saveWindowState(workspaceRoot, state);

        return sendJson(res, { conversation });
      }

      return sendJson(res, { error: "Not found" }, 404);
    } catch (error) {
      return sendJson(res, { error: error.message }, 500);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const url = `http://127.0.0.1:${port}`;
  console.log(`Workspace window: ${url}`);
  openAppWindow(url);

  // Graceful shutdown: Ctrl+C / kill / закрытие терминала.
  // Сервер закрывается → фронт через heartbeat видит мёртвый CLI → окно закрывается.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal) console.log(`\nReceived ${signal}, stopping window server...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGHUP", () => shutdown("SIGHUP"));
}

// Маппинг режима из UI в значение model_type для DeepSeek API.
//
// Точные значения зависят от того, что DeepSeek принимает на бэкенде —
// мы их не реверсили, это конфигурируется через переменные окружения.
// Хочешь сменить модель для Expert — поставь DEEPSEEK_MODEL_EXPERT=твоё-значение
// в .env. Перезапуск CLI подтянет изменение.
//
// Как узнать правильное значение: открой chat.deepseek.com, DevTools → Network,
// переключи режим, посмотри какой model_type уходит в POST /api/v0/chat/completion.
// Маппинг режима из UI в model_type для DeepSeek API.
// ВАЖНО: реальный DeepSeek-фронт во ВСЕХ режимах (Fast/Expert/Vision) посылает
// model_type: null — отличие режимов закодировано в других флагах
// (thinking_enabled для Expert, ref_file_ids для Vision).
// Если мы шлём model_type: "expert" — DeepSeek принимает (нет 422), но
// архитектурно с ним выключается поиск.
// Через .env можно переопределить для экспериментов с разными моделями.
function mapModeToModelType(mode, fallback) {
  switch (mode) {
    case "expert":
      return process.env.DEEPSEEK_MODEL_EXPERT ?? null;
    case "vision":
      return process.env.DEEPSEEK_MODEL_VISION ?? null;
    case "fast":
    default:
      if (process.env.DEEPSEEK_MODEL_FAST) return process.env.DEEPSEEK_MODEL_FAST;
      return fallback ?? null;
  }
}

// Должны ли мы принудительно включить thinking для данного режима.
// Expert = "глубокое мышление" по умолчанию. Юзер может перебить тумблером.
function effectiveThinkingForMode(mode, userToggle, globalDefault) {
  if (userToggle === true) return true;
  if (userToggle === false) {
    // Юзер явно выключил — даже в Expert уважаем выбор.
    return false;
  }
  // userToggle === undefined: используем дефолт режима.
  if (mode === "expert") return true;
  return globalDefault;
}
