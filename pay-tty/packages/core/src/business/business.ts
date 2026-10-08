import { and, eq, isNotNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"

import { Database } from "../database/client.ts"
import { createId } from "../database/ids.ts"
import { Catalog } from "../ledger/catalog.ts"
import { Currency } from "../ledger/currency.ts"
import { Ledger } from "../ledger/ledger.ts"
import { ledgers } from "../ledger/sql.ts"
import type { Principal } from "../principal/principal.ts"
import { principals } from "../principal/sql.ts"
import { businesses, businessPrincipals, countries, currencies, statuses } from "./sql.ts"

export const ID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("biz_")),
  Schema.brand("Business.ID"),
)

export type ID = typeof ID.Type

export const Status = Schema.Literals(statuses)

export type Status = typeof Status.Type

export const Country = Schema.Literals(countries)

export type Country = typeof Country.Type

/** The currency a business from this country trades in. */
export const currencyOf = (country: Country) => Currency.Code.make(currencies[country])

export class Details extends Schema.Class<Details>("Business.Details")({
  name: Schema.NonEmptyString,
  countryCode: Country,
}) {}

export class PayableAccount extends Schema.Class<PayableAccount>(
  "Business.PayableAccount",
)({
  holderRef: Schema.String,
  accountRef: Schema.String,
}) {}

export class PrimaryLedger extends Schema.Class<PrimaryLedger>("Business.PrimaryLedger")({
  slug: Ledger.Slug,
  currency: Currency.Code,
  scale: Schema.Int,
  // Null until the ledger has created the account.
  payableAccountRef: Schema.NullOr(Schema.String),
}) {}

export class Info extends Schema.Class<Info>("Business.Info")({
  id: ID,
  name: Schema.String,
  countryCode: Country,
  currencyCode: Currency.Code,
  holderRef: Schema.NullOr(Schema.String),
  status: Status,
  primaryLedger: PrimaryLedger,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "Business.NotFoundError",
  { id: ID },
) {}

/** No ledger is configured for new businesses from this country. */
export class CountryUnavailableError extends Schema.TaggedError<CountryUnavailableError>()(
  "Business.CountryUnavailableError",
  { countryCode: Country },
) {}

/** A recorded ledger, holder, or account disagrees with the request. */
export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "Business.ConflictError",
  { id: ID, message: Schema.String },
) {}

export interface Interface {
  readonly findByPrincipal: (principalId: Principal.ID) => Effect.Effect<Info | undefined>
  /**
   * Idempotent per principal: a repeat returns the business already created,
   * whatever country it asks for. Fails if the country has no default ledger,
   * and dies if that ledger isn't in the country's currency.
   */
  readonly create: (
    principalId: Principal.ID,
    details: Details,
  ) => Effect.Effect<Info, CountryUnavailableError>
  /**
   * Records the account the ledger created in the business's primary ledger,
   * with its holder. Repeating it is a no-op; a different ledger, holder, or
   * account conflicts and changes nothing.
   */
  readonly recordPayableAccount: (
    id: ID,
    ledger: Ledger.Slug,
    account: PayableAccount,
  ) => Effect.Effect<void, NotFoundError | ConflictError>
  /** Leaves an active business as it is. Dies unless its account is recorded. */
  readonly activate: (id: ID) => Effect.Effect<Info, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("Business") {}

const make = Effect.gen(function* () {
  const database = yield* Database
  const catalog = yield* Catalog.Service

  const load = Effect.fnUntraced(function* (id: string) {
    const rows = yield* database.use((db) =>
      db
        .select({ row: businesses, scale: ledgers.scale })
        .from(businesses)
        .innerJoin(ledgers, eq(ledgers.slug, businesses.primaryLedger))
        .where(eq(businesses.id, id)),
    )

    if (rows[0] === undefined) {
      return undefined
    }

    const { row, scale } = rows[0]

    // The foreign key runs through the currency, so the ledger's is the
    // business's.
    const currency = Currency.Code.make(row.currencyCode)

    return new Info({
      id: ID.make(row.id),
      name: row.name,
      countryCode: yield* Schema.decodeUnknownEffect(Country)(row.countryCode).pipe(Effect.orDie),
      currencyCode: currency,
      holderRef: row.ledgerHolderRef,
      status: row.status,
      primaryLedger: new PrimaryLedger({
        slug: Ledger.Slug.make(row.primaryLedger),
        currency,
        scale,
        payableAccountRef: row.primaryPayableAccountRef,
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  })

  const loadExisting = Effect.fnUntraced(function* (id: string) {
    const business = yield* load(id)

    if (business === undefined) {
      return yield* Effect.die(new Error(`business vanished: ${id}`))
    }

    return business
  })

  const findByPrincipal = Effect.fn("Business.findByPrincipal")(function* (
    principalId: Principal.ID,
  ) {
    const links = yield* database.use((db) =>
      db
        .select({ businessId: businessPrincipals.businessId })
        .from(businessPrincipals)
        .where(eq(businessPrincipals.principalId, principalId)),
    )

    const link = links[0]

    return link === undefined ? undefined : yield* loadExisting(link.businessId)
  })

  const create = Effect.fn("Business.create")(function* (
    principalId: Principal.ID,
    details: Details,
  ) {
    // Locking the principal row serialises concurrent creates for it, so the
    // second one finds the first one's business instead of making another.
    const id = yield* database.transaction(
      Effect.gen(function* () {
        const locked = yield* database.use((db) =>
          db
            .select({ id: principals.id })
            .from(principals)
            .where(eq(principals.id, principalId))
            .for("update"),
        )

        if (locked[0] === undefined) {
          return undefined
        }

        const links = yield* database.use((db) =>
          db
            .select({ businessId: businessPrincipals.businessId })
            .from(businessPrincipals)
            .where(eq(businessPrincipals.principalId, principalId)),
        )

        const existing = links[0]

        if (existing !== undefined) {
          return existing.businessId
        }

        const currencyCode = currencyOf(details.countryCode)
        const primary = yield* catalog.findCountryDefault(details.countryCode)

        // Never a fallback to another country's ledger.
        if (primary === undefined) {
          return yield* new CountryUnavailableError({ countryCode: details.countryCode })
        }

        if (primary.currency !== currencyCode) {
          return yield* Effect.die(
            new Error(`${details.countryCode} default ledger ${primary.slug} is in ${primary.currency}, not ${currencyCode}`),
          )
        }

        const businessId = createId("biz")

        yield* database.use((db) =>
          db.insert(businesses).values({
            id: businessId,
            name: details.name,
            countryCode: details.countryCode,
            currencyCode,
            primaryLedger: primary.slug,
          }),
        )

        yield* database.use((db) =>
          db.insert(businessPrincipals).values({ principalId, businessId }),
        )

        return businessId
      }),
    )

    if (id === undefined) {
      return yield* Effect.die(new Error(`principal not found: ${principalId}`))
    }

    return yield* loadExisting(id)
  })

  const recordPayableAccount = Effect.fn("Business.recordPayableAccount")(
    function* (id: ID, ledger: Ledger.Slug, account: PayableAccount) {
      // Locking the business serialises concurrent records for it, so each
      // sees what the last one committed.
      const rows = yield* database.use((db) =>
        db
          .select({
            primaryLedger: businesses.primaryLedger,
            holderRef: businesses.ledgerHolderRef,
            accountRef: businesses.primaryPayableAccountRef,
          })
          .from(businesses)
          .where(eq(businesses.id, id))
          .for("update"),
      )

      const recorded = rows[0]

      if (recorded === undefined) {
        return yield* new NotFoundError({ id })
      }

      if (recorded.primaryLedger !== ledger) {
        return yield* new ConflictError({ id, message: `primary ledger is ${recorded.primaryLedger}, not ${ledger}` })
      }

      // The holder and account are written together, so either both are
      // recorded or neither is.
      if (recorded.accountRef !== null) {
        if (recorded.holderRef !== account.holderRef || recorded.accountRef !== account.accountRef) {
          return yield* new ConflictError({
            id,
            message: `holds ${recorded.holderRef}/${recorded.accountRef}, ledger returned ${account.holderRef}/${account.accountRef}`,
          })
        }

        return
      }

      // The unique index would also refuse an account another business
      // holds; checking first makes that a conflict, not a defect.
      const owners = yield* database.use((db) =>
        db
          .select({ id: businesses.id })
          .from(businesses)
          .where(eq(businesses.primaryPayableAccountRef, account.accountRef)),
      )

      if (owners[0] !== undefined) {
        return yield* new ConflictError({ id, message: `account ${account.accountRef} is already recorded elsewhere` })
      }

      yield* database.use((db) =>
        db
          .update(businesses)
          .set({ ledgerHolderRef: account.holderRef, primaryPayableAccountRef: account.accountRef })
          .where(eq(businesses.id, id)),
      )
    },
    (effect) => database.transaction(effect),
  )

  const activate = Effect.fn("Business.activate")(function* (id: ID) {
    const rows = yield* database.use((db) =>
      db
        .update(businesses)
        .set({ status: "active" })
        .where(
          and(
            eq(businesses.id, id),
            eq(businesses.status, "created"),
            isNotNull(businesses.primaryPayableAccountRef),
          ),
        )
        .returning({ id: businesses.id }),
    )

    if (rows[0] !== undefined) {
      return yield* loadExisting(id)
    }

    const business = yield* load(id)

    if (business === undefined) {
      return yield* new NotFoundError({ id })
    }

    if (business.status === "active") {
      return business
    }

    return yield* Effect.die(new Error(`business ${id} has no primary account recorded`))
  })

  return Service.of({
    findByPrincipal,
    create,
    recordPayableAccount,
    activate,
  })
})

export const layer = Layer.effect(Service)(make)

export * as Business from "./business.ts"
