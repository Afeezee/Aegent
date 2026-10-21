import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";

// Apply the user's theme choice before React mounts so the first
// paint is already in the right mode (no light-flash on a dark app).
// Choices: "dark", "light", or absent (follow system preference).
try {
  const t = localStorage.getItem("aegent.theme");
  if (t === "dark" || t === "light") {
    document.documentElement.setAttribute("data-theme", t);
  }
} catch { /* storage disabled; follow system */ }

// StrictMode is intentionally off here — framer-motion's AnimatePresence
// with mode="wait" gets tangled up with the double-invoke of state
// setters that StrictMode does in dev, and leaves screens visually
// stuck on state transitions.
createRoot(document.getElementById("root")!).render(<App />);
