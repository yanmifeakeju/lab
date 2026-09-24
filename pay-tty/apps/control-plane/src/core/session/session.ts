import { Context, Effect, Layer, Schema } from "effect"

import { Business } from "../business/business.ts"
import type { Ledger } from "../ledger/ledger.ts"
import { Ledgers } from "../ledger/ledgers.ts"
import { Principal } from "../principal/principal.ts"
import { Provisioning } from "../provisioning/provisioning.ts"
import { Workspace } from "../workspace/workspace.ts"

// The identifiers keep the names the API has always published, so the
// OpenAPI document and generated clients don't change with the module layout.

export class Progress extends Schema.Class<Progress>("ProgressStep")({
  id: Schema.String,
  status: Schema.Literals([
    "pending",
    "in_progress",
    "completed",
    "deferred",
    "stalled",
  ]),
}) {}

export class Failure extends Schema.Class<Failure>("RegistrationFailure")({
  step: Schema.String,
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

export class BusinessConfig extends Schema.Class<BusinessConfig>("BusinessConfig")({
  id: Schema.String,
  name: Schema.String,
}) {}

export class PlatformAccountConfig extends Schema.Class<PlatformAccountConfig>(
  "PlatformAccountConfig",
)({
  cash: Schema.String,
  fee: Schema.String,
}) {}

export class LedgerConfig extends Schema.Class<LedgerConfig>("LedgerConfig")({
  slug: Schema.String,
  currency: Schema.String,
  // Minor-unit digits: every amount in this ledger is an integer count of them.
  scale: Schema.Int,
  payableAccountRef: Schema.String,
  platformAccounts: PlatformAccountConfig,
}) {}

export class WorkspaceConfig extends Schema.Class<WorkspaceConfig>("WorkspaceConfig")({
  kind: Workspace.Kind,
  handle: Schema.String,
}) {}

export class Config extends Schema.Class<Config>("SessionConfig")({
  business: BusinessConfig,
  ledger: LedgerConfig,
  workspace: WorkspaceConfig,
}) {}

export class Resolution extends Schema.Class<Resolution>("ResolveResponse")({
  status: Schema.Literals(["unknown", "provisioning", "stalled", "active"]),
  steps: Schema.Array(Progress),
  sessionConfig: Schema.NullOr(Config),
  failure: Schema.NullOr(Failure),
}) {}

export interface Interface {
  /**
   * What a connecting principal's session runs against: unknown, still being
   * provisioned, stalled, or active with its default ledger's config.
   */
  readonly resolve: (identity: Principal.Identity) => Effect.Effect<Resolution>
}

export class Service extends Context.Service<Service, Interface>()("Session") {}

const unknown = new Resolution({
  status: "unknown",
  steps: [],
  sessionConfig: null,
  failure: null,
})

const progress = (business: Business.Info) => {
  const ledgerStatus =
    business.provisioningStatus === "active" ||
    business.provisioningStep === "workspace"
      ? "completed"
      : business.provisioningStatus === "stalled"
        ? "stalled"
        : "in_progress"

  return [
    new Progress({ id: "business", status: "completed" }),
    new Progress({ id: "ledger", status: ledgerStatus }),
    new Progress({ id: "workspace", status: "deferred" }),
  ]
}

const failure = (business: Business.Info) =>
  business.failure === null
    ? null
    : new Failure({
        step: business.provisioningStep,
        code: business.failure.code,
        message: business.failure.message,
        retryable:
          business.failure.code !== Provisioning.failureCodes.ledgerRejected,
      })

const make = Effect.gen(function* () {
  const principals = yield* Principal.Service
  const businesses = yield* Business.Service
  const ledgers = yield* Ledgers.Service
  const workspace = yield* Workspace.Service

  // Provisioning activates a business only once it holds a payable account in
  // its default ledger, so either gap here is a bug.
  const sessionConfig = Effect.fnUntraced(function* (business: Business.Info) {
    const ledger = ledgers.get(business.defaultLedger)

    if (ledger === undefined) {
      return yield* Effect.die(
        new Error(`ledger ${business.defaultLedger} was not loaded at startup`),
      )
    }

    const accounts = (yield* businesses.ledgerAccounts(business.id)).filter(
      (account) => account.ledger === ledger.slug,
    )

    const payable = accounts.find((account) => account.kind === "payable")

    if (payable === undefined) {
      return yield* Effect.die(
        new Error(`active business ${business.id} has no payable account in ${ledger.slug}`),
      )
    }

    const platform = (label: Ledger.Label) =>
      accounts.find((account) => account.kind === "platform" && account.label === label)
        ?.ref ?? ledger.platformAccounts[label]

    return new Config({
      business: new BusinessConfig({ id: business.id, name: business.name }),
      ledger: new LedgerConfig({
        slug: ledger.slug,
        currency: ledger.currency,
        scale: ledger.scale,
        payableAccountRef: payable.ref,
        platformAccounts: new PlatformAccountConfig({
          cash: platform("cash"),
          fee: platform("fee"),
        }),
      }),
      workspace: new WorkspaceConfig({ kind: workspace.kind, handle: workspace.handle }),
    })
  })

  const resolve = Effect.fn("Session.resolve")(function* (identity: Principal.Identity) {
    const principal = yield* principals.find(identity)

    if (principal === undefined) {
      return unknown
    }

    const business = yield* businesses.findByPrincipal(principal.id)

    if (business === undefined) {
      return unknown
    }

    return new Resolution({
      status: business.provisioningStatus,
      steps: progress(business),
      sessionConfig:
        business.provisioningStatus === "active" ? yield* sessionConfig(business) : null,
      failure: failure(business),
    })
  })

  return Service.of({ resolve })
})

export const layer = Layer.effect(Service)(make)

export * as Session from "./session.ts"
