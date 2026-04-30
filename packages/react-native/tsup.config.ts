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
  // react-native-sse is a peer dep — apps install it themselves so
  // we don't lock their RN version. Mark it external so tsup doesn't
  // try to bundle it (it can't anyway; it has native code bindings).
  // @valet.red/sdk-core stays external too — consumers get a normal
  // npm dep tree and types resolve cleanly.
  external: ["react-native", "react-native-sse"]
})
