import { defineConfig } from "tsup";
// tinyglobby (not node:fs's globSync, which needs Node 22+ — this repo
// targets Node 20) is already in node_modules as a transitive dependency of
// tsup itself, so it's available without adding a new devDependency.
import { globSync } from "tinyglobby";

// Builds @vectordev2001/chat-ui as ESM + CJS + .d.ts. react/react-dom are
// peer deps — never bundled — so consumers (client's Vite build, the
// widget's own tsup build) reuse their own React instance. Mirrors
// widget/tsup.config.ts's shape/conventions.
//
// Every source file under components/, hooks/, lib/, types/ becomes its own
// entry point (not bundled together) so deep imports like
// "@vectordev2001/chat-ui/lib/queryClient" resolve to a real dist file —
// this matches the wildcard "./components/*", "./lib/*" etc. export maps in
// package.json, and lets client's re-export shims (@/lib/utils -> chat-ui's
// lib/utils) work without a giant barrel bundle.
const deepEntries = globSync("src/{components,hooks,lib,types}/**/*.{ts,tsx}", {
  cwd: import.meta.dirname,
}).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

const entry: Record<string, string> = { index: "src/index.ts" };
for (const file of deepEntries) {
  const key = file.replace(/^src\//, "").replace(/\.(ts|tsx)$/, "");
  entry[key] = file;
}

export default defineConfig({
  entry,
  format: ["esm", "cjs"],
  // .d.ts generation is done via a separate `tsc --emitDeclarationOnly` pass
  // (see the "build" script in package.json), not tsup's built-in `dts`
  // option. tsup's dts worker aborts the *entire* declaration build (zero
  // .d.ts files emitted, including index.d.ts) on the very first type
  // error it hits — and this repo has a pre-existing, unrelated broken
  // install of livekit-client (its package.json points "types" at
  // dist/src/index.d.ts, but that file isn't actually present in
  // node_modules; same error already exists on main for
  // client/src/components/VoiceChannelView.tsx et al. — see tsc baseline).
  // Plain tsc with noEmitOnError left at its default (false) emits
  // .d.ts for every file that itself type-checks cleanly and simply
  // reports — without blocking on — errors in the handful of files that
  // import livekit-client, matching how the rest of the repo already
  // tolerates this same pre-existing issue.
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  bundle: false,
  external: ["react", "react-dom"],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
