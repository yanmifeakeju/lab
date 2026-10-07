import { Schema } from "effect"

import { labels } from "./sql.ts"

export const Slug = Schema.String.pipe(
  Schema.check(Schema.isPattern(/\S/)),
  Schema.brand("Ledger.Slug"),
)

export type Slug = typeof Slug.Type

// Every business registers into this ledger.
export const ngn = Slug.make("ngn_ng")

export const Label = Schema.Literals(labels)

export type Label = typeof Label.Type

export * as Ledger from "./ledger.ts"
