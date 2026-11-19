import { and, eq, isNotNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"

import { Database } from "../database/client.ts"
import { createId } from "../database/ids.ts"
import { Catalog } from "../ledger/catalog.ts"
import { Currency } from "../ledger/currency.ts"
import { Ledger } from "../ledger/slug.ts"
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

export const currencyOf = (country: Country) => Currency.Code.make(currencies[country])

export class Details extends Schema.Class<Details>("Business.Details")({
  // Caller-trimmed; idempotent retries compare against the stored name verbatim.
  name: Schema.NonEmptyString.check(Schema.isTrimmed()),
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
  // Null until the payable account is opened in the ledger.
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

/** No default ledger is configured for `countryCode`. */
export class CountryUnavailableError extends Schema.TaggedError<CountryUnavailableError>()(
  "Business.CountryUnavailableError",
  { countryCode: Country },
) {}

/** Existing business or account state conflicts with the request. */
export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "Business.ConflictError",
  { id: ID, message: Schema.String },
) {}

export interface Interface {
  readonly findByPrincipal: (principalId: Principal.ID) => Effect.Effect<Info | undefined>
  /**
   * Creates a business for `principalId`. Idempotent per principal when
   * `details` match; returns `ConflictError` if a business already exists for
   * the principal with a different name or country.
   */
  readonly create: (
    principalId: Principal.ID,
    details: Details,
  ) => Effect.Effect<Info, CountryUnavailableError | ConflictError>
  /**
   * Records the holder and payable account references returned by the ledger.
   * Idempotent for identical inputs; returns `ConflictError` if the ledger,
   * holder, or account reference differs from what is already stored.
   */
  readonly recordPayableAccount: (
    id: ID,
    ledger: Ledger.Slug,
    account: PayableAccount,
  ) => Effect.Effect<void, NotFoundError | ConflictError>
  /** Transitions a business with a recorded payable account to `active`. Idempotent. */
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

    // Composite FK guarantees `ledgers.currency` matches `businesses.currency_code`.
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
    const id = yield* database.transaction(
      Effect.gen(function* () {
        // Locking the principal serialises concurrent creates, so the second finds the first's business.
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
            .select({ id: businesses.id, name: businesses.name, countryCode: businesses.countryCode })
            .from(businessPrincipals)
            .innerJoin(businesses, eq(businesses.id, businessPrincipals.businessId))
            .where(eq(businessPrincipals.principalId, principalId)),
        )

        const existing = links[0]

        if (existing !== undefined) {
          if (existing.name !== details.name || existing.countryCode !== details.countryCode) {
            return yield* new ConflictError({
              id: ID.make(existing.id),
              message: `exists as ${existing.name}/${existing.countryCode}, asked for ${details.name}/${details.countryCode}`,
            })
          }

          return existing.id
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
      // Locking the business serialises concurrent records, so each sees the last one's.
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

      // `businesses_holder_with_account` guarantees both columns are set or both are null.
      if (recorded.accountRef !== null) {
        if (recorded.holderRef !== account.holderRef || recorded.accountRef !== account.accountRef) {
          return yield* new ConflictError({
            id,
            message: `holds ${recorded.holderRef}/${recorded.accountRef}, ledger returned ${account.holderRef}/${account.accountRef}`,
          })
        }

        return
      }

      // Check before updating so a duplicate account reference returns
      // `ConflictError` rather than failing on the unique index.
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

    // Callers record the account first, so one missing is a bug, not a request to refuse.
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
