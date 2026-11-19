import { defineConfig } from "drizzle-kit"

// drizzle-kit loads no .env itself. The repository's one, if present, fills
// what the environment doesn't already set.
try {
  process.loadEnvFile("../../.env")
} catch {
  // None here, as in a container: the environment carries everything.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/*/sql.ts",
  out: "./migrations",
  // drizzle-kit reads this file outside the Effect runtime, so Config is unavailable.
  // oxlint-disable-next-line effecttsgo/process-env
  dbCredentials: { url: process.env["SIM_DATABASE_URL"] ?? "" },
})
