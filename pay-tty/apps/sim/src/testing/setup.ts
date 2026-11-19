// node:test global setup for the sim. Each test file that needs the sim's
// schema makes its own database with `withDatabase(schema)`.

import type { Testing } from "@pay-tty/database/testing"

import { layerUrl, type SimDatabase } from "../database.ts"
import { migrationsFolder } from "../migrations.ts"

export const schema: Testing.Schema<SimDatabase> = { prefix: "pay_tty_t_sim_", migrations: { migrationsFolder }, seed: "", layer: layerUrl }

export { globalSetup } from "@pay-tty/database/testing"
