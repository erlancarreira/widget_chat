// Flat config (ESLint 9) com parser e regras de TypeScript.
// Referências: https://typescript-eslint.io/getting-started
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// Globals do ambiente de execução (Node para a bridge/API, browser para o widget),
// declarados explicitamente para não depender do pacote `globals`.
const nodeGlobals = {
  AbortController: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  queueMicrotask: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
};

const browserGlobals = {
  CustomEvent: "readonly",
  document: "readonly",
  HTMLElement: "readonly",
  MutationObserver: "readonly",
  navigator: "readonly",
  requestAnimationFrame: "readonly",
  window: "readonly",
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...nodeGlobals, ...browserGlobals },
    },
  },
);
