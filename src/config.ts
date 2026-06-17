export interface Settings {
  /** Базовый URL Client API, напр. http://localhost:45869 */
  baseUrl: string;
  /** Access key, созданный в Hydrus (services → manage services → client api) */
  accessKey: string;
}

const STORAGE_KEY = "hydrus-client-settings";

const ENV_URL = import.meta.env.VITE_HYDRUS_URL?.trim();
const ENV_KEY = import.meta.env.VITE_HYDRUS_KEY?.trim();

/** Значения по умолчанию для формы (из .env, либо разумный дефолт). */
export const DEFAULTS: Settings = {
  baseUrl: ENV_URL || "http://localhost:45869",
  accessKey: ENV_KEY || "",
};

/** Готовые настройки из .env, если заданы и адрес, и ключ. */
function envSettings(): Settings | null {
  return ENV_URL && ENV_KEY ? { baseUrl: ENV_URL, accessKey: ENV_KEY } : null;
}

/** Приоритет: сохранённые в localStorage → .env → ничего (показать форму). */
export function loadSettings(): Settings | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as Settings;
    } catch {
      /* битые данные — игнорируем, упадём в .env */
    }
  }
  return envSettings();
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
