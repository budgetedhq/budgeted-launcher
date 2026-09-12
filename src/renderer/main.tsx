import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initializeAuth } from "./auth";
import "./styles.css";

void initializeAuth().then(({ authenticated }) => {
  createRoot(document.getElementById("root")!).render(<StrictMode><App authenticated={authenticated} /></StrictMode>);
}).catch((error) => {
  document.getElementById("root")!.textContent = error instanceof Error ? error.message : "Budgeted Launcher could not start.";
});
