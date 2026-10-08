import { Schema } from "effect"

export const Slug = Schema.String.pipe(
  Schema.check(Schema.isPattern(/\S/)),
  Schema.brand("Ledger.Slug"),
)

export type Slug = typeof Slug.Type

export * as Ledger from "./ledger.ts"
