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
  // Minify the shipped JS. The 0.2.0 P0 feature set (channels, pagination,
  // attachments, notifications, mentions) grows the source past the unminified
  // budget, so we ship minified — sourcemaps stay on for debugging, and the
  // size-check ceilings still pass with wide margin, so the guard remains
  // meaningful for future growth.
  minify: true,
  external: ["react", "react-dom"],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
