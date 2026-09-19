// Run before the stylesheet and interface paint, including the sign-in screen.
(() => {
  const key = "foreman:appearance";
  const choices = new Set(["system", "light", "dark"]);
  const system = matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  try {
    const saved = localStorage.getItem(key);
    if (choices.has(saved)) preference = saved;
  } catch { /* Appearance remains usable when storage is unavailable. */ }
  function apply() {
    const theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#111b16" : "#f8faf8";
    document.querySelectorAll("[data-appearance]").forEach((control) => { control.value = preference; });
  }
  apply();
  system.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", apply);
  document.addEventListener("change", (event) => {
    if (!event.target.matches("[data-appearance]") || !choices.has(event.target.value)) return;
    preference = event.target.value;
    try { localStorage.setItem(key, preference); } catch { /* Optional persistence. */ }
    apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== key && event.key !== null) return;
    preference = choices.has(event.newValue) ? event.newValue : "system";
    apply();
  });
})();
