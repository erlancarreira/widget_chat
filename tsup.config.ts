import { defineConfig } from "tsup";

export default defineConfig([
  { entry: { index: "src/api/index.ts" }, outDir: "api", format: ["esm", "cjs"], dts: true, clean: true, sourcemap: true },
  { entry: { index: "src/bridge/index.ts" }, outDir: "bridge", format: ["esm", "cjs"], dts: true, sourcemap: true },
  { entry: { index: "src/next/index.ts" }, outDir: "next", format: ["esm", "cjs"], dts: true, sourcemap: true, external: ["next"] },
  { entry: { index: "src/transports/supabase/index.ts" }, outDir: "transports/supabase", format: ["esm", "cjs"], dts: true, sourcemap: true, external: ["@supabase/supabase-js"] },
  { entry: { index: "src/widget/index.ts", styles: "src/widget/styles.css" }, outDir: "widget", format: ["esm", "cjs"], dts: true, sourcemap: true, external: ["react", "react-dom"] },
  // Bundle standalone (IIFE) para <script>: React/react-dom/supabase-js ENTRAM no bundle
  // (noExternal) — não há bundler nem peer install no lado de quem só cola a tag.
  // outExtension: sem ele o esbuild escreve "evolution-chat.iife.global.js" (sufixo .global
  // que ele aplica a todo IIFE com globalName); o contrato do pacote é ".iife.js".
  // platform:browser + env NODE_ENV: dentro do <script> não há Node nem bundler — sem
  // `define`, restam `process.env.NODE_ENV` crus no bundle (ReferenceError no browser) e o
  // React/Scheduler resolvem para os builds de Node.
  { entry: { "evolution-chat.iife": "src/widget-embed/index.ts" }, outDir: "widget-embed", format: ["iife"], globalName: "EvolutionChatEmbed", outExtension: () => ({ js: ".js" }), platform: "browser", env: { NODE_ENV: "production" }, noExternal: [/react/, /react-dom/, /@supabase\/supabase-js/], dts: false, clean: true },
]);
