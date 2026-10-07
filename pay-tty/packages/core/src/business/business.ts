import { and, eq, exists, isNotNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"

import { Database } from "../database/client.ts"
import { createId } from "../database/ids.ts"
import { Currency } from "../ledger/currency.ts"
import { Ledger } from "../ledger/ledger.ts"
import { ledgers } from "../ledger/sql.ts"
import type { Principal } from "../principal/principal.ts"
import { principals } from "../principal/sql.ts"
import { businesses, businessLedgers, businessPrincipals, statuses } from "./sql.ts"

export const ID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("biz_")),
  Schema.brand("Business.ID"),
)

export type ID = typeof ID.Type

export const Status = Schema.Literals(statuses)

export type Status = typeof Status.Type

export class Details extends Schema.Class<Details>("Business.Details")({
  name: Schema.NonEmptyString,
}) {}

export class PayableAccount extends Schema.Class<PayableAccount>(
  "Business.PayableAccount",
)({
  holderRef: Schema.String,
  accountRef: Schema.String,
}) {}

export class DefaultLedger extends Schema.Class<DefaultLedger>("Business.DefaultLedger")({
  slug: Ledger.Slug,
  currency: Currency.Code,
  scale: Schema.Int,
  payableAccountRef: Schema.String,
}) {}

export class Info extends Schema.Class<Info>("Business.Info")({
  id: ID,
  name: Schema.String,
  currencyCode: Currency.Code,
  // One holder across every ledger the business is in.
  holderRef: Schema.NullOr(Schema.String),
  status: Status,
  // Null until the first payable account is recorded.
  ledger: Schema.NullOr(DefaultLedger),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "Business.NotFoundError",
  { id: ID },
) {}

/** A recorded holder, account, default, or currency disagrees with the request. */
export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "Business.ConflictError",
  { id: ID, message: Schema.String },
) {}

export interface Interface {
  readonly findByPrincipal: (principalId: Principal.ID) => Effect.Effect<Info | undefined>
  /** Idempotent per principal: a repeat returns the business already created. */
  readonly create: (principalId: Principal.ID, details: Details) => Effect.Effect<Info>
  /**
   * Records a payable account the ledger created, with its holder, and makes
   * it the default when asked; an existing default is never replaced, and a
   * default must be in the business's currency. Repeating it is a no-op.
   */
  readonly recordPayableAccount: (
    id: ID,
    ledger: Ledger.Slug,
    account: PayableAccount,
    options: { readonly isDefault: boolean },
  ) => Effect.Effect<void, NotFoundError | ConflictError>
  /**
   * Leaves an active business as it is. Dies unless the business has a
   * holder and a default ledger in its own currency.
   */
  readonly activate: (id: ID) => Effect.Effect<Info, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("Business") {}

const make = Effect.gen(function* () {
  const database = yield* Database

  const load = Effect.fnUntraced(function* (id: string) {
    const rows = yield* database.use((db) =>
      db
        .select({
          row: businesses,
          slug: businessLedgers.ledger,
          payableAccountRef: businessLedgers.payableAccountRef,
          currency: ledgers.currency,
          scale: ledgers.scale,
        })
        .from(businesses)
        .leftJoin(
          businessLedgers,
          and(eq(businessLedgers.businessId, businesses.id), eq(businessLedgers.isDefault, true)),
        )
        .leftJoin(ledgers, eq(ledgers.slug, businessLedgers.ledger))
        .where(eq(businesses.id, id)),
    )

    if (rows[0] === undefined) {
      return undefined
    }

    const { row, slug, payableAccountRef, currency, scale } = rows[0]

    // The foreign key makes the catalog columns present whenever the slug is.
    const ledger =
      slug !== null && payableAccountRef !== null && currency !== null && scale !== null
        ? new DefaultLedger({
            slug: Ledger.Slug.make(slug),
            currency: Currency.Code.make(currency),
            scale,
            payableAccountRef,
          })
        : null

    return new Info({
      id: ID.make(row.id),
      name: row.name,
      currencyCode: Currency.Code.make(row.currencyCode),
      holderRef: row.ledgerHolderRef,
      status: row.status,
      ledger,
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

        const businessId = createId("biz")

        // The currency is the column's default: NGN, never the caller's.
        yield* database.use((db) =>
          db.insert(businesses).values({ id: businessId, name: details.name }),
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
    function* (
      id: ID,
      ledger: Ledger.Slug,
      account: PayableAccount,
      options: { readonly isDefault: boolean },
    ) {
      // Locking the business serialises concurrent records for it, so each
      // sees what the last one committed. The ledger keys holders by
      // business, so every ledger must hand back the same one.
      const rows = yield* database.use((db) =>
        db
          .select({ holderRef: businesses.ledgerHolderRef, currencyCode: businesses.currencyCode })
          .from(businesses)
          .where(eq(businesses.id, id))
          .for("update"),
      )

      const holder = rows[0]

      if (holder === undefined) {
        return yield* new NotFoundError({ id })
      }

      if (holder.holderRef === null) {
        yield* database.use((db) =>
          db.update(businesses).set({ ledgerHolderRef: account.holderRef }).where(eq(businesses.id, id)),
        )
      } else if (holder.holderRef !== account.holderRef) {
        return yield* new ConflictError({
          id,
          message: `holds ${holder.holderRef}, ledger returned ${account.holderRef}`,
        })
      }

      if (options.isDefault) {
        const defaults = yield* database.use((db) =>
          db
            .select({ ledger: businessLedgers.ledger })
            .from(businessLedgers)
            .where(and(eq(businessLedgers.businessId, id), eq(businessLedgers.isDefault, true))),
        )

        const current = defaults[0]?.ledger

        if (current !== undefined && current !== ledger) {
          return yield* new ConflictError({ id, message: `already defaults to ${current}, not ${ledger}` })
        }

        const catalog = yield* database.use((db) =>
          db.select({ currency: ledgers.currency }).from(ledgers).where(eq(ledgers.slug, ledger)),
        )

        const currency = catalog[0]?.currency

        if (currency !== holder.currencyCode) {
          return yield* new ConflictError({
            id,
            message: `is in ${holder.currencyCode}, ledger ${ledger} is in ${currency ?? "no catalog entry"}`,
          })
        }
      }

      // The unique index would also refuse an account another business or
      // ledger holds; checking first makes that a conflict, not a defect.
      const owners = yield* database.use((db) =>
        db
          .select({ businessId: businessLedgers.businessId, ledger: businessLedgers.ledger })
          .from(businessLedgers)
          .where(eq(businessLedgers.payableAccountRef, account.accountRef)),
      )

      const owner = owners[0]

      if (owner !== undefined && (owner.businessId !== id || owner.ledger !== ledger)) {
        return yield* new ConflictError({ id, message: `account ${account.accountRef} is already recorded elsewhere` })
      }

      // A recorded ref is kept so a mismatch surfaces below, and a recorded
      // default stays one.
      const accounts = yield* database.use((db) =>
        db
          .insert(businessLedgers)
          .values({
            businessId: id,
            ledger,
            isDefault: options.isDefault,
            payableAccountRef: account.accountRef,
          })
          .onConflictDoUpdate({
            target: [businessLedgers.businessId, businessLedgers.ledger],
            set: { isDefault: sql`${businessLedgers.isDefault} or excluded.is_default` },
          })
          .returning({ ref: businessLedgers.payableAccountRef }),
      )

      const recorded = accounts[0]?.ref

      if (recorded !== account.accountRef) {
        return yield* new ConflictError({
          id,
          message: `holds ${recorded} in ${ledger}, ledger returned ${account.accountRef}`,
        })
      }
    },
    // The holder and the account are recorded together or not at all.
    (effect) => database.transaction(effect),
  )

  const activate = Effect.fn("Business.activate")(function* (id: ID) {
    // Checked in the same statement, so the business can't go active without
    // the holder and default account its sessions run against.
    const rows = yield* database.use((db) =>
      db
        .update(businesses)
        .set({ status: "active" })
        .where(
          and(
            eq(businesses.id, id),
            eq(businesses.status, "created"),
            isNotNull(businesses.ledgerHolderRef),
            exists(
              db
                .select({ ledger: businessLedgers.ledger })
                .from(businessLedgers)
                .innerJoin(ledgers, eq(ledgers.slug, businessLedgers.ledger))
                .where(
                  and(
                    eq(businessLedgers.businessId, id),
                    eq(businessLedgers.isDefault, true),
                    eq(ledgers.currency, businesses.currencyCode),
                  ),
                ),
            ),
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

    return yield* Effect.die(new Error(`business ${id} has no holder or default ledger in its currency`))
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
