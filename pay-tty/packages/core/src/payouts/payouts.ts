import { and, count, desc, eq, isNotNull, isNull, lt, not, or, sql } from "drizzle-orm"
import { Context, Data, Duration, Effect, Layer, Result, Schema } from "effect"

import { Business } from "../business/business.ts"
import { businesses } from "../business/sql.ts"
import { Database } from "../database/client.ts"
import { createId } from "../database/ids.ts"
import { Currency } from "../ledger/currency.ts"
import { RelayNudge } from "../ledger/nudge.ts"
import { Ledger } from "../ledger/slug.ts"
import { ledgerPostings, ledgers, platformAccounts, resolutionMismatched } from "../ledger/sql.ts"
import { fromNow, maxAmount } from "@pay-tty/database/columns"
import { cursorAt, pages } from "@pay-tty/database/pages"
import { listable, modes, payouts, payoutSettings, statuses, triggers } from "./sql.ts"
import type { ProviderRef } from "./provider.ts"

export const pageSize = 50

/** TTL for an unconfirmed `created` payout draft. */
export const draftLifetime = Duration.seconds(90)

/** Maximum unconfirmed `created` payout drafts a business may hold open per ledger. */
export const draftLimit = 5

const pastExpiry = sql`${payouts.expiresAt} <= now()`

/** Predicate matching a `created` draft past `expires_at`. */
export const lapsedDraft = sql<boolean>`(${payouts.status} = 'created' and ${pastExpiry})`.mapWith(Boolean)

/** Update payload marking a lapsed draft `expired` with `completed_at = expires_at`. */
export const expiredMark = { status: "expired", completedAt: payouts.expiresAt } as const

/** Update payload marking an invalidated draft `cancelled` as of `now()`. */
const cancelledMark = { status: "cancelled", completedAt: sql`now()` } as const

export const ID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("pout_")),
  Schema.brand("Payouts.ID"),
)

export type ID = typeof ID.Type

export const Mode = Schema.Literals(modes)

export type Mode = typeof Mode.Type

export const Trigger = Schema.Literals(triggers)

export type Trigger = typeof Trigger.Type

export const Status = Schema.Literals(statuses)

export type Status = typeof Status.Type

// Supported Nigerian banks by 3-digit CBN code.
const nigerianBanks = [
  { code: "044", name: "Access Bank" },
  { code: "050", name: "Ecobank" },
  { code: "070", name: "Fidelity Bank" },
  { code: "011", name: "First Bank" },
  { code: "214", name: "FCMB" },
  { code: "058", name: "GTBank" },
  { code: "076", name: "Polaris Bank" },
  { code: "221", name: "Stanbic IBTC" },
  { code: "232", name: "Sterling Bank" },
  { code: "033", name: "UBA" },
  { code: "032", name: "Union Bank" },
  { code: "035", name: "Wema Bank" },
  { code: "057", name: "Zenith Bank" },
] as const

interface Bank {
  readonly code: string
  readonly name: string
}

/** Per-currency payout configuration: supported banks and minimum payout amount in minor units. */
export interface Rules {
  readonly banks: ReadonlyArray<Bank>
  readonly minimum: bigint
}

const currencies = new Map<string, Rules>([
  ["NGN", { banks: nigerianBanks, minimum: 10_000n }],
])

/** Returns the payout rules for `currency`, or undefined if payouts are unsupported. */
export const rulesFor = (currency: string) => currencies.get(currency)

/** 3-digit bank code; validated against the ledger currency's bank list on save and confirm. */
export const BankCode = Schema.String.check(
  Schema.isPattern(/^\d{3}$/).annotate({ expected: "a 3-digit bank code" }),
)

const takesPayouts = (rules: Rules, bankCode: string) => rules.banks.some((bank) => bank.code === bankCode)

const bankNames: ReadonlyMap<string, string> = new Map(
  [...currencies.values()].flatMap((rules) => rules.banks.map((bank) => [bank.code, bank.name] as const)),
)

/** Returns the display name for bank `code`, falling back to `code` if delisted. */
export const bankName = (code: string) => bankNames.get(code) ?? code

/** 10-digit NUBAN account number. */
export const AccountNumber = Schema.String.check(
  Schema.isPattern(/^\d{10}$/).annotate({ expected: "a 10-digit account number" }),
)


/** Stored bank account destination for a payout. */
export class Destination extends Schema.Class<Destination>("Payouts.Destination")({
  bankCode: Schema.String,
  accountNumber: Schema.String,
  accountName: Schema.String,
}) {}

/** Payout configuration for a business and ledger. */
export class Settings extends Schema.Class<Settings>("Payouts.Settings")({
  businessId: Business.ID,
  ledger: Ledger.Slug,
  currencyCode: Currency.Code,
  scale: Schema.Int,
  /** Minimum payout amount in minor units. */
  minimum: Schema.BigInt,
  mode: Mode,
  /** Saved destination account, or null until configured. */
  destination: Schema.NullOr(Destination),
  /** Timestamp of the last settings update, or null if never saved. */
  updatedAt: Schema.NullOr(Schema.Date),
}) {}

/** Input payload for updating payout settings. */
export class Change extends Schema.Class<Change>("Payouts.Change")({
  mode: Mode,
  // Account holder name is taken from the business record (no name enquiry in v1).
  destination: Schema.Struct({ bankCode: BankCode, accountNumber: AccountNumber }),
}) {}

export const Reason = Schema.Literal("insufficient_funds")

/** Final transfer outcome reported by the payout provider. */
export const Outcome = Schema.Literals(["paid", "failed"])

export type Outcome = typeof Outcome.Type

export class Payout extends Schema.Class<Payout>("Payouts.Payout")({
  id: ID,
  businessId: Business.ID,
  ledger: Ledger.Slug,
  currencyCode: Currency.Code,
  scale: Schema.Int,
  amount: Schema.BigInt,
  trigger: Trigger,
  status: Status,
  /** Rejection reason (`insufficient_funds`), or null otherwise. */
  reason: Schema.NullOr(Reason),
  /** Destination snapshot captured when the payout was created. */
  destination: Destination,
  /** Ledger journal entry reference for the payout's hold, once recorded. */
  journalRef: Schema.NullOr(Schema.String),
  /**
   * True when the ledger refused to resolve the hold or resolved it contrary
   * to the provider outcome.
   */
  ledgerMismatch: Schema.Boolean,
  providerRef: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  /** Expiration timestamp for an unconfirmed `created` draft, or null once past `created`. */
  expiresAt: Schema.NullOr(Schema.Date),
  sentAt: Schema.NullOr(Schema.Date),
  completedAt: Schema.NullOr(Schema.Date),
}) {}

export const Cursor = Schema.String.pipe(Schema.brand("Payouts.Cursor"))

export type Cursor = typeof Cursor.Type

export class Page extends Schema.Class<Page>("Payouts.Page")({
  /** Ordered newest first. */
  payouts: Schema.Array(Payout),
  next: Schema.NullOr(Cursor),
}) {}

export interface Confirmed {
  readonly payout: Payout
  /** False when the payout was already confirmed prior to this call. */
  readonly confirmed: boolean
}

// Transaction result for `confirm`: `Closed` commits the draft's transition to
// `expired` or `cancelled` before failing with `error`.
type ConfirmEnding = Data.TaggedEnum<{
  Done: Confirmed
  Closed: { readonly error: ExpiredError | RulesChangedError | AutomaticError | LedgerMismatchError }
}>

const Ending = Data.taggedEnum<ConfirmEnding>()

/** The business does not have an open payable account in `ledger`. */
export class SettingsNotFoundError extends Schema.TaggedError<SettingsNotFoundError>()(
  "Payouts.SettingsNotFoundError",
  { businessId: Business.ID, ledger: Ledger.Slug },
) {}

/** Manual payouts are disabled while `mode` is `automatic`. */
export class AutomaticError extends Schema.TaggedError<AutomaticError>()(
  "Payouts.AutomaticError",
  { businessId: Business.ID, ledger: Ledger.Slug },
) {}

/** Payouts are not supported for the ledger's currency. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "Payouts.UnavailableError",
  { businessId: Business.ID, ledger: Ledger.Slug, currency: Schema.String },
) {}

/** `bankCode` is not a supported payout destination for `currency`. */
export class BankError extends Schema.TaggedError<BankError>()(
  "Payouts.BankError",
  { bankCode: Schema.String, currency: Schema.String },
) {}

/** No destination account is saved for `ledger`, or its bank is no longer supported. */
export class NoPayoutAccountError extends Schema.TaggedError<NoPayoutAccountError>()(
  "Payouts.NoPayoutAccountError",
  { businessId: Business.ID, ledger: Ledger.Slug },
) {}

/** A prior payout in `ledger` has an unresolved ledger mismatch, blocking new payouts. */
export class LedgerMismatchError extends Schema.TaggedError<LedgerMismatchError>()(
  "Payouts.LedgerMismatchError",
  { businessId: Business.ID, ledger: Ledger.Slug },
) {}

/** The business already has `draftLimit` open `created` drafts in `ledger`. */
export class DraftsFullError extends Schema.TaggedError<DraftsFullError>()(
  "Payouts.DraftsFullError",
  { businessId: Business.ID, ledger: Ledger.Slug },
) {}

/** The draft expired before it was confirmed. */
export class ExpiredError extends Schema.TaggedError<ExpiredError>()("Payouts.ExpiredError", { id: ID }) {}

/** The draft was cancelled and can no longer be confirmed. */
export class CancelledError extends Schema.TaggedError<CancelledError>()("Payouts.CancelledError", { id: ID }) {}

/**
 * Currency payout rules (minimum amount, supported bank, or currency support)
 * changed after the draft was created.
 */
export class RulesChangedError extends Schema.TaggedError<RulesChangedError>()("Payouts.RulesChangedError", { id: ID }) {}

export class AmountError extends Schema.TaggedError<AmountError>()("Payouts.AmountError", {
  message: Schema.String,
}) {}

export class PayoutNotFoundError extends Schema.TaggedError<PayoutNotFoundError>()(
  "Payouts.PayoutNotFoundError",
  { id: Schema.String },
) {}

export class CursorError extends Schema.TaggedError<CursorError>()("Payouts.CursorError", {}) {}

export interface Interface {
  readonly settings: (
    businessId: Business.ID,
    ledger: Ledger.Slug,
  ) => Effect.Effect<Settings, SettingsNotFoundError | UnavailableError>
  /** Lists supported destination banks for `ledger`. */
  readonly banks: (
    businessId: Business.ID,
    ledger: Ledger.Slug,
  ) => Effect.Effect<ReadonlyArray<Bank>, SettingsNotFoundError | UnavailableError>
  /** Upserts payout mode and destination for `ledger`. Existing payouts retain their snapshot destination. */
  readonly changeSettings: (
    businessId: Business.ID,
    ledger: Ledger.Slug,
    change: Change,
  ) => Effect.Effect<Settings, SettingsNotFoundError | UnavailableError | BankError>
  /**
   * Creates an unconfirmed manual payout draft using the current saved
   * destination. Moves no funds until `confirm` is called.
   */
  readonly create: (
    businessId: Business.ID,
    ledger: Ledger.Slug,
    amount: bigint,
  ) => Effect.Effect<
    Payout,
    | SettingsNotFoundError
    | UnavailableError
    | AutomaticError
    | NoPayoutAccountError
    | LedgerMismatchError
    | AmountError
    | DraftsFullError
  >
  /**
   * Confirms a `created` payout draft by transitioning it to `requested`,
   * inserting its pending hold in `ledger_postings`, and nudging the relay.
   * Idempotent by `id` once past `created`.
   *
   * If the draft has expired or is invalidated by mode, mismatch, or rule
   * changes, its transition to `expired` or `cancelled` commits before the
   * error is returned.
   */
  readonly confirm: (
    businessId: Business.ID,
    id: string,
  ) => Effect.Effect<
    Confirmed,
    PayoutNotFoundError | ExpiredError | CancelledError | AutomaticError | LedgerMismatchError | RulesChangedError
  >
  /**
   * The daily run for one business on UTC `date`: creates its automatic payout
   * of `available`, already confirmed, and nudges the relay. Returns null when
   * there's nothing to do: the business isn't due (not automatic, switched
   * since that day began, or already run), or `available` is below the
   * currency's minimum. Paused payouts fail, so the day is retried.
   */
  readonly schedule: (
    businessId: Business.ID,
    ledger: Ledger.Slug,
    date: string,
    available: bigint,
  ) => Effect.Effect<Payout | null, LedgerMismatchError | UnavailableError>
  /** Lists confirmed payouts for `businessId`, ordered newest first (excludes drafts). */
  readonly list: (businessId: Business.ID, before: Cursor | null) => Effect.Effect<Page, CursorError>
  readonly get: (businessId: Business.ID, id: string) => Effect.Effect<Payout, PayoutNotFoundError>
  /**
   * Records the provider's final `outcome` (`paid` or `failed`) for a `sent`
   * payout, sets `resolution` (`capture` or `void`) on its hold posting in the
   * same transaction, and nudges the relay. Returns false if the payout is not
   * in `sent`, or is paid with no provider reference either given or stored. A
   * reference other than the stored one flags the payout, hold kept.
   */
  readonly report: (id: ID, outcome: Outcome, providerRef: ProviderRef | null) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("Payouts") {}

const cursors = pages(ID)

export const destinationOf = (row: { readonly bankCode: string; readonly accountNumber: string; readonly accountName: string }) =>
  new Destination({ bankCode: row.bankCode, accountNumber: row.accountNumber, accountName: row.accountName })

const settingsColumns = { settings: payoutSettings, name: businesses.name, currency: ledgers.currency, scale: ledgers.scale }

const savedDestination = (settings: typeof payoutSettings.$inferSelect, name: string) =>
  destinationOf({ ...settings, accountName: name })

// Defaults to `manual` mode with a null destination when no `payout_settings` row exists yet.
const settingsOf = (businessId: Business.ID, ledger: Ledger.Slug, rules: Rules, row: {
  readonly settings: typeof payoutSettings.$inferSelect | null
  readonly name: string
  readonly currency: string
  readonly scale: number
}) =>
  new Settings({
    businessId,
    ledger,
    currencyCode: Currency.Code.make(row.currency),
    scale: row.scale,
    minimum: rules.minimum,
    mode: row.settings?.mode ?? "manual",
    destination: row.settings === null ? null : savedDestination(row.settings, row.name),
    updatedAt: row.settings?.updatedAt ?? null,
  })

const accountOpened = (businessId: Business.ID, ledger: Ledger.Slug) =>
  and(eq(businesses.id, businessId), eq(businesses.primaryLedger, ledger), isNotNull(businesses.primaryPayableAccountRef))

const payoutColumns = {
  payout: payouts,
  currency: ledgers.currency,
  scale: ledgers.scale,
  errorCode: ledgerPostings.errorCode,
  journalRef: ledgerPostings.journalRef,
  mismatched: resolutionMismatched(ledgerPostings),
  lapsed: lapsedDraft,
}

interface PayoutRow {
  readonly payout: typeof payouts.$inferSelect
  readonly currency: string
  readonly scale: number
  readonly errorCode: string | null
  readonly journalRef: string | null
  readonly mismatched: boolean
  readonly lapsed: boolean
}

const payoutOf = ({ payout, currency, scale, errorCode, journalRef, mismatched, lapsed }: PayoutRow) =>
  new Payout({
    id: ID.make(payout.id),
    businessId: Business.ID.make(payout.businessId),
    ledger: Ledger.Slug.make(payout.ledger),
    currencyCode: Currency.Code.make(currency),
    scale,
    amount: payout.amount,
    trigger: payout.trigger,
    status: lapsed ? "expired" : payout.status,
    reason: payout.status === "rejected" && errorCode === "insufficient_funds" ? errorCode : null,
    destination: destinationOf(payout),
    journalRef,
    ledgerMismatch: mismatched,
    providerRef: payout.providerRef,
    createdAt: payout.createdAt,
    expiresAt: payout.status === "created" && !lapsed ? payout.expiresAt : null,
    sentAt: payout.sentAt,
    completedAt: lapsed ? payout.expiresAt : payout.completedAt,
  })

const make = Effect.gen(function* () {
  const database = yield* Database
  const relay = yield* RelayNudge.Service

  const selectPayouts = (where: ReturnType<typeof and>, limit: number) =>
    database.use((db) =>
      db
        .select({ ...payoutColumns, at: cursorAt(payouts.createdAt) })
        .from(payouts)
        .innerJoin(ledgers, eq(ledgers.slug, payouts.ledger))
        .leftJoin(ledgerPostings, eq(ledgerPostings.payoutId, payouts.id))
        .where(where)
        .orderBy(desc(payouts.createdAt), desc(payouts.id))
        .limit(limit),
    )

  const openedIn = (businessId: Business.ID, ledger: Ledger.Slug) =>
    Effect.flatMap(
      database.use((db) =>
        db
          .select({ name: businesses.name, currency: ledgers.currency, scale: ledgers.scale })
          .from(businesses)
          .innerJoin(ledgers, eq(ledgers.slug, businesses.primaryLedger))
          .where(accountOpened(businessId, ledger)),
      ),
      (rows) => {
        const opened = rows[0]

        return opened === undefined ? Effect.fail(new SettingsNotFoundError({ businessId, ledger })) : Effect.succeed(opened)
      },
    )

  const rulesIn = (businessId: Business.ID, ledger: Ledger.Slug, currency: string) => {
    const rules = rulesFor(currency)

    return rules === undefined
      ? Effect.fail(new UnavailableError({ businessId, ledger, currency }))
      : Effect.succeed({ ...rules, currency })
  }

  const settings = Effect.fn("Payouts.settings")(function* (businessId: Business.ID, ledger: Ledger.Slug) {
    const rows = yield* database.use((db) =>
      db
        .select(settingsColumns)
        .from(businesses)
        .innerJoin(ledgers, eq(ledgers.slug, businesses.primaryLedger))
        .leftJoin(
          payoutSettings,
          and(eq(payoutSettings.businessId, businesses.id), eq(payoutSettings.ledger, businesses.primaryLedger)),
        )
        .where(accountOpened(businessId, ledger)),
    )

    const row = rows[0]

    if (row === undefined) {
      return yield* new SettingsNotFoundError({ businessId, ledger })
    }

    return settingsOf(businessId, ledger, yield* rulesIn(businessId, ledger, row.currency), row)
  })

  const banks = Effect.fn("Payouts.banks")(function* (businessId: Business.ID, ledger: Ledger.Slug) {
    const rules = yield* rulesIn(businessId, ledger, (yield* openedIn(businessId, ledger)).currency)

    return rules.banks
  })

  const changeSettings = Effect.fn("Payouts.changeSettings")(function* (
    businessId: Business.ID,
    ledger: Ledger.Slug,
    change: Change,
  ) {
    const { destination } = change

    const values = {
      mode: change.mode,
      bankCode: destination.bankCode,
      accountNumber: destination.accountNumber,
    }

    // Kept while automatic, so saving a new account doesn't delay the next run.
    const automatic = change.mode === "automatic"

    const opened = yield* openedIn(businessId, ledger)
    const rules = yield* rulesIn(businessId, ledger, opened.currency)

    if (!takesPayouts(rules, destination.bankCode)) {
      return yield* new BankError({ bankCode: destination.bankCode, currency: rules.currency })
    }

    const saved = yield* database.use((db) =>
      db
        .insert(payoutSettings)
        .values({ businessId, ledger, ...values, automaticSince: automatic ? sql`now()` : null })
        .onConflictDoUpdate({
          target: [payoutSettings.businessId, payoutSettings.ledger],
          set: {
            ...values,
            automaticSince: automatic ? sql`coalesce(${payoutSettings.automaticSince}, now())` : null,
            updatedAt: sql`now()`,
          },
        })
        .returning(),
    )

    const row = saved[0]

    if (row === undefined) {
      return yield* Effect.die(new Error(`the upsert returned no payout settings for ${businessId} in ${ledger}`))
    }

    return settingsOf(businessId, ledger, rules, { ...opened, settings: row })
  })

  // A paid payout's voided hold returns its money to the balance, so another
  // payout could pay it twice; a failed payout's capture took the business's
  // money, which is put back first. A payment's refused or voided capture leaves
  // the balance wrong too. Any of them blocks payouts until support fixes it.
  const refuseMismatched = (businessId: Business.ID, ledger: Ledger.Slug) =>
    Effect.gen(function* () {
      const mismatched = yield* database.use((db) =>
        db
          .select({ id: ledgerPostings.id })
          .from(ledgerPostings)
          .where(and(
            eq(ledgerPostings.businessId, businessId),
            eq(ledgerPostings.ledger, ledger),
            resolutionMismatched(ledgerPostings),
          ))
          .limit(1),
      )

      if (mismatched.length > 0) {
        return yield* new LedgerMismatchError({ businessId, ledger })
      }
    })

  const create = Effect.fn("Payouts.create")(function* (businessId: Business.ID, ledger: Ledger.Slug, amount: bigint) {
    if (amount < 1n || amount > maxAmount) {
      return yield* new AmountError({ message: amount < 1n ? "the amount must be positive" : "the amount is too large" })
    }

    return yield* database.transaction(
      Effect.gen(function* () {
        // Lock `payout_settings` `FOR UPDATE` to serialize against settings
        // changes and enforce `draftLimit` across concurrent `create` calls.
        const found = yield* database.use((db) =>
          db
            .select(settingsColumns)
            .from(payoutSettings)
            .innerJoin(ledgers, eq(ledgers.slug, payoutSettings.ledger))
            .innerJoin(businesses, eq(businesses.id, payoutSettings.businessId))
            .where(and(eq(payoutSettings.businessId, businessId), eq(payoutSettings.ledger, ledger)))
            .for("update", { of: payoutSettings }),
        )

        const row = found[0]

        if (row === undefined) {
          yield* rulesIn(businessId, ledger, (yield* openedIn(businessId, ledger)).currency)

          return yield* new NoPayoutAccountError({ businessId, ledger })
        }

        const rules = yield* rulesIn(businessId, ledger, row.currency)

        if (row.settings.mode === "automatic") {
          return yield* new AutomaticError({ businessId, ledger })
        }

        yield* refuseMismatched(businessId, ledger)

        if (amount < rules.minimum) {
          return yield* new AmountError({ message: "the amount is below the payout minimum" })
        }

        const destination = savedDestination(row.settings, row.name)

        if (!takesPayouts(rules, destination.bankCode)) {
          return yield* new NoPayoutAccountError({ businessId, ledger })
        }

        const [drafts] = yield* database.use((db) =>
          db
            .select({ open: count() })
            .from(payouts)
            .where(and(
              eq(payouts.businessId, businessId),
              eq(payouts.ledger, ledger),
              eq(payouts.status, "created"),
              not(pastExpiry),
            )),
        )

        if ((drafts?.open ?? 0) >= draftLimit) {
          return yield* new DraftsFullError({ businessId, ledger })
        }

        const inserted = yield* database.use((db) =>
          db
            .insert(payouts)
            .values({
              id: createId("pout"),
              businessId,
              ledger,
              amount,
              trigger: "manual",
              bankCode: destination.bankCode,
              accountNumber: destination.accountNumber,
              accountName: destination.accountName,
              status: "created",
              expiresAt: fromNow(draftLifetime),
            })
            .returning(),
        )

        const payout = inserted[0]

        if (payout === undefined) {
          return yield* Effect.die(new Error(`the insert returned no payout for ${businessId} in ${ledger}`))
        }

        return payoutOf({ payout, currency: row.currency, scale: row.scale, errorCode: null, journalRef: null, mismatched: false, lapsed: false })
      }),
    )
  })

  const lockPayout = (businessId: Business.ID, id: string) =>
    Effect.gen(function* () {
      const found = yield* database.use((db) =>
        db
          .select({ payout: payouts, lapsed: lapsedDraft })
          .from(payouts)
          .where(and(eq(payouts.id, id), eq(payouts.businessId, businessId)))
          .for("update"),
      )

      const row = found[0]

      return row === undefined ? yield* new PayoutNotFoundError({ id }) : row
    })

  const closeDraft = (id: string, mark: typeof expiredMark | typeof cancelledMark) =>
    database.use((db) =>
      db
        .update(payouts)
        .set(mark)
        .where(and(eq(payouts.id, id), eq(payouts.status, "created"))),
    )

  const reread = (businessId: Business.ID, id: string) => Effect.orDie(get(businessId, id))

  // Queues a requested payout's pending hold, from the payable account to payouts clearing.
  const hold = (payout: typeof payouts.$inferSelect, payable: string, clearing: string) =>
    database.use((db) =>
      db.insert(ledgerPostings).values({
        id: createId("lpost"),
        businessId: payout.businessId,
        ledger: payout.ledger,
        payoutId: payout.id,
        kind: "payout",
        description: `Payout to ${bankName(payout.bankCode)} ••••${payout.accountNumber.slice(-4)}`,
        lines: [
          {
            debit_account_ref: payable,
            credit_account_ref: clearing,
            amount: payout.amount.toString(),
            purpose: "payout",
          },
        ],
        pending: true,
      }),
    )

  const confirm = Effect.fn("Payouts.confirm")(function* (businessId: Business.ID, id: string) {
    const outcome = yield* database.transaction(
      Effect.gen(function* () {
        const { payout, lapsed } = yield* lockPayout(businessId, id)
        const payoutId = ID.make(payout.id)

        if (payout.status === "cancelled") {
          return yield* new CancelledError({ id: payoutId })
        }

        if (payout.status === "expired") {
          return yield* new ExpiredError({ id: payoutId })
        }

        if (payout.status !== "created") {
          return Ending.Done({ payout: yield* reread(businessId, id), confirmed: false })
        }

        if (lapsed) {
          yield* closeDraft(payout.id, expiredMark)

          return Ending.Closed({ error: new ExpiredError({ id: payoutId }) })
        }

        const ledger = Ledger.Slug.make(payout.ledger)

        // Take a `FOR SHARE` lock on `payout_settings` so concurrent mode changes wait until `confirm` commits.
        const found = yield* database.use((db) =>
          db
            .select({
              mode: payoutSettings.mode,
              currency: ledgers.currency,
              payable: businesses.primaryPayableAccountRef,
              clearing: platformAccounts.ledgerAccountRef,
            })
            .from(payoutSettings)
            .innerJoin(businesses, eq(businesses.id, payoutSettings.businessId))
            .innerJoin(ledgers, eq(ledgers.slug, payoutSettings.ledger))
            .leftJoin(
              platformAccounts,
              and(eq(platformAccounts.ledger, payoutSettings.ledger), eq(platformAccounts.label, "payouts_clearing")),
            )
            .where(and(eq(payoutSettings.businessId, businessId), eq(payoutSettings.ledger, ledger)))
            .for("share", { of: payoutSettings }),
        )

        const settings = found[0]
        const payable = settings?.payable ?? null
        const clearing = settings?.clearing ?? null

        if (settings === undefined || payable === null || clearing === null) {
          return yield* Effect.die(new Error(`no settings, payable or payouts_clearing account for ${businessId} in ${ledger}`))
        }

        if (settings.mode === "automatic") {
          yield* closeDraft(payout.id, cancelledMark)

          return Ending.Closed({ error: new AutomaticError({ businessId, ledger }) })
        }

        const mismatch = yield* Effect.result(refuseMismatched(businessId, ledger))

        if (Result.isFailure(mismatch)) {
          yield* closeDraft(payout.id, cancelledMark)

          return Ending.Closed({ error: mismatch.failure })
        }

        // Re-validate currency rules in case a deploy changed them after draft creation.
        // The destination isn't compared with the saved one: a draft pays the
        // account copied at creation (decided 2026-11-12).
        const rules = rulesFor(settings.currency)

        if (rules === undefined || payout.amount < rules.minimum || !takesPayouts(rules, payout.bankCode)) {
          yield* closeDraft(payout.id, cancelledMark)

          return Ending.Closed({ error: new RulesChangedError({ id: payoutId }) })
        }

        yield* database.use((db) => db.update(payouts).set({ status: "requested" }).where(eq(payouts.id, payout.id)))

        yield* hold(payout, payable, clearing)

        return Ending.Done({ payout: yield* reread(businessId, id), confirmed: true })
      }),
    )

    return yield* Ending.$match(outcome, {
      Closed: ({ error }) => Effect.fail(error),
      Done: ({ payout, confirmed }) =>
        Effect.as(confirmed ? relay.nudge : Effect.void, { payout, confirmed } satisfies Confirmed),
    })
  })

  const schedule = Effect.fn("Payouts.schedule")(function* (
    businessId: Business.ID,
    ledger: Ledger.Slug,
    date: string,
    available: bigint,
  ) {
    // The first instant of `date` in UTC: a switch to automatic before it counts.
    const dayStart = sql`(${date}::date)::timestamp at time zone 'UTC'`

    const created = yield* database.transaction(
      Effect.gen(function* () {
        // Locked `FOR UPDATE` and read again, so a mode change, or another
        // plane running the same day, waits and then finds nothing due.
        const found = yield* database.use((db) =>
          db
            .select({
              ...settingsColumns,
              payable: businesses.primaryPayableAccountRef,
              clearing: platformAccounts.ledgerAccountRef,
            })
            .from(payoutSettings)
            .innerJoin(ledgers, eq(ledgers.slug, payoutSettings.ledger))
            .innerJoin(businesses, eq(businesses.id, payoutSettings.businessId))
            .leftJoin(
              platformAccounts,
              and(eq(platformAccounts.ledger, payoutSettings.ledger), eq(platformAccounts.label, "payouts_clearing")),
            )
            .where(and(
              eq(payoutSettings.businessId, businessId),
              eq(payoutSettings.ledger, ledger),
              eq(payoutSettings.mode, "automatic"),
              lt(payoutSettings.automaticSince, dayStart),
              or(isNull(payoutSettings.lastRunOn), lt(payoutSettings.lastRunOn, date)),
            ))
            .for("update", { of: payoutSettings }),
        )

        const row = found[0]

        if (row === undefined) {
          return null
        }

        // Paused fails the transaction, so the day stays due and is retried.
        yield* refuseMismatched(businessId, ledger)

        const rules = yield* rulesIn(businessId, ledger, row.currency)
        const payable = row.payable
        const clearing = row.clearing

        if (payable === null || clearing === null) {
          return yield* Effect.die(new Error(`no payable or payouts_clearing account for ${businessId} in ${ledger}`))
        }

        const ran = database.use((db) =>
          db
            .update(payoutSettings)
            // Not a settings change: `updated_at` keeps when the merchant last saved.
            .set({ lastRunOn: date, updatedAt: sql`${payoutSettings.updatedAt}` })
            .where(and(eq(payoutSettings.businessId, businessId), eq(payoutSettings.ledger, ledger))),
        )

        const destination = savedDestination(row.settings, row.name)
        const amount = available > maxAmount ? maxAmount : available

        // Too little to pay out: the day is done, and the money waits for the next run.
        if (amount < rules.minimum) {
          yield* ran

          return null
        }

        // The saved bank no longer takes payouts; until the merchant saves
        // another, every day is skipped, so say so.
        if (!takesPayouts(rules, destination.bankCode)) {
          yield* Effect.logWarning("automatic payout skipped: the saved bank no longer takes payouts", destination.bankCode)
          yield* ran

          return null
        }

        const inserted = yield* database.use((db) =>
          db
            .insert(payouts)
            .values({
              id: createId("pout"),
              businessId,
              ledger,
              amount,
              trigger: "scheduled",
              scheduledFor: date,
              idempotencyKey: `auto:${businessId}:${ledger}:${date}`,
              bankCode: destination.bankCode,
              accountNumber: destination.accountNumber,
              accountName: destination.accountName,
              status: "requested",
            })
            .onConflictDoNothing()
            .returning(),
        )

        yield* ran

        const payout = inserted[0]

        if (payout === undefined) {
          return null
        }

        yield* hold(payout, payable, clearing)

        return payout.id
      }),
    )

    if (created === null) {
      return null
    }

    yield* relay.nudge

    return yield* reread(businessId, created)
  })

  const list = Effect.fn("Payouts.list")(function* (businessId: Business.ID, before: Cursor | null) {
    const position = before === null ? null : yield* cursors.decode(before).pipe(Effect.mapError(() => new CursorError()))

    const listed = yield* selectPayouts(
      and(
        eq(payouts.businessId, businessId),
        listable(payouts),
        cursors.before(payouts.createdAt, payouts.id, position),
      ),
      pageSize + 1,
    )

    const { rows, next } = yield* cursors.page(listed, pageSize, (last) => ({ at: last.at, id: ID.make(last.payout.id) }))

    return new Page({ payouts: rows.map(payoutOf), next: next === null ? null : Cursor.make(next) })
  })

  const get = Effect.fn("Payouts.get")(function* (businessId: Business.ID, id: string) {
    const rows = yield* selectPayouts(and(eq(payouts.id, id), eq(payouts.businessId, businessId)), 1)
    const row = rows[0]

    if (row === undefined) {
      return yield* new PayoutNotFoundError({ id })
    }

    return payoutOf(row)
  })

  const report = Effect.fn("Payouts.report")(function* (id: ID, outcome: Outcome, providerRef: ProviderRef | null) {
    const reported = yield* database.transaction(
      Effect.gen(function* () {
        // Locked, so a ref the send stores meanwhile waits until this decides.
        const rows = yield* database.use((db) =>
          db.select({ status: payouts.status, stored: payouts.providerRef }).from(payouts).where(eq(payouts.id, id)).for("update"),
        )

        const row = rows[0]
        const stored = row?.stored ?? null

        if (row === undefined || row.status !== "sent") {
          return { kind: "ignored", stored } as const
        }

        // Another ref than the one stored: the provider may hold the payout twice.
        if (providerRef !== null && stored !== null && stored !== providerRef) {
          yield* database.use((db) => db.update(payouts).set({ status: "attention" }).where(eq(payouts.id, id)))

          return { kind: "mismatched", stored } as const
        }

        const ref = stored ?? providerRef

        if (outcome === "paid" && ref === null) {
          return { kind: "ignored", stored } as const
        }

        yield* database.use((db) =>
          db.update(payouts).set({ status: outcome, completedAt: sql`now()`, providerRef: ref }).where(eq(payouts.id, id)),
        )

        const decided = yield* database.use((db) =>
          db
            .update(ledgerPostings)
            .set({ resolution: outcome === "paid" ? "capture" : "void" })
            .where(
              and(eq(ledgerPostings.payoutId, id), eq(ledgerPostings.state, "pending"), isNull(ledgerPostings.resolution)),
            )
            .returning({ id: ledgerPostings.id }),
        )

        if (decided.length === 0) {
          return yield* Effect.die(new Error(`sent payout ${id} has no undecided hold`))
        }

        return { kind: "settled", stored } as const
      }),
    )

    const refs = { payoutId: id, storedRef: reported.stored, reportedRef: providerRef }

    switch (reported.kind) {
      case "mismatched":
        yield* Effect.logWarning("payout reported under another provider ref needs attention", outcome).pipe(Effect.annotateLogs(refs))

        return false
      case "ignored":
        yield* Effect.logWarning("payout report ignored: the payout isn't sent, or is paid with no reference", outcome).pipe(
          Effect.annotateLogs(refs),
        )

        return false
      case "settled":
        yield* relay.nudge

        return true
    }
  })

  return Service.of({ settings, banks, changeSettings, create, confirm, schedule, list, get, report })
})

export const layer = Layer.effect(Service)(make)

export * as Payouts from "./payouts.ts"
