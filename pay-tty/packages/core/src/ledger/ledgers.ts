import { Context, Effect, Layer, Schema } from "effect"

import { Database } from "../database/client.ts"
import { Currency } from "./currency.ts"
import { Ledger } from "./ledger.ts"
import { labels, ledgers, platformAccounts } from "./sql.ts"

export class PlatformAccounts extends Schema.Class<PlatformAccounts>(
  "Ledgers.PlatformAccounts",
)({
  cash: Schema.String,
  fee: Schema.String,
}) {}

export class Info extends Schema.Class<Info>("Ledgers.Info")({
  slug: Ledger.Slug,
  currency: Currency.Code,
  scale: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
  platformAccounts: PlatformAccounts,
}) {}

export class Missing extends Schema.Class<Missing>("Ledgers.Missing")({
  ledger: Ledger.Slug,
  label: Ledger.Label,
}) {}

export class MissingPlatformAccountsError extends Schema.TaggedError<MissingPlatformAccountsError>()(
  "Ledgers.MissingPlatformAccountsError",
  { missing: Schema.Array(Missing) },
) {}

export interface Interface {
  /** Undefined only for a ledger added since startup. */
  readonly get: (ledger: Ledger.Slug) => Info | undefined
}

// Read once at startup: a session config is incomplete without every platform
// account, so a gap stops the process rather than the first connection. The
// NGN ledger is required because every business registers into it.
export class Service extends Context.Service<Service, Interface>()("Ledgers") {}

const make = Effect.gen(function* () {
  const database = yield* Database

  const [ledgerRows, accountRows] = yield* database.use((db) =>
    Promise.all([
      db.select().from(ledgers),
      db.select().from(platformAccounts),
    ]),
  )

  const ref = (ledger: string, label: Ledger.Label) =>
    accountRows.find((row) => row.ledger === ledger && row.label === label)
      ?.ledgerAccountRef

  const slugs = [...new Set([Ledger.ngn, ...ledgerRows.map((row) => row.slug)])]

  const missing = slugs.flatMap((ledger) =>
    labels.flatMap((label) =>
      ref(ledger, label) === undefined
        ? [new Missing({ ledger: Ledger.Slug.make(ledger), label })]
        : [],
    ),
  )

  if (missing.length > 0) {
    return yield* new MissingPlatformAccountsError({ missing })
  }

  // Decoding checks each row's currency is an ISO 4217 code; a bad row is a
  // seeding mistake, so it stops startup like a missing account does.
  const infos = yield* Schema.decodeUnknownEffect(Schema.Array(Info))(
    ledgerRows.map((row) => ({
      slug: row.slug,
      currency: row.currency,
      scale: row.scale,
      platformAccounts: { cash: ref(row.slug, "cash"), fee: ref(row.slug, "fee") },
    })),
  )

  const bySlug = new Map(infos.map((info) => [info.slug, info]))

  return Service.of({ get: (ledger) => bySlug.get(ledger) })
})

export const layer = Layer.effect(Service)(make)

export * as Ledgers from "./ledgers.ts"
