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
  // loaded directly in a browser via CDN (no import map, no resolver).
  // Browsers can't resolve bare specifiers like "@microsoft/fetch-event-source"
  // or "@valet.red/sdk-core"; bundling them in is the simple fix.
  // (RN bundlers like Metro DO resolve bare specifiers — that package
  // keeps core external. Only the browser package inlines.)
  noExternal: ["@microsoft/fetch-event-source", "@valet.red/sdk-core"]
})
