import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/core/*/sql.ts",
  out: "./migrations",
  // drizzle-kit reads this file outside the Effect runtime, so Config is unavailable.
  // oxlint-disable-next-line effecttsgo/process-env
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
})
