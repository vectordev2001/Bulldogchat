import { defineConfig } from "drizzle-kit";

const raw = process.env.DATABASE_URL ?? "file:./data/vector.db";
const url = raw.startsWith("file:") ? raw.slice(5) : raw;

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "sqlite",
  dbCredentials: { url },
});
