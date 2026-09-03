import { defineConfig } from "tsup";

export default defineConfig([
  { entry: { index: "src/api/index.ts" }, outDir: "dist/api", format: ["esm", "cjs"], dts: true, clean: true, sourcemap: true },
  { entry: { index: "src/bridge/index.ts" }, outDir: "dist/bridge", format: ["esm", "cjs"], dts: true, sourcemap: true },
  { entry: { index: "src/next/index.ts" }, outDir: "dist/next", format: ["esm", "cjs"], dts: true, sourcemap: true, external: ["next"] },
  { entry: { index: "src/transports/supabase/index.ts" }, outDir: "dist/transports/supabase", format: ["esm", "cjs"], dts: true, sourcemap: true, external: ["@supabase/supabase-js"] },
  { entry: { index: "src/widget/index.ts", styles: "src/widget/styles.css" }, outDir: "dist/widget", format: ["esm", "cjs"], dts: true, sourcemap: true, external: ["react", "react-dom"] },
]);
