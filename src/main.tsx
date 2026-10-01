import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles.css";
import { applyTheme } from "./ui/theme";
import { enableRollback } from "./data/store";

applyTheme(); // before first paint, so there is no flash of the wrong theme
enableRollback(); // a change that fails part way leaves nothing behind

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
