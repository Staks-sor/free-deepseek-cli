// Огромный HTML-шаблон окна чатов: layout и фронтенд JS.
// Стили вынесены в ./ui-styles.mjs.
// Самодостаточный — никаких внешних зависимостей и шаблонизации.
//
// При изменении: тест — открыть localhost:4317, проверить, что сайдбар, чат,
// модалки (Settings, New chat, файловый браузер) рендерятся и работают.

import { STYLES } from "./ui-styles.mjs";
export function renderWindowHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Free v0.1.7</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="sideHead">
        <div class="brand">Workspace</div>
        <button id="refreshBtn" class="iconBtn" title="Refresh">↻</button>
      </div>
      <button id="openNewChat" class="iconBtn newChatBtn" type="button">+ New chat</button>

      <div id="newChatOverlay" class="settingsOverlay hidden" aria-hidden="true">
        <div class="settingsPanel" role="dialog" aria-modal="true" aria-labelledby="newChatTitle">
          <div class="settingsHead">
            <h2 id="newChatTitle">Новый чат</h2>
            <button id="newChatClose" class="iconBtn" type="button" aria-label="Close">✕</button>
          </div>
          <form id="newForm" class="newForm" autocomplete="off">
            <label class="formField">
              <span>Провайдер</span>
              <div class="providerPicker" id="newChatProvider">
                <!-- кнопки рендерятся динамически по ответу /api/providers -->
              </div>
            </label>

            <label class="formField">
              <span>Режим (модель)</span>
              <div class="modePicker" id="newChatMode">
                <!-- кнопки режимов рендерятся динамически в зависимости от выбранного провайдера -->
              </div>
              <div class="modeHint">Режим зафиксируется при создании чата. Переключить потом нельзя — создавай новый чат в нужном режиме.</div>
            </label>

            <label class="formField">
              <span>Название чата (опционально)</span>
              <input id="newTitle" placeholder="Например: рефакторинг auth" autocomplete="off">
            </label>

            <label class="formField">
              <span>Папка проекта</span>
              <div class="pathRow">
                <input id="newWorkspace" placeholder="/Users/.../project или ~/Projects/new-thing" autocomplete="off">
                <button type="button" id="browseBtn" class="iconBtn">📁 Обзор</button>
              </div>
            </label>

            <div id="browseSection" class="browseSection hidden">
              <div class="browsePath" id="browsePath"></div>
              <div class="browseControls">
                <button type="button" id="browseUp" class="iconBtn">↑ Вверх</button>
                <button type="button" id="browseHome" class="iconBtn">🏠 Home</button>
                <button type="button" id="browseNewFolder" class="iconBtn">➕ Новая папка</button>
                <label class="checkboxRow inline">
                  <input type="checkbox" id="browseShowHidden">
                  <span>Скрытые</span>
                </label>
                <button type="button" id="browsePick" class="iconBtn primaryBtn">Выбрать эту папку</button>
              </div>
              <div id="createFolderRow" class="createFolderRow hidden">
                <input id="createFolderInput" placeholder="Имя новой папки" autocomplete="off">
                <button type="button" id="createFolderConfirm" class="iconBtn primaryBtn">Создать</button>
                <button type="button" id="createFolderCancel" class="iconBtn">Отмена</button>
              </div>
              <div id="createFolderError" class="formError hidden"></div>
              <div id="browseList" class="browseList">Loading...</div>
              <div id="browseTruncated" class="browseTruncated hidden">Показано первые 500 — папка содержит больше.</div>
            </div>

            <div id="recentProjects" class="recentProjects"></div>

            <label class="checkboxRow">
              <input id="newCreateFolder" type="checkbox">
              <span>Создать папку, если её ещё нет (только под твоим $HOME)</span>
            </label>

            <div class="formActions">
              <button type="submit" class="iconBtn primaryBtn">Создать чат</button>
            </div>
            <div id="newFormError" class="formError hidden"></div>
          </form>
        </div>
      </div>
      <div id="chatList" class="chatList"></div>
    </aside>
    <div id="sidebarResizer" class="sidebarResizer" title="Изменить ширину списка чатов"></div>
    <main class="main">
      <header class="topbar">
        <div id="activeTitleRow" class="titleRow">
          <div id="activeTitle" class="title">No chat selected</div>
          <span id="activeMode" class="modeBadge hidden"></span>
          <select id="modelPicker" class="modelPicker hidden" title="Модель"></select>
          <button id="coderToggle" class="coderToggle hidden" type="button" title="Включить режим агента — модель сама создаёт/редактирует файлы">🛠 Coder</button>
        </div>
        <div id="workspace" class="workspace"></div>
        <button id="settingsBtn" class="iconBtn settingsBtn" type="button" title="Settings / разрешённые команды">⚙</button>
      </header>

      <div id="settingsOverlay" class="settingsOverlay hidden" aria-hidden="true">
        <div class="settingsPanel" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
          <div class="settingsHead">
            <h2 id="settingsTitle">Settings — разрешённые команды для /code</h2>
            <button id="settingsClose" class="iconBtn" type="button" aria-label="Close">✕</button>
          </div>
          <p class="settingsHint">
            Каждая команда — это то, что LLM-агент может запустить через <code>run_command</code> в режиме <code>/code</code>.
            Включай только то, что реально нужно: чем шире allow-list, тем больше поверхность атаки.
            Файл настроек: <code>~/.deepseek-cli/settings.json</code>.
          </p>
          <div id="settingsBody" class="settingsBody">Loading…</div>
        </div>
      </div>
      <section id="messages" class="messages">
        <div class="empty">Создай чат слева. Каждый чат можно использовать как отдельный проект или рабочий контекст.</div>
      </section>
      <div id="composerResizer" class="composerResizer" title="Изменить высоту формы ввода"></div>
      <div class="bottomBar">
        <form id="composer" class="composer">
          <div id="attachmentList" class="attachmentList"></div>
          <textarea id="messageInput" placeholder="Сообщение DeepSeek... или /code создай файл app.js" disabled></textarea>
          <input type="file" id="fileInput" multiple style="display:none">
          <div class="composerControls">
            <button type="button" id="toggleThinking" class="togglePill" title="Глубокое мышление — модель показывает chain-of-thought">⚛ Глубокое мышление</button>
            <button type="button" id="toggleSearch" class="togglePill" title="Умный поиск — модель использует веб-поиск для актуальной инфы">🌐 Умный поиск</button>
            <button type="button" id="attachBtn" class="togglePill attachBtn" title="Прикрепить текстовый файл для чтения">📎 Файл</button>
            <div class="composerSpacer"></div>
            <button id="codeBtn" class="codeBtn" type="button" disabled>/code</button>
            <button id="sendBtn" class="sendBtn" type="submit" disabled>↑</button>
          </div>
        </form>
        <div id="status" class="status"></div>
      </div>
    </main>
  </div>

  <script>
    let appState = { conversations: [], activeConversationId: null, workspaceRoot: "" };
    let activeConversation = null;
    let sending = false;

    const chatList = document.getElementById("chatList");
    const appShell = document.querySelector(".app");
    const sidebarResizer = document.getElementById("sidebarResizer");
    const messages = document.getElementById("messages");
    const activeTitle = document.getElementById("activeTitle");
    const workspace = document.getElementById("workspace");
    const statusEl = document.getElementById("status");
    const messageInput = document.getElementById("messageInput");
    const codeBtn = document.getElementById("codeBtn");
    const sendBtn = document.getElementById("sendBtn");
    const SIDEBAR_WIDTH_KEY = "deepseek.sidebarWidth";
    const COMPOSER_HEIGHT_KEY = "deepseek.composerHeight";

    applySavedSidebarWidth();
    setupSidebarResize();
    applySavedComposerHeight();
    setupComposerResize();

    document.getElementById("refreshBtn").addEventListener("click", loadState);
    // ---- New chat modal ----
    const newChatOverlay = document.getElementById("newChatOverlay");
    const openNewChatBtn = document.getElementById("openNewChat");
    const newChatClose = document.getElementById("newChatClose");
    const newTitleInput = document.getElementById("newTitle");
    const newWorkspaceInput = document.getElementById("newWorkspace");
    const newCreateFolder = document.getElementById("newCreateFolder");
    const newFormError = document.getElementById("newFormError");
    const recentProjects = document.getElementById("recentProjects");

    openNewChatBtn.addEventListener("click", openNewChatModal);
    newChatClose.addEventListener("click", closeNewChatModal);
    newChatOverlay.addEventListener("click", (e) => {
      if (e.target === newChatOverlay) closeNewChatModal();
    });

    async function openNewChatModal() {
      newFormError.classList.add("hidden");
      newFormError.textContent = "";
      newTitleInput.value = "";
      newCreateFolder.checked = false;
      recentProjects.innerHTML = "";
      newChatOverlay.classList.remove("hidden");
      newChatOverlay.setAttribute("aria-hidden", "false");
      // Подтягиваем список ранее использованных проектов.
      try {
        const data = await api("/api/projects");
        newWorkspaceInput.value = data.defaultWorkspace || "";
        for (const project of data.projects || []) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "chip" + (project.exists ? "" : " missing");
          chip.title = project.path + (project.isDefault ? " (по умолчанию)" : "");
          chip.textContent = project.name + (project.isDefault ? " ★" : "");
          chip.addEventListener("click", () => { newWorkspaceInput.value = project.path; });
          recentProjects.appendChild(chip);
        }
      } catch {
        // не критично — просто не покажем список
      }
      newTitleInput.focus();
    }
    function closeNewChatModal() {
      newChatOverlay.classList.add("hidden");
      newChatOverlay.setAttribute("aria-hidden", "true");
    }

    // ---- Folder browser inside new chat modal ----
    const browseBtn = document.getElementById("browseBtn");
    const browseSection = document.getElementById("browseSection");
    const browsePath = document.getElementById("browsePath");
    const browseUp = document.getElementById("browseUp");
    const browseHome = document.getElementById("browseHome");
    const browsePick = document.getElementById("browsePick");
    const browseList = document.getElementById("browseList");
    const browseShowHidden = document.getElementById("browseShowHidden");
    const browseTruncated = document.getElementById("browseTruncated");

    let currentBrowsePath = null;
    let currentBrowseParent = null;
    let browseHome_ = null;

    browseBtn.addEventListener("click", async () => {
      if (browseSection.classList.contains("hidden")) {
        browseSection.classList.remove("hidden");
        // Стартуем с того, что в поле ввода. Если пусто — с домашней папки.
        const start = newWorkspaceInput.value.trim() || null;
        await navigateBrowse(start);
      } else {
        browseSection.classList.add("hidden");
      }
    });

    browseUp.addEventListener("click", () => {
      if (currentBrowseParent) navigateBrowse(currentBrowseParent);
    });
    browseHome.addEventListener("click", () => navigateBrowse(browseHome_));
    browsePick.addEventListener("click", () => {
      if (currentBrowsePath) {
        newWorkspaceInput.value = currentBrowsePath;
        browseSection.classList.add("hidden");
      }
    });
    browseShowHidden.addEventListener("change", () => {
      if (currentBrowsePath) navigateBrowse(currentBrowsePath);
    });

    // ---- Create new folder inline ----
    const browseNewFolder = document.getElementById("browseNewFolder");
    const createFolderRow = document.getElementById("createFolderRow");
    const createFolderInput = document.getElementById("createFolderInput");
    const createFolderConfirm = document.getElementById("createFolderConfirm");
    const createFolderCancel = document.getElementById("createFolderCancel");
    const createFolderError = document.getElementById("createFolderError");

    function showCreateFolderRow() {
      createFolderError.classList.add("hidden");
      createFolderError.textContent = "";
      createFolderInput.value = "";
      createFolderRow.classList.remove("hidden");
      createFolderInput.focus();
    }
    function hideCreateFolderRow() {
      createFolderRow.classList.add("hidden");
      createFolderError.classList.add("hidden");
    }

    browseNewFolder.addEventListener("click", showCreateFolderRow);
    createFolderCancel.addEventListener("click", hideCreateFolderRow);
    createFolderInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        createFolderConfirm.click();
      } else if (e.key === "Escape") {
        hideCreateFolderRow();
      }
    });

    createFolderConfirm.addEventListener("click", async () => {
      const name = createFolderInput.value.trim();
      if (!name) {
        createFolderError.textContent = "Введи имя.";
        createFolderError.classList.remove("hidden");
        return;
      }
      if (!currentBrowsePath) return;
      createFolderError.classList.add("hidden");
      try {
        const data = await api("/api/browse/mkdir", {
          method: "POST",
          body: { parent: currentBrowsePath, name },
        });
        hideCreateFolderRow();
        // Сразу заходим в созданную папку — обычно юзер хочет именно это.
        await navigateBrowse(data.path);
      } catch (err) {
        createFolderError.textContent = err.message;
        createFolderError.classList.remove("hidden");
      }
    });

    async function navigateBrowse(targetPath) {
      browseList.textContent = "Загружаю...";
      browseTruncated.classList.add("hidden");
      try {
        const params = new URLSearchParams();
        if (targetPath) params.set("path", targetPath);
        params.set("hidden", browseShowHidden.checked ? "1" : "0");
        const data = await api("/api/browse?" + params.toString());
        currentBrowsePath = data.path;
        currentBrowseParent = data.parent;
        browseHome_ = data.home;
        browsePath.textContent = data.path;
        browseUp.disabled = !data.parent;
        browseList.innerHTML = "";
        if (!data.entries.length) {
          const empty = document.createElement("div");
          empty.className = "browseEmpty";
          empty.textContent = "(нет подпапок)";
          browseList.appendChild(empty);
        } else {
          for (const entry of data.entries) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "browseRow";
            row.textContent = "📁  " + entry.name;
            row.title = entry.path;
            row.addEventListener("click", () => navigateBrowse(entry.path));
            browseList.appendChild(row);
          }
        }
        if (data.truncated) browseTruncated.classList.remove("hidden");
      } catch (err) {
        browseList.textContent = "Ошибка: " + err.message;
      }
    }

    document.getElementById("newForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = newTitleInput.value.trim();
      const workspace = newWorkspaceInput.value.trim();
      const createFolder = newCreateFolder.checked;
      newFormError.classList.add("hidden");
      newFormError.textContent = "";
      setStatus("Creating chat...");
      try {
        const data = await api("/api/conversations", {
          method: "POST",
          body: {
            title,
            workspace,
            createFolder,
            mode: newChatSelectedMode,
            provider: newChatSelectedProvider,
          },
        });
        activeConversation = data.conversation;
        await loadState(activeConversation.id);
        renderConversation(activeConversation);
        closeNewChatModal();
        setStatus("");
      } catch (err) {
        newFormError.textContent = err.message;
        newFormError.classList.remove("hidden");
        setStatus("");
      }
    });

    // ---- Toggle pills (Глубокое мышление / Умный поиск) ----
    // Тумблеры — per-message, sticky через localStorage.
    // Mode (Fast/Expert/Vision) теперь выбирается ТОЛЬКО при создании чата —
    // переключать посреди разговора нельзя (DeepSeek API завязывает chain на одну модель).
    const THINKING_KEY = "deepseek.composer.thinking";
    const SEARCH_KEY = "deepseek.composer.search";
    const NEWCHAT_MODE_KEY = "deepseek.newchat.mode";

    const toggleThinking = document.getElementById("toggleThinking");
    const toggleSearch = document.getElementById("toggleSearch");

    let thinkingActive = localStorage.getItem(THINKING_KEY) === "1";
    let searchActive = localStorage.getItem(SEARCH_KEY) === "1";

    function applyToggleUI() {
      toggleThinking.classList.toggle("active", thinkingActive);
      toggleSearch.classList.toggle("active", searchActive);
    }
    applyToggleUI();

    toggleThinking.addEventListener("click", () => {
      thinkingActive = !thinkingActive;
      localStorage.setItem(THINKING_KEY, thinkingActive ? "1" : "0");
      applyToggleUI();
    });

    toggleSearch.addEventListener("click", () => {
      searchActive = !searchActive;
      localStorage.setItem(SEARCH_KEY, searchActive ? "1" : "0");
      applyToggleUI();
    });

    // ---- File attachments ----
    // Стратегия: читаем КАК ТЕКСТ всё, что приходит. Бинари (изображения, PDF, exe)
    // дают мусор в декодировке — определяем по доле непечатных символов и null-байтов.
    // Если файл реально текст любого происхождения (.config, без расширения,
    // кириллица в имени, кастомное расширение) — пропускаем.
    const MAX_FILE_BYTES = 500 * 1024; // 500 КБ — чтоб не утопить контекст
    // Заведомо бинарные форматы — отказываем сразу, без чтения.
    const BINARY_EXTENSIONS = new Set([
      "png","jpg","jpeg","gif","webp","bmp","tiff","tif","heic","heif","svg",
      "mp3","wav","ogg","flac","m4a","aac",
      "mp4","mov","avi","mkv","webm","wmv",
      "pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp",
      "zip","tar","gz","7z","rar","bz2","xz",
      "exe","dll","so","dylib","bin","class","jar","war","apk","ipa",
      "psd","ai","sketch","fig",
      "ttf","otf","woff","woff2","eot",
    ]);

    let attachments = []; // [{ name, size, content }]
    const fileInput = document.getElementById("fileInput");
    const attachBtn = document.getElementById("attachBtn");
    const attachmentList = document.getElementById("attachmentList");

    attachBtn.addEventListener("click", () => fileInput.click());

    // Прочитать файл как base64 без падений на больших размерах (через FileReader).
    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          // result = "data:<mime>;base64,XXXX" — берём только base64-часть.
          const url = String(reader.result);
          const comma = url.indexOf(",");
          resolve(comma >= 0 ? url.slice(comma + 1) : url);
        };
        reader.onerror = () => reject(reader.error || new Error("FileReader error"));
        reader.readAsDataURL(file);
      });
    }

    fileInput.addEventListener("change", async (event) => {
      for (const file of event.target.files) {
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        const isImage = file.type.startsWith("image/")
          || ["png","jpg","jpeg","gif","webp","bmp","svg"].includes(ext);

        if (isImage) {
          // Картинки — заливаем на DeepSeek через наш сервер. Лимит 10 МБ на файл.
          if (file.size > 10 * 1024 * 1024) {
            alert(\`Картинка "\${file.name}" слишком большая (\${Math.round(file.size/1024/1024)} МБ). Лимит 10 МБ.\`);
            continue;
          }
          try {
            const dataBase64 = await fileToBase64(file);
            attachments.push({
              name: file.name,
              size: file.size,
              kind: "image",
              mimeType: file.type || "image/png",
              dataBase64,
            });
          } catch (err) {
            alert(\`Не удалось прочитать "\${file.name}": \${err.message}\`);
          }
          continue;
        }

        if (BINARY_EXTENSIONS.has(ext)) {
          alert(\`Файл "\${file.name}" — бинарный (\${ext}). Сейчас поддерживаются текстовые файлы и изображения (PNG/JPG/GIF/WEBP).\\n\\nPDF и Office-документы пока не работают — для них нужна отдельная фаза.\`);
          continue;
        }

        // Текстовый файл — читаем как UTF-8 и инлайним в промпт.
        if (file.size > MAX_FILE_BYTES) {
          alert(\`Файл "\${file.name}" слишком большой (\${Math.round(file.size/1024)} КБ). Лимит \${MAX_FILE_BYTES/1024} КБ для текстовых.\`);
          continue;
        }
        try {
          const content = await file.text();
          const sample = content.slice(0, 1000);
          let nonPrintable = 0;
          for (let i = 0; i < sample.length; i += 1) {
            const code = sample.charCodeAt(i);
            if (code === 0) { nonPrintable = sample.length; break; }
            if (code < 32 && code !== 9 && code !== 10 && code !== 13) nonPrintable += 1;
          }
          if (sample.length > 0 && nonPrintable / sample.length > 0.1) {
            alert(\`Файл "\${file.name}" похож на бинарный. Если уверен, что текстовый — переименуй в .txt.\`);
            continue;
          }
          attachments.push({ name: file.name, size: file.size, kind: "text", content });
        } catch (err) {
          alert(\`Не удалось прочитать "\${file.name}": \${err.message}\`);
        }
      }
      fileInput.value = "";
      renderAttachments();
    });

    function renderAttachments() {
      attachmentList.innerHTML = "";
      attachments.forEach((att, index) => {
        const chip = document.createElement("span");
        chip.className = "attachChip";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = "📎 " + att.name;
        const size = document.createElement("span");
        size.className = "size";
        size.textContent = Math.round(att.size / 1024) + " КБ";
        const remove = document.createElement("button");
        remove.className = "remove";
        remove.type = "button";
        remove.title = "Удалить";
        remove.textContent = "✕";
        remove.addEventListener("click", () => {
          attachments.splice(index, 1);
          renderAttachments();
        });
        chip.append(name, size, remove);
        attachmentList.appendChild(chip);
      });
    }

    // Префикс из ТЕКСТОВЫХ файлов в начало промпта. Картинки идут через ref_file_ids,
    // их инлайнить в текст не надо.
    function buildAttachmentsPrefix(textAttachments) {
      if (!textAttachments.length) return "";
      const parts = ["Я прикрепил файл" + (textAttachments.length > 1 ? "ы" : "") + " — прочитай и учитывай при ответе:"];
      for (const att of textAttachments) {
        const ext = (att.name.split(".").pop() || "").toLowerCase();
        parts.push(\`\\n--- Файл: \${att.name} (\${Math.round(att.size/1024)} КБ) ---\\n\\\`\\\`\\\`\${ext}\\n\${att.content}\\n\\\`\\\`\\\`\`);
      }
      parts.push("\\n---\\n\\nМой вопрос:");
      return parts.join("\\n");
    }

    // Provider picker + Mode picker — оба зависят от провайдера, рендерятся динамически.
    // Provider определяет, какие модели доступны (DeepSeek: Fast/Expert/Vision;
    // Qwen: пока default; в будущем добавим больше после реверса их API).
    const PROVIDER_PICK_KEY = "deepseek.newchat.provider";

    const PROVIDER_INFO = {
      deepseek: {
        label: "🐳 DeepSeek",
        sub: "chat.deepseek.com",
        modes: [
          { id: "fast",   title: "⚡ Быстрый",     sub: "default, быстро" },
          { id: "expert", title: "💎 Эксперт",    sub: "reasoning + мышление" },
          { id: "vision", title: "🖼 Распознание", sub: "для изображений" },
        ],
      },
      qwen: {
        label: "🐫 Qwen",
        sub: "chat.qwen.ai",
        modes: [
          { id: "default", title: "💬 Чат",        sub: "стандартная модель Qwen" },
        ],
        // Список моделей для picker'а. Должен совпадать с QWEN_MODELS в config.mjs.
        models: [
          { id: "qwen3.6-plus",  label: "Qwen3.6 Plus" },
          { id: "qwen3-max",     label: "Qwen3 Max" },
          { id: "qwen2.5-plus",  label: "Qwen 2.5 Plus" },
          { id: "qwq-32b",       label: "QwQ-32B (reasoning)" },
          { id: "qwen-vl-max",   label: "Qwen-VL Max (vision)" },
        ],
        defaultModel: "qwen3.6-plus",
      },
    };

    const newChatProviderPicker = document.getElementById("newChatProvider");
    const newChatModePicker = document.getElementById("newChatMode");

    let availableProviders = ["deepseek"]; // подтянем с сервера через /api/providers
    let newChatSelectedProvider = localStorage.getItem(PROVIDER_PICK_KEY) || "deepseek";
    let newChatSelectedMode = localStorage.getItem(NEWCHAT_MODE_KEY) || "fast";

    async function connectProvider(id) {
      const info = PROVIDER_INFO[id];
      if (!info) return;
      const label = info.label;
      if (!confirm(
        "Подключить " + label + "?\\n\\nОткроется окно браузера — залогинься на сайте. " +
        "Окно закроется само после входа.",
      )) return;
      try {
        const r = await fetch("/api/providers/" + id + "/login", { method: "POST" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        await refreshAvailableProviders();
        if (availableProviders.includes(id)) {
          newChatSelectedProvider = id;
          localStorage.setItem(PROVIDER_PICK_KEY, id);
          renderProviderPicker();
          renderModePickerForProvider();
          alert(label + " подключён.");
        } else {
          alert("Логин завершён, но токен не найден. Попробуй ещё раз или: npm run login-" + id);
        }
      } catch (e) {
        alert("Не удалось подключить " + label + ": " + e.message);
      }
    }

    async function refreshAvailableProviders() {
      try {
        const r = await fetch("/api/providers");
        if (r.ok) {
          const j = await r.json();
          availableProviders = (j.providers || []).filter((p) => p.hasAuth).map((p) => p.id);
        }
      } catch {}
    }

    function renderProviderPicker() {
      newChatProviderPicker.innerHTML = "";
      for (const id of Object.keys(PROVIDER_INFO)) {
        const info = PROVIDER_INFO[id];
        const isAuthed = availableProviders.includes(id);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "providerOption " + id
          + (id === newChatSelectedProvider && isAuthed ? " active" : "")
          + (!isAuthed ? " needsAuth" : "");
        btn.dataset.provider = id;
        btn.dataset.authed = isAuthed ? "1" : "0";
        btn.innerHTML =
          '<div class="providerOptionTitle"></div>' +
          '<div class="providerOptionSub"></div>';
        btn.querySelector(".providerOptionTitle").textContent = info.label;
        btn.querySelector(".providerOptionSub").textContent = isAuthed
          ? info.sub
          : info.sub + " (нажми — подключить)";
        newChatProviderPicker.appendChild(btn);
      }
    }

    function renderModePickerForProvider() {
      const info = PROVIDER_INFO[newChatSelectedProvider] || PROVIDER_INFO.deepseek;
      // Если текущий режим не подходит провайдеру — сбросим на первый.
      if (!info.modes.find((m) => m.id === newChatSelectedMode)) {
        newChatSelectedMode = info.modes[0].id;
      }
      newChatModePicker.innerHTML = "";
      for (const m of info.modes) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "modeOption" + (m.id === newChatSelectedMode ? " active" : "");
        btn.dataset.mode = m.id;
        btn.innerHTML =
          '<div class="modeOptionTitle"></div><div class="modeOptionSub"></div>';
        btn.querySelector(".modeOptionTitle").textContent = m.title;
        btn.querySelector(".modeOptionSub").textContent = m.sub;
        newChatModePicker.appendChild(btn);
      }
    }

    newChatProviderPicker.addEventListener("click", async (event) => {
      const opt = event.target.closest(".providerOption");
      if (!opt) return;
      const id = opt.dataset.provider;
      if (opt.dataset.authed !== "1") {
        await connectProvider(id);
        return;
      }
      newChatSelectedProvider = id;
      localStorage.setItem(PROVIDER_PICK_KEY, newChatSelectedProvider);
      renderProviderPicker();
      renderModePickerForProvider();
    });

    newChatModePicker.addEventListener("click", (event) => {
      const opt = event.target.closest(".modeOption");
      if (!opt) return;
      newChatSelectedMode = opt.dataset.mode;
      localStorage.setItem(NEWCHAT_MODE_KEY, newChatSelectedMode);
      renderModePickerForProvider();
    });

    // На старте подтянем список доступных провайдеров и нарисуем picker'ы.
    (async () => {
      await refreshAvailableProviders();
      if (!availableProviders.includes(newChatSelectedProvider) && availableProviders.length) {
        newChatSelectedProvider = availableProviders[0];
      }
      renderProviderPicker();
      renderModePickerForProvider();
    })();

    document.getElementById("composer").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!activeConversation || sending) return;
      const rawUserMessage = messageInput.value.trim();
      if (!rawUserMessage && !attachments.length) return;

      const textFiles = attachments.filter((a) => a.kind === "text");
      const imageFiles = attachments.filter((a) => a.kind === "image");

      // Если юзер прикрепил картинку, но ничего не написал — подставляем дефолтный
      // промпт. DeepSeek API не принимает пустой prompt, и сам по себе file_id
      // ничего не значит без текстового вопроса.
      const userMessage = rawUserMessage || (imageFiles.length
        ? "Что на этом изображении? Опиши подробно."
        : "");

      const attachPrefix = buildAttachmentsPrefix(textFiles);
      const contentForApi = attachPrefix ? attachPrefix + "\\n\\n" + userMessage : userMessage;
      // В UI чата показываем: оригинал юзера (если был) + список вложений.
      // Если юзер ничего не печатал — показываем placeholder про дефолтный вопрос.
      const displayParts = [];
      if (rawUserMessage) displayParts.push(rawUserMessage);
      if (!rawUserMessage && imageFiles.length) displayParts.push("(вопрос по изображению)");
      if (attachments.length) {
        displayParts.push(attachments.map((a) => "📎 " + a.name).join("\\n"));
      }
      const displayForChat = displayParts.join("\\n\\n");

      sending = true;
      setComposerEnabled(false);
      messageInput.value = "";
      // Сбросить авто-рост на исходную высоту (но если юзер тянул руками — оставить).
      if (!userResizedInput) messageInput.style.height = "";
      const sentAttachments = attachments;
      attachments = [];
      renderAttachments();
      activeConversation.messages.push({ role: "user", content: displayForChat });
      renderConversation(activeConversation);

      try {
        // Сначала заливаем картинки — получаем file_id для каждой.
        // Загрузка + ожидание обработки (status=PENDING→SUCCESS) может занять
        // 3-10 секунд на картинку, поэтому показываем индикатор прогресса.
        const refFileIds = [];
        if (imageFiles.length) {
          for (let i = 0; i < imageFiles.length; i += 1) {
            const img = imageFiles[i];
            const num = imageFiles.length > 1 ? \` (\${i + 1}/\${imageFiles.length})\` : "";
            setStatus(\`Заливаю и обрабатываю изображение\${num}: \${img.name}...\`);
            const result = await api("/api/upload", {
              method: "POST",
              body: {
                name: img.name,
                mimeType: img.mimeType,
                dataBase64: img.dataBase64,
              },
            });
            if (!result.fileId) throw new Error("Upload вернул без fileId");
            refFileIds.push(result.fileId);
          }
        }

        setStatus("Thinking...");
        const sentConvId = activeConversation.id;
        const data = await api("/api/conversations/" + sentConvId + "/messages", {
          method: "POST",
          body: {
            content: contentForApi,
            thinking: thinkingActive,
            search: searchActive,
            refFileIds,
          },
        });

        // Если сервер вернул running:true — это /code в фоне. Отпускаем UI,
        // даём юзеру переключаться по чатам. Polling сам подхватит результат.
        if (data.running) {
          activeConversation = data.conversation;
          await loadState(activeConversation.id);
          renderConversation(activeConversation);
          setStatus("⚙️ Задача выполняется в фоне — можно перейти в другой чат");
          ensurePolling();
          return; // sending снимет в finally, polling завершит UI
        }

        activeConversation = data.conversation;
        await loadState(activeConversation.id);
        renderConversation(activeConversation);
        setStatus("");
      } catch (error) {
        // Возвращаем файлы юзеру — иначе он не поймёт, что они пропали.
        attachments = sentAttachments;
        renderAttachments();
        setStatus(error.message, true);
      } finally {
        sending = false;
        setComposerEnabled(true);
        messageInput.focus();
      }
    });

    messageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        document.getElementById("composer").requestSubmit();
      }
    });

    // Авто-рост textarea по содержимому. Не мешает ручному resize:
    // как только пользователь перетащил угол — фиксированная высота
    // выставлена через inline style и больше не сбрасывается до отправки.
    let userResizedInput = false;
    const autoGrowInput = () => {
      if (userResizedInput) return;
      messageInput.style.height = "auto";
      const maxPx = Math.floor(window.innerHeight * 0.6);
      const next = Math.min(messageInput.scrollHeight, maxPx);
      messageInput.style.height = next + "px";
    };
    messageInput.addEventListener("input", autoGrowInput);
    // Если пользователь сам потянул за уголок — запоминаем и не трогаем.
    messageInput.addEventListener("mousedown", (e) => {
      const rect = messageInput.getBoundingClientRect();
      // нижний-правый угол ~16x16 — резайз-хэндл
      if (e.clientX > rect.right - 18 && e.clientY > rect.bottom - 18) {
        userResizedInput = true;
      }
    });

    codeBtn.addEventListener("click", () => {
      if (!activeConversation || sending) return;
      const value = messageInput.value.trim();
      if (value.startsWith("/code")) {
        messageInput.focus();
        return;
      }
      messageInput.value = value ? "/code " + value : "/code ";
      messageInput.focus();
      messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
    });

    async function loadState(nextActiveId = null) {
      appState = await api("/api/state");
      if (nextActiveId) appState.activeConversationId = nextActiveId;
      renderList();
      if (appState.activeConversationId) {
        const data = await api("/api/conversations/" + appState.activeConversationId);
        activeConversation = data.conversation;
        renderConversation(activeConversation);
      } else {
        activeConversation = null;
        renderNoConversation();
      }
      // Если есть фоновые задачи — запустить polling.
      if ((appState.runningTaskIds || []).length > 0) ensurePolling();
    }

    // Polling для отслеживания фоновых /code-задач. Один setInterval на всю сессию,
    // запускается при наличии running tasks и автоматически останавливается, когда
    // их не остаётся. Тик — 1.5 сек.
    let pollTimer = null;
    function ensurePolling() {
      if (pollTimer) return;
      pollTimer = setInterval(pollTick, 1500);
    }
    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
    async function pollTick() {
      let nextState;
      try {
        nextState = await api("/api/state");
      } catch {
        return; // сетевая ошибка — попробуем на следующем тике
      }
      const prevRunning = new Set(appState.runningTaskIds || []);
      const nextRunning = new Set(nextState.runningTaskIds || []);
      appState.conversations = nextState.conversations;
      appState.runningTaskIds = nextState.runningTaskIds;
      renderList();

      // Если активный чат всё ещё в работе — подтягиваем его свежие сообщения
      // (могут добавляться tool-логи во время /code).
      if (activeConversation && nextRunning.has(activeConversation.id)) {
        try {
          const data = await api("/api/conversations/" + activeConversation.id);
          activeConversation = data.conversation;
          renderConversation(activeConversation);
        } catch {}
      }

      // Если активный чат ТОЛЬКО ЧТО завершился — финальный рендер + сброс статуса.
      if (activeConversation && prevRunning.has(activeConversation.id) && !nextRunning.has(activeConversation.id)) {
        try {
          const data = await api("/api/conversations/" + activeConversation.id);
          activeConversation = data.conversation;
          renderConversation(activeConversation);
          setStatus("");
        } catch {}
      }

      if (nextRunning.size === 0) stopPolling();
    }

    function renderList() {
      chatList.innerHTML = "";
      const running = new Set(appState.runningTaskIds || []);
      for (const conversation of appState.conversations) {
        const button = document.createElement("button");
        const isRunning = running.has(conversation.id);
        button.className =
          "chatItem"
          + (conversation.id === appState.activeConversationId ? " active" : "")
          + (isRunning ? " running" : "");
        button.innerHTML =
          '<div class="chatTitle"></div><div class="chatFolder"></div><div class="chatMeta"></div><button class="chatDelete" type="button" title="Удалить чат">×</button>';
        // Заголовок + спиннер (если задача в работе) + бейдж провайдера.
        const titleEl = button.querySelector(".chatTitle");
        if (isRunning) {
          const sp = document.createElement("span");
          sp.className = "taskSpinner";
          sp.title = "Выполняется /code-задача";
          titleEl.appendChild(sp);
        }
        titleEl.appendChild(document.createTextNode(conversation.title));
        const prov = conversation.provider || "deepseek";
        const pb = document.createElement("span");
        pb.className = "providerBadge " + prov;
        pb.textContent = prov;
        titleEl.appendChild(document.createTextNode(" "));
        titleEl.appendChild(pb);
        // Папка проекта — короткое имя (basename) с полным путём в tooltip.
        const folderEl = button.querySelector(".chatFolder");
        const ws = conversation.workspace || "";
        if (ws) {
          const parts = ws.split("/").filter(Boolean);
          folderEl.textContent = "📁 " + (parts[parts.length - 1] || ws);
          folderEl.title = ws;
        } else {
          folderEl.style.display = "none";
        }
        button.querySelector(".chatMeta").textContent =
          conversation.messageCount + " messages";
        button.querySelector(".chatDelete").addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!confirm("Удалить чат?")) return;
          await api("/api/conversations/" + conversation.id, { method: "DELETE" });
          if (activeConversation && activeConversation.id === conversation.id) {
            activeConversation = null;
          }
          await loadState();
          if (!appState.activeConversationId) renderNoConversation();
        });
        button.addEventListener("click", async () => {
          const data = await api("/api/conversations/" + conversation.id);
          appState.activeConversationId = conversation.id;
          activeConversation = data.conversation;
          renderList();
          renderConversation(activeConversation);
        });
        chatList.appendChild(button);
      }
    }

    const activeModeBadge = document.getElementById("activeMode");
    const modelPickerEl = document.getElementById("modelPicker");
    const coderToggleEl = document.getElementById("coderToggle");

    function renderNoConversation() {
      activeTitle.textContent = "No chat selected";
      workspace.textContent = appState.workspaceRoot || "";
      activeModeBadge.classList.add("hidden");
      modelPickerEl.classList.add("hidden");
      coderToggleEl.classList.add("hidden");
      messages.innerHTML = '<div class="empty">Создай чат слева. Каждый чат можно использовать как отдельный проект или рабочий контекст.</div>';
      setComposerEnabled(false);
    }

    // Patch на сервере: обновить model / coderMode для активного чата.
    async function patchActiveConversation(payload) {
      if (!activeConversation) return;
      const data = await api("/api/conversations/" + activeConversation.id, {
        method: "PATCH",
        body: payload,
      });
      activeConversation = data.conversation;
      renderConversation(activeConversation);
      renderList();
    }

    modelPickerEl.addEventListener("change", () => {
      patchActiveConversation({ model: modelPickerEl.value }).catch((e) => setStatus(e.message, true));
    });
    coderToggleEl.addEventListener("click", () => {
      const next = !(activeConversation && activeConversation.coderMode === true);
      patchActiveConversation({ coderMode: next }).catch((e) => setStatus(e.message, true));
    });

    function renderConversation(conversation) {
      activeTitle.textContent = conversation.title;
      workspace.textContent = conversation.workspace || appState.workspaceRoot;
      if (appState.stateFile) workspace.title = "History: " + appState.stateFile;
      // Бейдж режима: показывает, какая модель привязана к этому чату.
      // Берём label из PROVIDER_INFO с учётом провайдера чата.
      const mode = conversation.mode || "fast";
      const prov = conversation.provider || "deepseek";
      const info = PROVIDER_INFO[prov] || PROVIDER_INFO.deepseek;
      const modeDef = info.modes.find((m) => m.id === mode) || info.modes[0];
      activeModeBadge.className = "modeBadge " + mode;
      activeModeBadge.textContent = modeDef?.title || mode;

      // Model picker — только для провайдеров с поддержкой смены модели (сейчас Qwen).
      if (Array.isArray(info.models) && info.models.length > 1) {
        const currentModel = conversation.model || info.defaultModel || info.models[0].id;
        modelPickerEl.innerHTML = "";
        for (const m of info.models) {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.label;
          if (m.id === currentModel) opt.selected = true;
          modelPickerEl.appendChild(opt);
        }
        modelPickerEl.classList.remove("hidden");
      } else {
        modelPickerEl.classList.add("hidden");
      }

      // Coder toggle — переключает coderMode для текущего чата.
      // Когда включён, каждое сообщение проходит через runCodeTask (без /code префикса).
      coderToggleEl.classList.remove("hidden");
      if (conversation.coderMode === true) {
        coderToggleEl.classList.add("active");
        coderToggleEl.textContent = "🛠 Coder ON";
      } else {
        coderToggleEl.classList.remove("active");
        coderToggleEl.textContent = "🛠 Coder";
      }

      // Раньше я думал, что search не работает в Expert — но юзер подтвердил
      // что в реальном DeepSeek UI работает в Fast и Expert. Vision ещё не проверяли.
      toggleSearch.disabled = false;
      toggleSearch.classList.remove("disabled");
      toggleSearch.title = "Умный поиск — модель использует веб-поиск для актуальной инфы";
      setComposerEnabled(!sending);
      messages.innerHTML = "";

      if (!conversation.messages.length) {
        messages.innerHTML = '<div class="empty">Напиши первое сообщение для этого проекта.</div>';
        return;
      }

      for (const message of conversation.messages) {
        const row = document.createElement("article");
        row.className = "msg " + message.role;
        const role = document.createElement("div");
        role.className = "role";
        // Подпись assistant'а — провайдер-специфичная.
        const assistantLabel = ({ deepseek: "DeepSeek", qwen: "Qwen" })[conversation.provider || "deepseek"] || "Assistant";
        role.textContent = message.role === "user" ? "You" : assistantLabel;
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.textContent = message.content;
        row.append(role, bubble);
        messages.appendChild(row);
      }
      messages.scrollTop = messages.scrollHeight;
    }

    function setComposerEnabled(enabled) {
      messageInput.disabled = !enabled || !activeConversation;
      codeBtn.disabled = !enabled || !activeConversation;
      sendBtn.disabled = !enabled || !activeConversation;
    }

    function setStatus(text, isError = false) {
      statusEl.textContent = text;
      statusEl.className = "status" + (isError ? " error" : "");
    }

    async function api(url, options = {}) {
      const fetchOptions = {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json" },
      };
      if (options.body) fetchOptions.body = JSON.stringify(options.body);
      const res = await fetch(url, fetchOptions);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    }

    // ---- Heartbeat: закрываем окно, когда CLI остановлен (Ctrl+C / закрыли терминал).
    // Три промаха подряд → сервер точно мёртв → показываем сообщение и закрываем окно.
    // Порог в 3 защищает от случайного network blip (например, рестарт сервера юзером).
    let heartbeatFailures = 0;
    let shutdownStarted = false;
    async function tickHeartbeat() {
      if (shutdownStarted) return;
      try {
        const res = await fetch("/api/heartbeat", { cache: "no-store" });
        if (!res.ok) throw new Error("heartbeat not ok");
        heartbeatFailures = 0;
      } catch {
        heartbeatFailures += 1;
        if (heartbeatFailures >= 3) {
          shutdownStarted = true;
          // Показываем чистую заглушку и закрываем.
          document.body.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;color:#888;font-family:system-ui;background:#0a0a0a;text-align:center;padding:24px">' +
            '<div style="font-size:18px">CLI остановлен</div>' +
            '<div style="font-size:13px;color:#666">Сервер больше не отвечает. Окно закроется автоматически.</div>' +
            "</div>";
          setTimeout(() => {
            try { window.close(); } catch {}
          }, 600);
        }
      }
    }
    setInterval(tickHeartbeat, 2000);

    // ---- Settings modal (разрешённые команды для /code) ----
    const settingsBtn = document.getElementById("settingsBtn");
    const settingsOverlay = document.getElementById("settingsOverlay");
    const settingsClose = document.getElementById("settingsClose");
    const settingsBody = document.getElementById("settingsBody");

    settingsBtn.addEventListener("click", openSettings);
    settingsClose.addEventListener("click", closeSettings);
    settingsOverlay.addEventListener("click", (e) => {
      if (e.target === settingsOverlay) closeSettings();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !settingsOverlay.classList.contains("hidden")) closeSettings();
    });

    async function openSettings() {
      settingsOverlay.classList.remove("hidden");
      settingsOverlay.setAttribute("aria-hidden", "false");
      settingsBody.textContent = "Loading…";
      try {
        const data = await api("/api/settings");
        renderSettings(data);
      } catch (err) {
        settingsBody.textContent = "Не удалось загрузить настройки: " + err.message;
      }
    }
    function closeSettings() {
      settingsOverlay.classList.add("hidden");
      settingsOverlay.setAttribute("aria-hidden", "true");
    }

    function renderSettings({ catalog, allowedCommands }) {
      const allowed = new Set(allowedCommands || []);
      const groups = { low: [], medium: [], high: [] };
      for (const item of catalog) {
        (groups[item.risk] || groups.low).push(item);
      }
      const labels = { low: "Низкий риск", medium: "Средний риск", high: "Высокий риск" };
      const order = ["low", "medium", "high"];
      settingsBody.innerHTML = "";
      for (const key of order) {
        const items = groups[key];
        if (!items.length) continue;
        const groupEl = document.createElement("div");
        groupEl.className = "settingsGroup";
        const heading = document.createElement("h3");
        heading.textContent = labels[key];
        groupEl.appendChild(heading);
        for (const item of items) {
          const row = document.createElement("label");
          row.className = "settingsItem";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = allowed.has(item.name);
          cb.dataset.cmd = item.name;
          cb.addEventListener("change", onToggle);

          const textWrap = document.createElement("div");
          const nameEl = document.createElement("div");
          nameEl.className = "name";
          nameEl.textContent = item.name;
          const descEl = document.createElement("div");
          descEl.className = "desc";
          descEl.textContent = item.description;
          textWrap.appendChild(nameEl);
          textWrap.appendChild(descEl);

          const badge = document.createElement("span");
          badge.className = "riskBadge " + item.risk;
          badge.textContent = item.risk;

          row.appendChild(cb);
          row.appendChild(textWrap);
          row.appendChild(badge);
          groupEl.appendChild(row);
        }
        settingsBody.appendChild(groupEl);
      }
    }

    async function onToggle() {
      // Собираем актуальный список из всех чекбоксов и пушим на сервер.
      const allCheckboxes = settingsBody.querySelectorAll('input[type="checkbox"]');
      const selected = Array.from(allCheckboxes)
        .filter((cb) => cb.checked)
        .map((cb) => cb.dataset.cmd);
      try {
        await api("/api/settings", { method: "PUT", body: { allowedCommands: selected } });
      } catch (err) {
        // Откат UI на серверное состояние при ошибке.
        const data = await api("/api/settings").catch(() => null);
        if (data) renderSettings(data);
        alert("Не удалось сохранить: " + err.message);
      }
    }

    function applySavedSidebarWidth() {
      const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      if (Number.isFinite(saved)) applySidebarWidth(saved);
    }

    function setupSidebarResize() {
      let dragging = false;

      sidebarResizer.addEventListener("pointerdown", (event) => {
        dragging = true;
        sidebarResizer.classList.add("dragging");
        document.body.classList.add("resizingSidebar");
        sidebarResizer.setPointerCapture(event.pointerId);
        event.preventDefault();
      });

      sidebarResizer.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        const rect = appShell.getBoundingClientRect();
        applySidebarWidth(event.clientX - rect.left);
      });

      const finishDrag = (event) => {
        if (!dragging) return;
        dragging = false;
        sidebarResizer.classList.remove("dragging");
        document.body.classList.remove("resizingSidebar");
        try {
          sidebarResizer.releasePointerCapture(event.pointerId);
        } catch {}
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(getSidebarWidth()));
      };

      sidebarResizer.addEventListener("pointerup", finishDrag);
      sidebarResizer.addEventListener("pointercancel", finishDrag);
    }

    function applySidebarWidth(rawWidth) {
      const maxWidth = Math.max(260, Math.min(560, Math.floor(window.innerWidth * 0.55)));
      const width = Math.max(220, Math.min(maxWidth, Math.round(rawWidth)));
      appShell.style.setProperty("--sidebar-width", width + "px");
    }

    function getSidebarWidth() {
      return parseInt(getComputedStyle(appShell).getPropertyValue("--sidebar-width"), 10) || 300;
    }

    // === Resize composer (вертикально) ===
    // Логика похожа на sidebar: pointerdown → dragging → pointermove обновляет
    // --composer-height в стиле .main, pointerup сохраняет в localStorage.
    function applySavedComposerHeight() {
      const saved = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY));
      if (Number.isFinite(saved) && saved > 0) applyComposerHeight(saved);
    }

    function setupComposerResize() {
      const resizer = document.getElementById("composerResizer");
      const mainEl = document.querySelector(".main");
      if (!resizer || !mainEl) return;
      let dragging = false;

      resizer.addEventListener("pointerdown", (event) => {
        dragging = true;
        resizer.classList.add("dragging");
        document.body.classList.add("resizingComposer");
        resizer.setPointerCapture(event.pointerId);
        event.preventDefault();
      });

      resizer.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        // composer-height = расстояние от низа окна до курсора.
        const fromBottom = window.innerHeight - event.clientY - 3; // -3: половина handle'а
        applyComposerHeight(fromBottom);
      });

      const finishDrag = (event) => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove("dragging");
        document.body.classList.remove("resizingComposer");
        try { resizer.releasePointerCapture(event.pointerId); } catch {}
        const current = getComposerHeight();
        if (current) localStorage.setItem(COMPOSER_HEIGHT_KEY, String(current));
      };

      resizer.addEventListener("pointerup", finishDrag);
      resizer.addEventListener("pointercancel", finishDrag);
    }

    function applyComposerHeight(rawPx) {
      const mainEl = document.querySelector(".main");
      if (!mainEl) return;
      // Лимиты:
      //  - min 140px = textarea (~70) + gap (10) + composerControls (~48) + padding. Меньше — обрезает кнопки.
      //  - max 80% окна, чтобы messages не сжимался полностью.
      const maxPx = Math.floor(window.innerHeight * 0.8);
      const px = Math.max(140, Math.min(maxPx, Math.round(rawPx)));
      mainEl.style.setProperty("--composer-height", px + "px");
      mainEl.classList.add("composerSized");
    }

    function getComposerHeight() {
      const mainEl = document.querySelector(".main");
      if (!mainEl) return 0;
      const raw = getComputedStyle(mainEl).getPropertyValue("--composer-height").trim();
      return parseInt(raw, 10) || 0;
    }

    loadState().catch((error) => setStatus(error.message, true));
  </script>
</body>
</html>`;
}
