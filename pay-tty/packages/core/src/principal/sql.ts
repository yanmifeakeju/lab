import { pgTable, uniqueIndex } from "drizzle-orm/pg-core"

import { createdAt } from "../database/columns.ts"
import { identifier } from "@pay-tty/database/columns"

export const principals = pgTable(
  "principals",
  {
    id: identifier("id").primaryKey(),
    issuer: identifier("issuer").notNull(),
    subject: identifier("subject").notNull(),
    ...createdAt,
  },
  (table) => [
    uniqueIndex("principals_issuer_subject_unique").on(
      table.issuer,
      table.subject,
    ),
  ],
)
