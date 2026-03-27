(() => {
  const DEBUG = true;
  // Use MAX web deeplink by phone. In practice this resolves dialog better than direct web.max.ru links.
  const MAX_LINK_BASE = "https://max.ru";
  // Use `apiUrl` from GREEN-API console ("Параметры доступа к инстансу").
  const GREEN_API_URL = "https://api.green-api.com";
  const GREEN_API_ID_INSTANCE = "3100566213";
  const GREEN_API_TOKEN_INSTANCE = "3997f21706854e4f88c96d08be62b47fd8f3dbccedd6408bb2";

  // Optional async lookup endpoint template.
  // Use {phone} placeholder with normalized digits format: 7XXXXXXXXXX
  // Example: https://your-domain/max/lookup?phone={phone}
  // Expected JSON (one of): {"found":true} | {"exists":true} | {"isRegistered":true}
  // If empty, status defaults to "unknown" (gray icon).
  const MAX_LOOKUP_URL_TEMPLATE = "";

  const PHONE_REGEX = /(?:\+7|8)\s*\(?\d{3}\)?[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;
  const PHONE_TEST_REGEX = /(?:\+7|8)\s*\(?\d{3}\)?[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/;
  const SCAN_SELECTOR = "td.col-lg-7 small";
  const LINK_CLASS = "max-contact-link";
  const STYLES_ID = "max-ext-styles";
  const LOOKUP_CACHE = new Map();
  const STORAGE_DEEP_LINKS_KEY = "maxDeepLinksByPhone";
  const STORAGE_PENDING_PHONE_KEY = "maxPendingPhone";
  const STORAGE_LAST_SYNC_KEY = "maxCloudLastSyncAt";
  const STORAGE_GITHUB_TOKEN_KEY = "maxCloudApiToken";
  const STORAGE_CLOUD_BASE_URL_KEY = "maxCloudBaseUrl";

  // Cloudflare Worker API base URL.
  const CLOUD_API_BASE_URL = "https://max-links-api.afanasevvlad829.workers.dev";
  const GITHUB_TOKEN = "";
  let githubTokenRuntime = (GITHUB_TOKEN || "").trim();
  let cloudBaseUrlRuntime = CLOUD_API_BASE_URL;

  function log(...args) {
    if (!DEBUG) return;
    console.log("[MAX-EXT]", ...args);
  }

  function hasGithubConfig() {
    return Boolean((cloudBaseUrlRuntime || "").trim());
  }

  function hasGithubToken() {
    return Boolean(githubTokenRuntime);
  }

  function normalizeGithubToken(raw) {
    return String(raw || "").trim().replace(/^["']|["']$/g, "");
  }

  function isCrmPage() {
    return /codim\.s20\.online$/.test(location.hostname);
  }

  function isMaxPage() {
    return /(^|\.)max\.ru$/.test(location.hostname);
  }

  function getStorageArea() {
    if (typeof chrome !== "undefined" && chrome?.storage?.local) return chrome.storage.local;
    return null;
  }

  async function storageGet(key) {
    const storage = getStorageArea();
    if (!storage) return null;
    return new Promise((resolve) => {
      storage.get([key], (result) => resolve(result?.[key] ?? null));
    });
  }

  async function storageSet(objectValue) {
    const storage = getStorageArea();
    if (!storage) return;
    return new Promise((resolve) => {
      storage.set(objectValue, () => resolve());
    });
  }

  async function hydrateGithubTokenFromStorage() {
    const stored = await storageGet(STORAGE_GITHUB_TOKEN_KEY);
    if (typeof stored === "string" && stored.trim()) {
      githubTokenRuntime = stored.trim();
    }
    const storedBaseUrl = await storageGet(STORAGE_CLOUD_BASE_URL_KEY);
    if (typeof storedBaseUrl === "string" && storedBaseUrl.trim()) {
      cloudBaseUrlRuntime = storedBaseUrl.trim();
    }
  }

  async function setGithubToken(tokenValue) {
    const token = normalizeGithubToken(tokenValue);
    githubTokenRuntime = token;
    await storageSet({ [STORAGE_GITHUB_TOKEN_KEY]: token });
  }

  async function setCloudBaseUrl(baseUrlValue) {
    const nextValue = String(baseUrlValue || "").trim().replace(/\/+$/, "");
    cloudBaseUrlRuntime = nextValue;
    await storageSet({ [STORAGE_CLOUD_BASE_URL_KEY]: nextValue });
  }

  function ensureObjectMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  }

  async function getDeepLinkMap() {
    return ensureObjectMap(await storageGet(STORAGE_DEEP_LINKS_KEY));
  }

  async function getSavedDeepLinkByPhone(phoneE164Digits) {
    if (!phoneE164Digits) return "";
    const map = await getDeepLinkMap();
    const localValue = typeof map[phoneE164Digits] === "string" ? map[phoneE164Digits] : "";
    if (localValue) return localValue;

    if (!hasGithubConfig() || !hasGithubToken()) return "";
    const cloudResult = await cloudReadLink(phoneE164Digits);
    if (!cloudResult.ok || !cloudResult.found || !cloudResult.deepLink) return "";

    await saveDeepLinkByPhone(phoneE164Digits, cloudResult.deepLink);
    return cloudResult.deepLink;
  }

  async function saveDeepLinkByPhone(phoneE164Digits, deepLink) {
    if (!phoneE164Digits || !deepLink) return;
    const map = await getDeepLinkMap();
    map[phoneE164Digits] = deepLink;
    await storageSet({ [STORAGE_DEEP_LINKS_KEY]: map });
  }

  async function getPendingPhone() {
    const value = await storageGet(STORAGE_PENDING_PHONE_KEY);
    return typeof value === "string" ? value : "";
  }

  async function setPendingPhone(phoneE164Digits) {
    await storageSet({ [STORAGE_PENDING_PHONE_KEY]: phoneE164Digits || "" });
  }

  function cloudApiUrl(path, params = null) {
    const base = (cloudBaseUrlRuntime || "").replace(/\/+$/, "");
    const cleanPath = String(path || "").replace(/^\/+/, "");
    const url = new URL(`${base}/${cleanPath}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async function cloudFetchJson(path, options = {}, params = null) {
    const headers = {
      Accept: "application/json",
      ...options.headers
    };
    if (hasGithubToken()) headers["x-api-key"] = githubTokenRuntime;

    const response = await fetch(cloudApiUrl(path, params), {
      ...options,
      headers
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    return { response, body };
  }

  async function githubValidateToken() {
    if (!hasGithubToken()) return { ok: false, reason: "api-token-missing" };
    try {
      const { response, body } = await cloudFetchJson("links", { method: "GET" }, { phone: "70000000000" });
      if (!response.ok) return { ok: false, reason: body?.error || `api-auth-failed-${response.status}` };
      return { ok: true, login: "cloudflare-api" };
    } catch (error) {
      return { ok: false, reason: `network-error: ${error?.message || "unknown"}` };
    }
  }

  async function cloudReadLink(phoneE164Digits) {
    if (!hasGithubConfig()) return { ok: false, reason: "api-not-configured" };
    if (!hasGithubToken()) return { ok: false, reason: "api-token-missing" };

    const { response, body } = await cloudFetchJson("links", { method: "GET" }, { phone: phoneE164Digits });
    if (!response.ok) {
      return { ok: false, reason: body?.error || `api-read-failed-${response.status}` };
    }

    return {
      ok: Boolean(body?.ok),
      reason: body?.error || "ok",
      found: Boolean(body?.found),
      deepLink: String(body?.deepLink || "")
    };
  }

  async function cloudWriteLink(phoneE164Digits, deepLink) {
    if (!hasGithubConfig()) return { ok: false, reason: "api-not-configured" };
    if (!hasGithubToken()) return { ok: false, reason: "api-token-missing" };

    const { response, body } = await cloudFetchJson("links", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: phoneE164Digits, deepLink })
    });
    if (!response.ok) {
      return { ok: false, reason: body?.error || `api-write-failed-${response.status}` };
    }

    await storageSet({ [STORAGE_LAST_SYNC_KEY]: Date.now() });
    return { ok: true, reason: "ok" };
  }

  async function syncFromGithubIntoLocal(phoneE164Digits) {
    const remote = await cloudReadLink(phoneE164Digits);
    if (!remote.ok) return remote;
    if (!remote.found || !remote.deepLink) return { ok: true, reason: "ok", count: 0 };

    const map = await getDeepLinkMap();
    map[phoneE164Digits] = remote.deepLink;
    await storageSet({
      [STORAGE_DEEP_LINKS_KEY]: map,
      [STORAGE_LAST_SYNC_KEY]: Date.now()
    });
    return { ok: true, reason: "ok", count: 1 };
  }

  async function syncLocalIntoGithub(phoneE164Digits, deepLink) {
    const writeResult = await cloudWriteLink(phoneE164Digits, deepLink);
    if (!writeResult.ok) return writeResult;
    return { ok: true, reason: "ok", count: 1 };
  }

  function normalizePhone(raw) {
    const digits = (raw || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
    if (digits.length === 11 && digits.startsWith("7")) return digits;
    return "";
  }

  function buildMaxHref(phoneE164Digits) {
    return `${MAX_LINK_BASE}/+${phoneE164Digits}`;
  }

  function buildLookupUrl(phoneE164Digits) {
    if (!MAX_LOOKUP_URL_TEMPLATE) return "";
    return MAX_LOOKUP_URL_TEMPLATE.replace("{phone}", encodeURIComponent(phoneE164Digits));
  }

  function buildGreenApiCheckAccountUrl() {
    if (!GREEN_API_URL || !GREEN_API_ID_INSTANCE || !GREEN_API_TOKEN_INSTANCE) return "";
    const apiBase = GREEN_API_URL.replace(/\/+$/, "");
    return `${apiBase}/waInstance${GREEN_API_ID_INSTANCE}/checkAccount/${GREEN_API_TOKEN_INSTANCE}`;
  }

  function setIconStatus(icon, status) {
    // pending -> amber, found -> green, missing/error -> red, unknown -> gray
    if (status === "pending") {
      icon.style.background = "#d4a017";
      icon.title = "Проверка номера в Max...";
      return;
    }

    if (status === "found") {
      icon.style.background = "#2ea44f";
      icon.title = "Номер найден в Max";
      return;
    }

    if (status === "unknown") {
      icon.style.background = "#8f9aa8";
      icon.title = "Проверка Max временно недоступна";
      return;
    }

    icon.style.background = "#d93025";
    icon.title = "Номер не найден в Max";
  }

  async function checkPhoneInMax(phoneE164Digits) {
    const lookupUrl = buildLookupUrl(phoneE164Digits);
    const greenApiUrl = buildGreenApiCheckAccountUrl();
    if (!lookupUrl && !greenApiUrl) return { found: null, chatId: "" };

    try {
      const response = lookupUrl
        ? await fetch(lookupUrl, {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store"
          })
        : await fetch(greenApiUrl, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json"
            },
            cache: "no-store",
            body: JSON.stringify({ phoneNumber: Number(phoneE164Digits) })
          });

      if (response.status === 404) return { found: false, chatId: "" };
      if (!response.ok) return { found: null, chatId: "" };

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) return { found: null, chatId: "" };

      const data = await response.json();
      const rawFound = data?.exist ?? data?.found ?? data?.exists ?? data?.isRegistered ?? data?.registered;
      if (typeof rawFound !== "boolean") return { found: null, chatId: "" };

      return {
        found: rawFound,
        chatId: String(data?.chatId || "")
      };
    } catch {
      return { found: null, chatId: "" };
    }
  }

  function checkPhoneInMaxCached(phoneE164Digits) {
    if (!phoneE164Digits) return Promise.resolve({ found: null, chatId: "" });
    if (!LOOKUP_CACHE.has(phoneE164Digits)) {
      LOOKUP_CACHE.set(phoneE164Digits, checkPhoneInMax(phoneE164Digits));
    }
    return LOOKUP_CACHE.get(phoneE164Digits);
  }

  function ensureStyles() {
    if (document.getElementById(STYLES_ID)) return;
    const style = document.createElement("style");
    style.id = STYLES_ID;
    style.textContent = `
      .${LINK_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 2px;
        margin-left: 6px;
        text-decoration: none;
        vertical-align: middle;
      }

      .${LINK_CLASS} .max-icon {
        display: inline-flex;
        width: 16px;
        height: 16px;
        border-radius: 2px;
        color: #fff;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function tuneLinkForWhatsAppLook(link, waRef) {
    if (!waRef) return;

    // Copy geometry from WhatsApp icon to get near pixel-perfect visual match.
    const waRect = waRef.getBoundingClientRect();
    const waStyle = window.getComputedStyle(waRef);
    const icon = link.querySelector(".max-icon");
    if (!icon) return;

    if (waRect.width > 0 && waRect.height > 0) {
      link.style.width = `${Math.round(waRect.width)}px`;
      link.style.height = `${Math.round(waRect.height)}px`;
      icon.style.width = `${Math.round(waRect.width)}px`;
      icon.style.height = `${Math.round(waRect.height)}px`;
    }

    if (waStyle.borderRadius) {
      link.style.borderRadius = waStyle.borderRadius;
      icon.style.borderRadius = waStyle.borderRadius;
    }

    link.style.marginLeft = "4px";
  }

  function createMaxLink(phoneE164Digits, waRef = null) {
    const link = document.createElement("a");
    link.className = LINK_CLASS;
    link.href = buildMaxHref(phoneE164Digits);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "Связаться по Max");
    link.title = "Открыть чат в Max";

    const icon = document.createElement("span");
    icon.className = "max-icon";
    icon.textContent = "M";
    setIconStatus(icon, "pending");
    link.append(icon);
    tuneLinkForWhatsAppLook(link, waRef);

    getSavedDeepLinkByPhone(phoneE164Digits)
      .then((savedLink) => {
        if (savedLink) {
          link.href = savedLink;
          link.title = "Открыть сохраненный диалог в Max";
          link.dataset.maxSavedLink = "1";
        }
      })
      .catch(() => {});

    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const savedLink = await getSavedDeepLinkByPhone(phoneE164Digits);
      const targetHref = savedLink || buildMaxHref(phoneE164Digits);
      await setPendingPhone(phoneE164Digits);
      window.open(targetHref, "_blank", "noopener,noreferrer");
    });

    checkPhoneInMaxCached(phoneE164Digits)
      .then((result) => {
        if (!result || result.found === null) {
          setIconStatus(icon, "unknown");
          return;
        }

        setIconStatus(icon, result.found ? "found" : "missing");

        if (result.found && result.chatId) {
          // Keep MAX web deeplink by phone. GREEN-API chatId (100...) and MAX web chat URL id
          // can belong to different namespaces.
          link.dataset.maxChatId = result.chatId;
          link.dataset.maxCusChatId = `${phoneE164Digits}@c.us`;
          log("chat id received", { phoneE164Digits, chatId: result.chatId });
        }
      })
      .catch(() => setIconStatus(icon, "unknown"));

    return link;
  }

  function showMaxCaptureToast(text) {
    const existing = document.getElementById("max-ext-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.id = "max-ext-toast";
    toast.style.display = "flex";
    toast.style.gap = "8px";
    toast.style.alignItems = "flex-start";
    toast.style.position = "fixed";
    toast.style.right = "16px";
    toast.style.bottom = "16px";
    toast.style.zIndex = "2147483647";
    toast.style.padding = "10px 12px";
    toast.style.borderRadius = "8px";
    toast.style.background = "#111827";
    toast.style.color = "#fff";
    toast.style.fontSize = "12px";
    toast.style.boxShadow = "0 8px 20px rgba(0,0,0,0.3)";

    const message = document.createElement("div");
    message.textContent = text;
    message.style.whiteSpace = "pre-wrap";
    message.style.wordBreak = "break-word";
    message.style.maxWidth = "320px";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Закрыть уведомление");
    closeButton.style.border = "0";
    closeButton.style.background = "transparent";
    closeButton.style.color = "#fff";
    closeButton.style.cursor = "pointer";
    closeButton.style.fontSize = "14px";
    closeButton.style.lineHeight = "1";
    closeButton.style.padding = "0 2px";
    closeButton.onclick = () => toast.remove();

    toast.appendChild(message);
    toast.appendChild(closeButton);
    document.body.appendChild(toast);
  }

  function isLikelyDialogDeepLink(urlValue) {
    try {
      const parsed = new URL(urlValue);
      if (!/(^|\.)max\.ru$/.test(parsed.hostname)) return false;
      const path = parsed.pathname || "/";
      // Common dialog URL shapes observed in MAX web clients:
      // /3940279 or /c/3940279[/messageId]
      if (/^\/\d+(?:\/\d+)?$/.test(path)) return true;
      if (/^\/c\/\d+(?:\/\d+)?$/.test(path)) return true;
      return false;
    } catch {
      return false;
    }
  }

  function tryFillMaxSearch(phoneE164Digits) {
    if (!phoneE164Digits) return false;
    const selectors = [
      "input[type='search']",
      "input[placeholder*='Поиск']",
      "input[placeholder*='поиск']",
      "input[aria-label*='Поиск']",
      "input[aria-label*='поиск']",
      "input[name*='search']"
    ];

    for (const selector of selectors) {
      const input = document.querySelector(selector);
      if (!input) continue;
      input.focus();
      input.value = `+${phoneE164Digits}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    }
    return false;
  }

  function renderMaxCapturePanel(phoneE164Digits) {
    if (!phoneE164Digits) return;
    let panel = document.getElementById("max-ext-capture-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "max-ext-capture-panel";
      panel.style.position = "fixed";
      panel.style.right = "16px";
      panel.style.top = "16px";
      panel.style.zIndex = "2147483647";
      panel.style.maxWidth = "320px";
      panel.style.padding = "12px";
      panel.style.background = "#ffffff";
      panel.style.border = "1px solid #d1d5db";
      panel.style.borderRadius = "10px";
      panel.style.boxShadow = "0 10px 30px rgba(0,0,0,0.15)";
      panel.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
      panel.innerHTML = `
        <div style="font-size:12px;color:#111827;font-weight:600;margin-bottom:6px;">MAX Link Capture</div>
        <div id="max-ext-capture-phone" style="font-size:12px;color:#374151;margin-bottom:10px;"></div>
        <div id="max-ext-actions" style="display:flex;gap:6px;flex-wrap:wrap;">
          <button id="max-ext-fill" type="button" style="font-size:12px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;cursor:pointer;">Вставить в поиск</button>
          <button id="max-ext-save" type="button" style="font-size:12px;padding:6px 8px;border:1px solid #16a34a;border-radius:6px;background:#16a34a;color:#fff;cursor:pointer;">Сохранить ссылку</button>
          <button id="max-ext-clear" type="button" style="font-size:12px;padding:6px 8px;border:1px solid #e5e7eb;border-radius:6px;background:#fff;cursor:pointer;">Закрыть</button>
        </div>
      `;
      document.body.appendChild(panel);
    }

    const phoneText = panel.querySelector("#max-ext-capture-phone");
    if (phoneText) phoneText.textContent = `Номер: +${phoneE164Digits}`;

    const fillButton = panel.querySelector("#max-ext-fill");
    const saveButton = panel.querySelector("#max-ext-save");
    const clearButton = panel.querySelector("#max-ext-clear");

    if (fillButton) {
      fillButton.onclick = () => {
        const found = tryFillMaxSearch(phoneE164Digits);
        showMaxCaptureToast(found ? "Номер вставлен в поиск" : "Поле поиска не найдено");
      };
    }

    if (saveButton) {
      saveButton.onclick = async () => {
        const url = location.href;
        await saveDeepLinkByPhone(phoneE164Digits, url);
        await setPendingPhone("");
        if (hasGithubToken()) {
          const pushResult = await syncLocalIntoGithub(phoneE164Digits, url);
          if (!pushResult.ok) {
            showMaxCaptureToast(`Локально сохранено, Cloud: ${pushResult.reason}`);
            return;
          }
        }
        showMaxCaptureToast("Ссылка сохранена для номера");
        panel.remove();
      };
    }

    if (clearButton) {
      clearButton.onclick = async () => {
        await setPendingPhone("");
        panel.remove();
      };
    }

    tryFillMaxSearch(phoneE164Digits);

    // Auto-save mode: once user opens a likely chat URL manually, save it immediately.
    let lastHref = location.href;
    const autoCaptureInterval = window.setInterval(async () => {
      const currentHref = location.href;
      if (currentHref === lastHref) return;
      lastHref = currentHref;

      if (!isLikelyDialogDeepLink(currentHref)) return;

      await saveDeepLinkByPhone(phoneE164Digits, currentHref);
      await setPendingPhone("");
      if (hasGithubToken()) {
        const pushResult = await syncLocalIntoGithub(phoneE164Digits, currentHref);
        if (!pushResult.ok) {
          showMaxCaptureToast(`Локально сохранено, Cloud: ${pushResult.reason}`);
          return;
        }
      }
      showMaxCaptureToast("Ссылка сохранена автоматически");
      panel.remove();
      window.clearInterval(autoCaptureInterval);
    }, 700);

    const buttonsWrap = panel.querySelector("#max-ext-actions");
    if (buttonsWrap && hasGithubConfig()) {
      const tokenButton = document.createElement("button");
      tokenButton.type = "button";
      tokenButton.textContent = hasGithubToken() ? "API key: задан" : "API key: задать";
      tokenButton.style.fontSize = "12px";
      tokenButton.style.padding = "6px 8px";
      tokenButton.style.border = "1px solid #0f766e";
      tokenButton.style.borderRadius = "6px";
      tokenButton.style.background = "#ecfeff";
      tokenButton.style.color = "#134e4a";
      tokenButton.style.cursor = "pointer";
      tokenButton.onclick = async () => {
        const entered = window.prompt("Вставьте Cloud API key (API_TOKEN из Worker):", githubTokenRuntime);
        if (entered === null) return;
        await setGithubToken(entered);
        tokenButton.textContent = hasGithubToken() ? "API key: задан" : "API key: задать";
        if (!hasGithubToken()) {
          showMaxCaptureToast("API key очищен");
          return;
        }
        const validation = await githubValidateToken();
        showMaxCaptureToast(
          validation.ok ? "Cloud API key валиден" : `Cloud API key ошибка: ${validation.reason}`
        );
      };

      const baseUrlButton = document.createElement("button");
      baseUrlButton.type = "button";
      baseUrlButton.textContent = "API URL";
      baseUrlButton.style.fontSize = "12px";
      baseUrlButton.style.padding = "6px 8px";
      baseUrlButton.style.border = "1px solid #1f2937";
      baseUrlButton.style.borderRadius = "6px";
      baseUrlButton.style.background = "#f9fafb";
      baseUrlButton.style.color = "#111827";
      baseUrlButton.style.cursor = "pointer";
      baseUrlButton.onclick = async () => {
        const entered = window.prompt("Укажите Cloud Worker URL:", cloudBaseUrlRuntime);
        if (entered === null) return;
        await setCloudBaseUrl(entered);
        showMaxCaptureToast(`API URL сохранен: ${cloudBaseUrlRuntime || "(пусто)"}`);
      };

      const checkTokenButton = document.createElement("button");
      checkTokenButton.type = "button";
      checkTokenButton.textContent = "Проверить API key";
      checkTokenButton.style.fontSize = "12px";
      checkTokenButton.style.padding = "6px 8px";
      checkTokenButton.style.border = "1px solid #0ea5e9";
      checkTokenButton.style.borderRadius = "6px";
      checkTokenButton.style.background = "#f0f9ff";
      checkTokenButton.style.color = "#0c4a6e";
      checkTokenButton.style.cursor = "pointer";
      checkTokenButton.onclick = async () => {
        const validation = await githubValidateToken();
        showMaxCaptureToast(
          validation.ok ? "Cloud API key валиден" : `Cloud API key ошибка: ${validation.reason}`
        );
      };
      buttonsWrap.appendChild(tokenButton);
      buttonsWrap.appendChild(checkTokenButton);
      buttonsWrap.appendChild(baseUrlButton);
    }
  }

  function getCandidateNodes(root) {
    if (!root || !root.querySelectorAll) return [];
    const strict = [...root.querySelectorAll(SCAN_SELECTOR)];
    if (strict.length) return strict;

    // Fallback for DOM variations in ALFACRM templates.
    return [...root.querySelectorAll("small")].filter((el) => {
      const text = (el.textContent || "").trim();
      if (!text || text.length > 220) return false;
      return PHONE_TEST_REGEX.test(text);
    });
  }

  function getPhoneFromText(text) {
    const matches = (text || "").match(PHONE_REGEX);
    if (!matches || !matches.length) return "";
    return normalizePhone(matches[0]);
  }

  function getWhatsAppElements(root) {
    if (!root || !root.querySelectorAll) return [];
    return [
      ...root.querySelectorAll(
        [
          "a[href*='wa.me']",
          "a[href*='whatsapp']",
          "a[href*='api.whatsapp.com']",
          "a[title*='WhatsApp']",
          "[class*='whatsapp']",
          ".fa-whatsapp",
          ".ion-social-whatsapp"
        ].join(",")
      )
    ];
  }

  function insertNearWhatsApp(root, processedPhones) {
    const waNodes = getWhatsAppElements(root);
    let inserted = 0;

    for (const wa of waNodes) {
      if (!wa || wa.closest(`.${LINK_CLASS}`)) continue;
      if (wa.parentElement && wa.parentElement.querySelector(`.${LINK_CLASS}`)) continue;

      const scope = wa.closest("tr, .row, td, li, div, section") || wa.parentElement || wa;
      const normalized = getPhoneFromText(scope.textContent || "");
      if (!normalized) continue;
      if (processedPhones.has(normalized)) continue;

      const link = createMaxLink(normalized);
      tuneLinkForWhatsAppLook(link, wa);
      wa.insertAdjacentElement("afterend", link);
      processedPhones.add(normalized);
      inserted += 1;
      log("link inserted near whatsapp", { normalized });
    }

    return inserted;
  }

  function upsertMaxLinks(root = document) {
    const processedPhones = new Set();
    const waInserted = insertNearWhatsApp(root, processedPhones);

    const nodes = getCandidateNodes(root);

    log("scan", {
      candidates: nodes.length,
      waInserted,
      url: location.href
    });

    for (const node of nodes) {
      if (node.querySelector(`.${LINK_CLASS}`)) continue;

      const text = node.textContent || "";
      const normalized = getPhoneFromText(text);
      if (!normalized) continue;
      if (processedPhones.has(normalized)) continue;
      processedPhones.add(normalized);

      node.appendChild(createMaxLink(normalized));
      log("link inserted", { normalized, text: text.slice(0, 120) });
    }
  }

  function startCrm() {
    hydrateGithubTokenFromStorage().catch(() => {});

    ensureStyles();
    log("start", {
      url: location.href,
      inIframe: window.self !== window.top
    });
    upsertMaxLinks(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          if (added.nodeType !== 1) continue;
          upsertMaxLinks(added);
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function startMax() {
    if (window.self !== window.top) return;
    const pendingPhone = await getPendingPhone();
    if (!pendingPhone) return;
    renderMaxCapturePanel(pendingPhone);
  }

  function start() {
    if (isCrmPage()) {
      startCrm();
      return;
    }

    if (isMaxPage()) {
      startMax().catch(() => {});
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
