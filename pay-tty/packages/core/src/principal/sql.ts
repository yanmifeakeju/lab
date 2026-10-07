import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

import { createdAt } from "../database/columns.ts"

export const principals = pgTable(
  "principals",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    ...createdAt,
  },
  (table) => [
    uniqueIndex("principals_issuer_subject_unique").on(
      table.issuer,
      table.subject,
    ),
  ],
)
