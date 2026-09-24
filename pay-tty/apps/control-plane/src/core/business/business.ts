import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { Database } from "../../database/client.ts";
import { createId } from "../../database/ids.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { Principal } from "../principal/principal.ts";
import { principals } from "../principal/sql.ts";
import {
  businesses,
  businessLedgerAccounts,
  businessPrincipals,
  kinds,
  statuses,
  steps,
} from "./sql.ts";

export const ID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("biz_")),
  Schema.brand("Business.ID"),
);

export type ID = typeof ID.Type;

export const ProvisioningStatus = Schema.Literals(statuses);

export type ProvisioningStatus = typeof ProvisioningStatus.Type;

export const ProvisioningStep = Schema.Literals(steps);

export type ProvisioningStep = typeof ProvisioningStep.Type;

export class Details extends Schema.Class<Details>("Business.Details")({
  name: Schema.NonEmptyString,
}) {}

export const Kind = Schema.Literals(kinds)

export type Kind = typeof Kind.Type

export class PayableAccount extends Schema.Class<PayableAccount>(
  "Business.PayableAccount",
)({
  holderRef: Schema.String,
  accountRef: Schema.String,
}) {}

export class LedgerAccount extends Schema.Class<LedgerAccount>(
  "Business.LedgerAccount",
)({
  ledger: Ledger.Slug,
  kind: Kind,
  label: Schema.NullOr(Ledger.Label),
  ref: Schema.String,
}) {}

export class Failure extends Schema.Class<Failure>("Business.Failure")({
  code: Schema.String,
  message: Schema.String,
}) {}

export class Info extends Schema.Class<Info>("Business.Info")({
  id: ID,
  name: Schema.String,
  defaultLedger: Ledger.Slug,
  ledgerHolderRef: Schema.NullOr(Schema.String),
  provisioningStatus: ProvisioningStatus,
  provisioningStep: ProvisioningStep,
  failure: Schema.NullOr(Failure),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "Business.NotFoundError",
  { id: ID },
) {}

export interface Interface {
  readonly findByPrincipal: (
    principalId: Principal.ID,
  ) => Effect.Effect<Info | undefined>;
  /** Idempotent per principal: a repeat returns the business already created. */
  readonly create: (
    principalId: Principal.ID,
    details: Details,
    defaultLedger: Ledger.Slug,
  ) => Effect.Effect<Info>;
  /** The payable account in a ledger, if the business has been provisioned there. */
  readonly payableAccount: (
    id: ID,
    ledger: Ledger.Slug,
  ) => Effect.Effect<string | undefined>
  /** Every account the business holds, across ledgers. */
  readonly ledgerAccounts: (id: ID) => Effect.Effect<ReadonlyArray<LedgerAccount>>
  /** Records a payable account the ledger created; repeating it is a no-op. */
  readonly recordPayableAccount: (
    id: ID,
    ledger: Ledger.Slug,
    account: PayableAccount,
  ) => Effect.Effect<void, NotFoundError>
  readonly advance: (id: ID, step: ProvisioningStep) => Effect.Effect<Info, NotFoundError>
  readonly stall: (
    id: ID,
    step: ProvisioningStep,
    failure: Failure,
  ) => Effect.Effect<Info, NotFoundError>;
  readonly activate: (id: ID) => Effect.Effect<Info, NotFoundError>;
}

export class Service
  extends Context.Service<Service, Interface>()("Business") {}

const make = Effect.gen(function* () {
  const db = yield* Database;

  const load = Effect.fnUntraced(function* (id: string) {
    const rows = yield* Effect.promise(() =>
      db.select().from(businesses).where(eq(businesses.id, id)),
    )

    const row = rows[0]

    if (row === undefined) {
      return undefined
    }

    // The failure check keeps code and message all-or-nothing.
    return new Info({
      id: ID.make(row.id),
      name: row.name,
      defaultLedger: Ledger.Slug.make(row.defaultLedger),
      ledgerHolderRef: row.ledgerHolderRef,
      provisioningStatus: row.provisioningStatus,
      provisioningStep: row.provisioningStep,
      failure:
        row.failureCode !== null && row.failureMessage !== null
          ? new Failure({ code: row.failureCode, message: row.failureMessage })
          : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  })

  const loadExisting = Effect.fnUntraced(function* (id: string) {
    const business = yield* load(id);

    if (business === undefined) {
      return yield* Effect.die(new Error(`business vanished: ${id}`));
    }

    return business;
  });

  const update = Effect.fnUntraced(function* (
    id: ID,
    set: Partial<typeof businesses.$inferInsert>,
  ) {
    const rows = yield* Effect.promise(() =>
      db
        .update(businesses)
        .set(set)
        .where(eq(businesses.id, id))
        .returning({ id: businesses.id })
    );

    if (rows[0] === undefined) {
      return yield* new NotFoundError({ id });
    }

    return yield* loadExisting(id);
  });

  const findByPrincipal = Effect.fn("Business.findByPrincipal")(function* (
    principalId: Principal.ID,
  ) {
    const links = yield* Effect.promise(() =>
      db
        .select({ businessId: businessPrincipals.businessId })
        .from(businessPrincipals)
        .where(eq(businessPrincipals.principalId, principalId))
    );

    const link = links[0];

    return link === undefined
      ? undefined
      : yield* loadExisting(link.businessId);
  });

  const create = Effect.fn("Business.create")(function* (
    principalId: Principal.ID,
    details: Details,
    defaultLedger: Ledger.Slug,
  ) {
    // Locking the principal row serialises concurrent creates for it, so the
    // second one finds the first one's business instead of making another.
    const id = yield* Effect.promise(() =>
      db.transaction((tx) =>
        tx
          .select({ id: principals.id })
          .from(principals)
          .where(eq(principals.id, principalId))
          .for("update")
          .then((locked) =>
            locked[0] === undefined ? undefined : tx
              .select({ businessId: businessPrincipals.businessId })
              .from(businessPrincipals)
              .where(eq(businessPrincipals.principalId, principalId))
              .then((links) => {
                const existing = links[0];

                if (existing !== undefined) {
                  return existing.businessId;
                }

                const businessId = createId("biz");

                return tx
                  .insert(businesses)
                  .values({
                    id: businessId,
                    name: details.name,
                    defaultLedger,
                  })
                  .then(() =>
                    tx
                      .insert(businessPrincipals)
                      .values({ principalId, businessId })
                  )
                  .then(() => businessId);
              })
          )
      )
    );

    if (id === undefined) {
      return yield* Effect.die(
        new Error(`principal not found: ${principalId}`),
      );
    }

    return yield* loadExisting(id);
  });

  const payableAccount = Effect.fn("Business.payableAccount")(function* (
    id: ID,
    ledger: Ledger.Slug,
  ) {
    const rows = yield* Effect.promise(() =>
      db
        .select({ ref: businessLedgerAccounts.ledgerAccountRef })
        .from(businessLedgerAccounts)
        .where(
          and(
            eq(businessLedgerAccounts.businessId, id),
            eq(businessLedgerAccounts.ledger, ledger),
            eq(businessLedgerAccounts.kind, "payable"),
          ),
        ),
    )

    return rows[0]?.ref
  })

  const ledgerAccounts = Effect.fn("Business.ledgerAccounts")(function* (id: ID) {
    const rows = yield* Effect.promise(() =>
      db
        .select()
        .from(businessLedgerAccounts)
        .where(eq(businessLedgerAccounts.businessId, id)),
    )

    return rows.map(
      (row) =>
        new LedgerAccount({
          ledger: Ledger.Slug.make(row.ledger),
          kind: row.kind,
          label: row.label,
          ref: row.ledgerAccountRef,
        }),
    )
  })

  const recordPayableAccount = Effect.fn("Business.recordPayableAccount")(
    function* (id: ID, ledger: Ledger.Slug, account: PayableAccount) {
      // The ledger keys holders by business, so every ledger must hand back
      // the holder the first one did.
      const holders = yield* Effect.promise(() =>
        db
          .update(businesses)
          .set({
            ledgerHolderRef: sql`coalesce(${businesses.ledgerHolderRef}, ${account.holderRef})`,
          })
          .where(eq(businesses.id, id))
          .returning({ holderRef: businesses.ledgerHolderRef }),
      )

      const holder = holders[0]

      if (holder === undefined) {
        return yield* new NotFoundError({ id })
      }

      if (holder.holderRef !== account.holderRef) {
        return yield* Effect.die(
          new Error(`business ${id} already holds ${holder.holderRef}, ledger returned ${account.holderRef}`),
        )
      }

      yield* Effect.promise(() =>
        db
          .insert(businessLedgerAccounts)
          .values({
            businessId: id,
            ledger,
            kind: "payable",
            ledgerAccountRef: account.accountRef,
          })
          .onConflictDoNothing(),
      )

      const recorded = yield* payableAccount(id, ledger)

      if (recorded !== account.accountRef) {
        return yield* Effect.die(
          new Error(`business ${id} already holds ${recorded} in ${ledger}, ledger returned ${account.accountRef}`),
        )
      }
    },
  )

  const advance = Effect.fn("Business.advance")(function* (id: ID, step: ProvisioningStep) {
    return yield* update(id, {
      provisioningStatus: "provisioning",
      provisioningStep: step,
      failureCode: null,
      failureMessage: null,
    })
  })

  const stall = Effect.fn("Business.stall")(function* (
    id: ID,
    step: ProvisioningStep,
    failure: Failure,
  ) {
    return yield* update(id, {
      provisioningStatus: "stalled",
      provisioningStep: step,
      failureCode: failure.code,
      failureMessage: failure.message,
    });
  });

  const activate = Effect.fn("Business.activate")(function* (id: ID) {
    return yield* update(id, {
      provisioningStatus: "active",
      failureCode: null,
      failureMessage: null,
    });
  });

  return Service.of({
    findByPrincipal,
    create,
    payableAccount,
    ledgerAccounts,
    recordPayableAccount,
    advance,
    stall,
    activate,
  });
});

export const layer = Layer.effect(Service)(make);

export * as Business from "./business.ts";
