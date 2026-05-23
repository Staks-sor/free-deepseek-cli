// Прототип OpenAI-совместимого /v1/chat/completions.
//
// Поддерживает:
//   - POST /v1/chat/completions с body { model, messages, stream:true/false }
//   - GET  /v1/models
//
// НЕ поддерживает (пока):
//   - tools / function calling (TODO)
//   - logprobs, n>1, seed, и прочие OpenAI-параметры
//   - API-ключи (TODO: добавить после прототипа)
//
// Маршрутизация: model имя → провайдер (см. models.mjs).
//   - Qwen: создаём чат по запросу (sessionId не персистится между вызовами API!),
//           отправляем последнее user-сообщение, ждём полный ответ.
//   - DeepSeek: аналогично — каждый запрос = свежий чат.
//
// Это значит: внешний клиент должен слать ВСЮ историю в body.messages, чтобы
// модель имела контекст. Сервер не помнит ничего между запросами (stateless).
// Это OpenAI-совместимое поведение — у них тоже stateless.

import { findModel, modelsList } from "./models.mjs";
import { readQwenAuth } from "../src/providers/qwen/auth-files.mjs";
import { QWEN_AUTH_FILE } from "../src/providers/qwen/config.mjs";
import { QwenChatClient } from "../src/providers/qwen/client.mjs";
import { DEFAULT_AUTH_FILE } from "../src/config.mjs";
import { readSavedAuth } from "../src/auth/files.mjs";
import { DeepSeekChatClient } from "../src/deepseek/client.mjs";

// Ленивый singleton Qwen-клиента — переиспользуем через все вызовы API.
let qwenClient = null;
// Ленивый singleton DeepSeek-клиента — переиспользуем через все вызовы API.
let deepseekClient = null;
async function getQwenClient() {
  if (qwenClient) return qwenClient;
  const auth = readQwenAuth(QWEN_AUTH_FILE);
  if (!auth?.token) {
    throw new Error("Qwen не подключён. Запусти: npm run login-qwen");
  }
  qwenClient = new QwenChatClient({
    token: auth.token,
    cookieHeader: auth.cookieHeader,
    debug: Boolean(process.env.API_DEBUG),
  });
  return qwenClient;
}

async function getDeepSeekClient() {
  if (deepseekClient) return deepseekClient;
  const auth = readSavedAuth(DEFAULT_AUTH_FILE);
  if (!auth?.token || !auth?.cookieHeader) {
    throw new Error("DeepSeek не подключён. Запусти: npm run login");
  }
  deepseekClient = new DeepSeekChatClient({
    token: auth.token,
    cookieHeader: auth.cookieHeader,
    debug: Boolean(process.env.API_DEBUG),
  });
  return deepseekClient;
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return sendJson(res, modelsList());
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    return handleChatCompletions(req, res);
  }

  if (req.method === "GET" && url.pathname === "/") {
    return sendJson(res, {
      name: "deepseek-cli openai-compat",
      version: "0.1.0-prototype",
      endpoints: ["GET /v1/models", "POST /v1/chat/completions"],
      docs: "see README.md in api/",
    });
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: { message: "Not found", type: "not_found_error" } }));
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendError(res, 400, `Invalid JSON: ${e.message}`);
  }

  const modelName = body?.model;
  if (!modelName) return sendError(res, 400, "Missing 'model' field");

  console.log(`[API] POST /v1/chat/completions (model: ${modelName}, stream: ${Boolean(body.stream)}, tools: ${body.tools ? body.tools.length : 0})`);

  const mapping = findModel(modelName);
  if (!mapping) return sendError(res, 404, `Unknown model: ${modelName}`);

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) return sendError(res, 400, "Missing 'messages' array");

  // OpenAI присылает ВСЮ историю каждый раз. Мы её сжимаем в один prompt —
  // конкатенируем с лейблами ролей. Это упрощение прототипа; для качества контекста
  // потом сделаем proper multi-turn через persistent sessionId + parent_id chain.
  let prompt = "";
  if (body.tools && body.tools.length > 0) {
    // DeepSeek and Qwen often ignore soft instructions.
    // Try to inject it as a direct command from the user for better compliance.
    prompt += `[TOOL INSTRUCTIONS]
You are interacting with a system that executes tool calls automatically.
To call a tool, you must reply with a JSON array wrapped in a \`\`\`tool_calls\`\`\` markdown block.
Example:
\`\`\`tool_calls
[
  {
    "name": "default_api:bash",
    "arguments": {
      "command": "python --version"
    }
  }
]
\`\`\`
DO NOT output just "command: ...". You MUST use the exact JSON structure and markdown block above.
If you need to output text to the user, you can just write normal text. If you want to use tools, write the tool block.

Available tools:
${JSON.stringify(body.tools, null, 2)}
[END TOOL INSTRUCTIONS]\n\n---\n\n`;
  }

  prompt += messages
    .map((m) => {
      if (m.role === "tool") {
        return `[TOOL RESULT FOR ${m.name}]:\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;
      }
      if (m.role === "system") {
        return `[SYSTEM]:\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;
      }
      let content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (m.role === "assistant" && m.tool_calls) {
        try {
          const tcs = m.tool_calls.map(tc => ({
            name: tc.function.name,
            arguments: typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments
          }));
          content += `\n\`\`\`tool_calls\n${JSON.stringify(tcs, null, 2)}\n\`\`\``;
        } catch(e) {}
      }
      return `[${(m.role || "user").toUpperCase()}]:\n${content}`;
    })
    .join("\n\n---\n\n");
    
  // Ensure the prompt ends with a clear directive if tools are available
  if (body.tools && body.tools.length > 0) {
    prompt += `\n\n---\n[SYSTEM REMINDER]: You MUST use the exact JSON array format wrapped in \`\`\`tool_calls\`\`\` to call tools. If you output plain bash commands, it will fail.`;
  }

  try {
    if (mapping.provider === "qwen") {
      const client = await getQwenClient();
      // Свежий чат на каждый запрос — простейший stateless flow.
      const chatId = await client.createChat({ model: mapping.model, title: "API request" });

      if (body.stream === true) {
        return handleQwenStream(client, chatId, prompt, modelName, mapping.model, res);
      }

      const result = await client.complete({
        chatId,
        prompt,
        thinking: false,
        search: false,
        model: mapping.model,
      });
      return sendJson(res, toOpenAIResponse(modelName, result.text));
    }
    if (mapping.provider === "deepseek") {
      const client = await getDeepSeekClient();
      // DeepSeek: создаём сессию и отправляем completion.
      const sessionId = await client.createSession();

      if (body.stream === true) {
        return handleDeepSeekStream(client, sessionId, prompt, modelName, mapping.model, res);
      }

      const result = await client.complete({
        sessionId,
        prompt,
        modelType: mapping.model,
      });
      return sendJson(res, toOpenAIResponse(modelName, result.text));
    }
    return sendError(res, 500, `Unknown provider: ${mapping.provider}`);
  } catch (e) {
    return sendError(res, 500, `Upstream error: ${e.message}`);
  }
}

// Отправка SSE-события в OpenAI формате.
function sendSseEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Формирует SSE-чанк в OpenAI формате.
function toOpenAIStreamChunk(model, textDelta, isFirst = false) {
  const ts = Math.floor(Date.now() / 1000);
  const chunk = {
    id: `chatcmpl-${ts}${Math.random().toString(36).slice(2, 10)}`,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: isFirst ? { role: "assistant" } : { content: textDelta } }],
  };
  return chunk;
}

// Обработка streaming-запроса к Qwen.
async function handleQwenStream(client, chatId, prompt, modelName, model, res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const parser = new StreamParser(modelName, res);
  try {
    await client.complete({
      chatId,
      prompt,
      thinking: false,
      search: false,
      model,
      onText: (textDelta) => parser.onText(textDelta),
    });
    parser.onEnd();
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
}

// Обработка streaming-запроса к DeepSeek.
async function handleDeepSeekStream(client, sessionId, prompt, modelName, model, res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const parser = new StreamParser(modelName, res);
  try {
    await client.complete({
      sessionId,
      prompt,
      modelType: model,
      onText: (textDelta) => parser.onText(textDelta),
    });
    parser.onEnd();
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
}

// Формат OpenAI chat completion response.
function toOpenAIResponse(model, text) {
  const ts = Math.floor(Date.now() / 1000);
  
  let tool_calls = undefined;
  let content = text;
  let finish_reason = "stop";

  const idx = text.indexOf("```tool_calls");
  if (idx !== -1) {
    const firstBracket = text.indexOf("[", idx);
    const lastBracket = text.lastIndexOf("]");
    
    let jsonStr = "";
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket) {
      jsonStr = text.slice(firstBracket, lastBracket + 1);
      content = text.slice(0, idx).trim();
    }

    if (jsonStr) {
      try {
        let calls = JSON.parse(jsonStr);
        if (!Array.isArray(calls)) calls = [calls];
        tool_calls = calls.map((call, i) => ({
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: {
            name: call.name,
            arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments)
          }
        }));
        finish_reason = "tool_calls";
      } catch (e) {
        try {
           let fixedJson = jsonStr.trim();
           if (fixedJson.startsWith('[\n') || fixedJson.startsWith('[')) {
              fixedJson = fixedJson.replace(/\[\s*"name"/g, '[{"name"');
              fixedJson = fixedJson.replace(/}\s*\]/g, '}]');
           }
           let calls = JSON.parse(fixedJson);
           if (!Array.isArray(calls)) calls = [calls];
           tool_calls = calls.map((call, i) => ({
             id: `call_${Math.random().toString(36).slice(2, 10)}`,
             type: "function",
             function: {
               name: call.name,
               arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments)
             }
           }));
           finish_reason = "tool_calls";
        } catch (e2) {
           console.error("[API] Error parsing tool calls from non-streaming response:", e.message);
        }
      }
    }
  }

  return {
    id: `chatcmpl-${ts}${Math.random().toString(36).slice(2, 10)}`,
    object: "chat.completion",
    created: ts,
    model,
    choices: [
      {
        index: 0,
        message: { 
          role: "assistant", 
          content,
          ...(tool_calls ? { tool_calls } : {})
        },
        finish_reason,
      },
    ],
    // Реальные usage-метрики у нас не доступны, ставим заглушку.
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sendJson(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, { error: { message, type: "invalid_request_error" } }, status);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

class StreamParser {
  constructor(modelName, res) {
    this.modelName = modelName;
    this.res = res;
    this.buffer = "";
    this.isTools = false;
    this.toolsBuffer = "";
    this.first = true;
    this.id = `chatcmpl-${Math.floor(Date.now() / 1000)}${Math.random().toString(36).slice(2, 10)}`;
  }

  onText(textDelta) {
    if (this.first) {
      this.sendChunk({ role: "assistant" }, true);
      this.first = false;
    }

    if (!this.isTools) {
      this.buffer += textDelta;
      
      // Look for multiple tool block indicators
      const idx = this.buffer.indexOf("```tool_calls");
      const idxJson = this.buffer.indexOf("```json");

      if (idx !== -1 || idxJson !== -1) {
        this.isTools = true;
        const actualIdx = idx !== -1 ? idx : idxJson;
        const offset = idx !== -1 ? 13 : 7;

        const before = this.buffer.slice(0, actualIdx);
        if (before) {
          this.sendChunk({ content: before });
        }
        this.toolsBuffer = this.buffer.slice(actualIdx + offset);
      } else {
        if (this.buffer.length > 20) {
          const toEmit = this.buffer.slice(0, -15);
          if (toEmit) {
            this.sendChunk({ content: toEmit });
            this.buffer = this.buffer.slice(-15);
          }
        }
      }
    } else {
      this.toolsBuffer += textDelta;
    }
  }

  onEnd() {
    if (!this.isTools && this.buffer) {
      // Just in case it never closes or emits normal text
      this.sendChunk({ content: this.buffer });
    } else if (this.isTools) {
      // Sometimes the model outputs extra text before the array, like "[ASSISTANT]```tool_calls ["
      // Let's extract everything from the first '[' to the last ']'.
      let jsonStr = this.toolsBuffer;
      
      const firstBracket = jsonStr.indexOf("[");
      const lastBracket = jsonStr.lastIndexOf("]");
      
      if (firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket) {
        jsonStr = jsonStr.slice(firstBracket, lastBracket + 1);
      } else {
        // Fallback cleanup if brackets are missing
        jsonStr = jsonStr.replace(/```\s*$/, "").trim();
        if (!jsonStr.startsWith("[")) jsonStr = "[" + jsonStr;
        if (!jsonStr.endsWith("]")) jsonStr = jsonStr + "]";
      }
      
      // Some models (DeepSeek Reasoner) drop random text inside the markdown block
      // like "[ASSIGNMENT]" or just plain text at the end.
      // Another common mistake: multiple JSON blocks concatenated like:
      // [ ... ] \n\n [ ... ] 
      // If we sliced from first [ to last ], we might get: [ ... ] \n\n [ ... ]
      // Which is invalid JSON.
      // We will try to parse it, and if it fails, try some aggressive cleanup.
      try {
        // Try strict parsing first, then fallback to safe newline escaping
        let strictJson = jsonStr.replace(/\\n/g, "\\\\n").replace(/\n/g, "\\n").replace(/\r/g, "");
        let calls = JSON.parse(strictJson);
        if (!Array.isArray(calls)) calls = [calls];
        
        console.log(`[API] Parsed streaming tool calls: ${calls.length}`);
        
        calls.forEach((call, index) => {
            this.sendChunk({
              tool_calls: [{
                index,
                id: `call_${Math.random().toString(36).slice(2, 10)}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments)
                }
              }]
            });
        });
      } catch (e) {
        try {
          let fixedJson = jsonStr.trim();
          
          // Let's first check if there are multiple top-level arrays.
          // E.g. [ { "name": "read" } ] [ { "name": "grep" } ]
          // A simple way is to wrap everything in [] and replace ][ with ],[
          // Then flatten.
          fixedJson = fixedJson.replace(/\]\s*\[/g, '],[');
          fixedJson = fixedJson.replace(/\][^\[]*\[/g, '],['); // remove any text between arrays
          
          if (fixedJson.includes('],[')) {
            if (!fixedJson.startsWith('[')) fixedJson = '[' + fixedJson;
            if (!fixedJson.endsWith(']')) fixedJson = fixedJson + ']';
          }

          if (fixedJson.startsWith('[\n') || fixedJson.startsWith('[')) {
             // Let's do a simple regex check if it's missing {
          fixedJson = fixedJson.replace(/\[\s*"name"/g, '[{"name"');
          // fixedJson = fixedJson.replace(/}\s*\]/g, '}]'); // removing this to avoid closing array issues
          fixedJson = fixedJson.replace(/\[\n\s*"name"/g, '[\n  {"name"');
          }
          // Another reasoner mistake: multiple objects without comma
          // e.g. [ { "name": "grep" ... } { "name": "read" ... } ]
          fixedJson = fixedJson.replace(/}\s*{/g, '}, {');
          // Also another mistake: [ "name": "read", "arguments": { ... } ] (missing { })
          // If we see [ "name" we can replace it with [ {"name"
          fixedJson = fixedJson.replace(/\[\s*"name"/g, '[ {"name"');
          // If it ends with string or number and then ], it needs closing brace
          // fixedJson = fixedJson.replace(/(["\da-zA-Z])\s*\]$/, '$1}]');

          // Reasoner may put literal unescaped newlines in content which causes JSON.parse to fail.
          // We can replace them with \n using a safe function
          fixedJson = fixedJson.replace(/\\n/g, "\\\\n"); // double escape already escaped newlines
          fixedJson = fixedJson.replace(/\n/g, "\\n").replace(/\r/g, ""); // escape literal newlines

          // One more bug with DeepSeek Reasoner: it might use double arrays like [[{...}]] due to our wrapping above.
          // JSON.parse will handle it, and flat(Infinity) will flatten it.
          
          let calls = JSON.parse(fixedJson);
          if (!Array.isArray(calls)) calls = [calls];
          // Flatten if we wrapped it
          calls = calls.flat(Infinity);
          
          console.log(`[API] Parsed streaming tool calls (after brace fix): ${calls.length}`);
          
          calls.forEach((call, index) => {
            this.sendChunk({
              tool_calls: [{
                index,
                id: `call_${Math.random().toString(36).slice(2, 10)}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments)
                }
              }]
            });
          });
        } catch (e2) {
          console.error("[API] Error parsing tool calls from streaming response:", e2.message);
          console.error("[API] Problematic JSON string was:\n", jsonStr);
          // Fallback: send as normal text so the UI doesn't hang completely
          this.sendChunk({ content: "\n[Error parsing tool call JSON from model]\n" + jsonStr });
        }
      }
    }
  }

  sendChunk(delta, isFirst = false) {
    const chunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.modelName,
      choices: [{ index: 0, delta }],
    };
    sendSseEvent(this.res, chunk);
    if (this.res.flush) this.res.flush();
  }
}
