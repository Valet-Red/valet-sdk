import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  target: "es2020",
  treeshake: true,
  // Inline runtime deps so the ESM bundle works as a single file when
  // loaded directly in the browser (no import map, no CDN-resolves-deps
  // gymnastics). Browsers can't resolve bare specifiers like
  // "@microsoft/fetch-event-source"; bundling them in is the simple fix.
  // Cost: ~3 KB extra in the bundle. Acceptable.
  noExternal: ["@microsoft/fetch-event-source"]
})
