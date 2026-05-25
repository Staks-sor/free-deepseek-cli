// Менеджер сессии Qwen — по аналогии с src/auth/manager.mjs (DeepSeek).
//
// Цепочка при протухшей сессии:
//   1. Тихий refresh из persistent-профиля (~/.qwen-cli/browser-profile)
//   2. Если не вышло — видимое окно login (npm run login-qwen)
//
// После любого успешного refresh сбрасываем browser-proxy, чтобы подхватил свежие куки.

import fs from "node:fs";
import { QWEN_AUTH_FILE, QWEN_BROWSER_PROFILE } from "./config.mjs";
import { readQwenAuth } from "./auth-files.mjs";
import { loginQwenAndSave, refreshQwenAuthFromProfile } from "./browser-login.mjs";
import { resetQwenBrowserProxy } from "./browser-proxy.mjs";

export class QwenAuthManager {
  constructor({ authFile = QWEN_AUTH_FILE, debug = false, autoVisible = true } = {}) {
    this.authFile = authFile;
    this.debug = debug;
    this.autoVisible = autoVisible;
    this._inFlight = null;
    this._consecutiveFailures = 0;
  }

  async refresh({ forceVisible = false } = {}) {
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._doRefresh({ forceVisible }).finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  async _doRefresh({ forceVisible = false } = {}) {
    if (!forceVisible && fs.existsSync(this.authFile)) {
      try {
        if (this.debug) console.error("[qwen-auth] trying silent refresh from profile…");
        const auth = await refreshQwenAuthFromProfile(this.authFile);
        resetQwenBrowserProxy();
        this._consecutiveFailures = 0;
        console.log("🔄 Qwen auth refreshed silently from saved profile.");
        return auth;
      } catch (error) {
        if (this.debug) console.error(`[qwen-auth] silent refresh failed: ${error.message}`);
      }
    }

    if (!this.autoVisible) {
      throw new Error(
        "Qwen session invalid and visible re-login disabled. Run: npm run login-qwen",
      );
    }

    this._consecutiveFailures += 1;
    if (this._consecutiveFailures > 3) {
      throw new Error("Too many failed Qwen re-login attempts. Aborting to avoid loop.");
    }

    console.log("\n🔒 Qwen session expired or missing. Opening login window (chat.qwen.ai)…");
    const auth = await loginQwenAndSave(this.authFile);
    resetQwenBrowserProxy();
    this._consecutiveFailures = 0;
    console.log("✅ Qwen re-login completed.");
    return auth;
  }
}

let defaultManager = null;

export function getQwenAuthManager(options = {}) {
  if (!defaultManager) {
    defaultManager = new QwenAuthManager({
      debug: Boolean(process.env.DEEPSEEK_DEBUG_QWEN),
      autoVisible: options.autoVisible !== false,
      ...options,
    });
  }
  return defaultManager;
}

export function isQwenAuthConfigured() {
  const auth = readQwenAuth(QWEN_AUTH_FILE);
  return Boolean(auth?.token);
}

export function isQwenAuthError(error) {
  if (!error) return false;
  if (error.isAuthError) return true;
  const msg = String(error.message || "");
  const status = error.status || error.httpStatus;
  if (status === 401 || status === 403) return true;
  return /(?:^|\s)(401|403)(?:\s|$)/.test(msg)
    || /unauthorized|not.?logged|login required|please log in|sign.?in|auth(?:entication)? failed/i.test(msg);
}
