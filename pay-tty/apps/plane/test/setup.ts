// node:test global setup for plane. Each test file that needs plane's schema
// makes its own database with `withDatabase(schema)`.

import type { Database } from "@pay-tty/core/database"
import { planeSchema } from "@pay-tty/core/testing/setup"
import type { Testing } from "@pay-tty/database/testing"

export const schema: Testing.Schema<Database> = { prefix: "pay_tty_t_plane_", ...planeSchema }

export { globalSetup } from "@pay-tty/database/testing"
