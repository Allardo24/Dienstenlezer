import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isIngressPath } from "./serverUrl";
import "./styles.css";

const preloadReloadKey = "dienstenlezer:preload-reload-at";
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const lastReload = Number(window.sessionStorage.getItem(preloadReloadKey) ?? 0);
  if (Date.now() - lastReload < 30_000) return;
  window.sessionStorage.setItem(preloadReloadKey, String(Date.now()));
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (
  import.meta.env.PROD
  && !isIngressPath()
  && "serviceWorker" in navigator
) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
