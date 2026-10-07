import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"

import { Database } from "../database/client.ts"
import { Currency } from "./currency.ts"
import { Ledger } from "./ledger.ts"
import { ledgers } from "./sql.ts"

export class Entry extends Schema.Class<Entry>("Catalog.Entry")({
  slug: Ledger.Slug,
  currency: Currency.Code,
  scale: Schema.Int,
}) {}

export interface Interface {
  /** One ledger's catalog row, read when asked rather than at startup. */
  readonly find: (slug: Ledger.Slug) => Effect.Effect<Entry | undefined>
}

export class Service extends Context.Service<Service, Interface>()("Catalog") {}

const make = Effect.gen(function* () {
  const database = yield* Database

  const find = Effect.fn("Catalog.find")(function* (slug: Ledger.Slug) {
    const rows = yield* database.use((db) => db.select().from(ledgers).where(eq(ledgers.slug, slug)))

    const row = rows[0]

    return row === undefined
      ? undefined
      : new Entry({ slug: Ledger.Slug.make(row.slug), currency: Currency.Code.make(row.currency), scale: row.scale })
  })

  return Service.of({ find })
})

export const layer = Layer.effect(Service)(make)

export * as Catalog from "./catalog.ts"
