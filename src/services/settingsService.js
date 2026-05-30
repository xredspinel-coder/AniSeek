import { db } from "../firebaseAdmin.js";
import { defaultSettings, settingsCacheTTL } from "../config/defaultSettings.js";
import { clone, isFresh } from "../utils/cache.js";

let cachedSettings = null;
let lastSettingsFetchAt = 0;

function asBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numberValue));
}

function normalizeSettings(raw = {}) {
  return {
    dailyLimit: Math.floor(asNumber(raw.dailyLimit, defaultSettings.dailyLimit, { min: 0 })),
    similarityThreshold: asNumber(raw.similarityThreshold, defaultSettings.similarityThreshold, {
      min: 0,
      max: 100
    }),
    enableTwitter: asBoolean(raw.enableTwitter, defaultSettings.enableTwitter),
    enableReddit: asBoolean(raw.enableReddit, defaultSettings.enableReddit),
    enableFacebook: asBoolean(raw.enableFacebook, defaultSettings.enableFacebook),
    enableVideoPreview: asBoolean(raw.enableVideoPreview, defaultSettings.enableVideoPreview),
    maintenanceMode: asBoolean(raw.maintenanceMode, defaultSettings.maintenanceMode)
  };
}

export async function getSettings({ forceRefresh = false } = {}) {
  const now = Date.now();

  if (!forceRefresh && cachedSettings && isFresh(lastSettingsFetchAt, settingsCacheTTL, now)) {
    return clone(cachedSettings);
  }

  try {
    const snapshot = await db.collection("settings").doc("global").get();
    cachedSettings = snapshot.exists
      ? normalizeSettings({ ...defaultSettings, ...snapshot.data() })
      : clone(defaultSettings);
    lastSettingsFetchAt = now;
  } catch (error) {
    console.error("Failed to read settings/global. Falling back to cached/default settings.", error);
    cachedSettings = cachedSettings || clone(defaultSettings);
    lastSettingsFetchAt = now;
  }

  return clone(cachedSettings);
}

export function clearSettingsCache() {
  cachedSettings = null;
  lastSettingsFetchAt = 0;
}

export { defaultSettings, settingsCacheTTL };
