import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "node:fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
  "@google/generative-ai",
  "axios",
  "bcryptjs",
  // NOTE: better-sqlite3 must stay EXTERNAL — it's a native module with a .node binary
  // that cannot be bundled. Node must resolve it from node_modules at runtime.
  "cors",
  "date-fns",
  "dotenv",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "expo-server-sdk",
  "express-session",
  "jsonwebtoken",
  "livekit-server-sdk",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "web-push",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
