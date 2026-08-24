import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";

// StrictMode is intentionally off here — framer-motion's AnimatePresence
// with mode="wait" gets tangled up with the double-invoke of state
// setters that StrictMode does in dev, and leaves screens visually
// stuck on state transitions.
createRoot(document.getElementById("root")!).render(<App />);
