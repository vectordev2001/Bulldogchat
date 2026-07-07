import { defineConfig } from "tsup";

// Builds the widget as ESM + CJS + .d.ts, matching the consumer import in
// the spec (`import { BulldogChatWidget } from "@bulldog/chat-widget"`).
// react/react-dom are peer deps — never bundled, so Contracts/Ops's own
// React instance is reused (avoids the classic "two copies of React"
// invalid-hook-call bug when a package is npm-linked).
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ["react", "react-dom"],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
