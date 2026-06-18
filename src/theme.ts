export type Theme = "light" | "dark";

const KEY = "hydrus-client-theme";

export function loadTheme(): Theme {
  return localStorage.getItem(KEY) === "dark" ? "dark" : "light"; // по умолчанию светлая
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

export function saveTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
}
