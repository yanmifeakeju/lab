import assert from "node:assert/strict"
import { test } from "node:test"

import { DateTime, Effect, Layer } from "effect"

import { Business } from "../src/core/business/business.ts"
import { Currency } from "../src/core/ledger/currency.ts"
import { Ledger } from "../src/core/ledger/ledger.ts"
import { Ledgers } from "../src/core/ledger/ledgers.ts"
import { Principal } from "../src/core/principal/principal.ts"
import { Provisioning } from "../src/core/provisioning/provisioning.ts"
import { Session } from "../src/core/session/session.ts"
import { Workspace } from "../src/core/workspace/workspace.ts"

const identity = { issuer: "test", subject: "merchant" }

const now = DateTime.toDate(DateTime.nowUnsafe())

const principal = new Principal.Info({
  id: Principal.ID.make("prn_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
  issuer: identity.issuer,
  subject: identity.subject,
  createdAt: now,
})

const fields = {
  id: Business.ID.make("biz_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
  name: "Acme Ltd",
  defaultLedger: Ledger.ngn,
  ledgerHolderRef: null,
  provisioningStatus: "provisioning",
  provisioningStep: "ledger",
  failure: null,
  createdAt: now,
  updatedAt: now,
} as const

const business = new Business.Info(fields)

const active = new Business.Info({
  ...fields,
  ledgerHolderRef: "hld_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  provisioningStatus: "active",
  provisioningStep: "workspace",
})

const stalled = (code: string) =>
  new Business.Info({
    ...fields,
    provisioningStatus: "stalled",
    failure: new Business.Failure({ code, message: "The ledger account could not be initialized." }),
  })

const ngn = new Ledgers.Info({
  slug: Ledger.ngn,
  currency: Currency.Code.make("NGN"),
  scale: 2,
  platformAccounts: new Ledgers.PlatformAccounts({ cash: "acct_default_cash", fee: "acct_default_fee" }),
})

const account = (kind: Business.Kind, label: Ledger.Label | null, ref: string) =>
  new Business.LedgerAccount({ ledger: Ledger.ngn, kind, label, ref })

const resolve = (
  found: Business.Info | undefined,
  accounts: ReadonlyArray<Business.LedgerAccount> = [],
  known = true,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service

      return yield* session.resolve(identity)
    }).pipe(
      Effect.provide(
        Session.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Principal.Service, {
                find: () => Effect.succeed(known ? principal : undefined),
              }),
              Layer.mock(Business.Service, {
                findByPrincipal: () => Effect.succeed(found),
                ledgerAccounts: () => Effect.succeed(accounts),
              }),
              Layer.mock(Ledgers.Service, { get: (slug) => (slug === Ledger.ngn ? ngn : undefined) }),
              Workspace.dummyLayer,
            ),
          ),
        ),
      ),
    ),
  )

void test("reports an unknown principal as unknown", () =>
  resolve(undefined, [], false).then((response) => {
    assert.equal(response.status, "unknown")
    assert.deepEqual(response.steps, [])
    assert.equal(response.sessionConfig, null)
    assert.equal(response.failure, null)
  }),
)

void test("reports a principal without a business as unknown", () =>
  resolve(undefined).then((response) => {
    assert.equal(response.status, "unknown")
  }),
)

void test("reports the ledger step in progress while provisioning", () =>
  resolve(business).then((response) => {
    assert.equal(response.status, "provisioning")
    assert.deepEqual(
      response.steps.map((step) => step.status),
      ["completed", "in_progress", "deferred"],
    )
    assert.equal(response.sessionConfig, null)
  }),
)

void test("marks an unavailable ledger as retryable", () =>
  resolve(stalled(Provisioning.failureCodes.ledgerUnavailable)).then((response) => {
    assert.equal(response.status, "stalled")
    assert.equal(response.steps[1]?.status, "stalled")
    assert.equal(response.failure?.step, "ledger")
    assert.equal(response.failure?.retryable, true)
  }),
)

void test("marks a rejected ledger request as not retryable", () =>
  resolve(stalled(Provisioning.failureCodes.ledgerRejected)).then((response) => {
    assert.equal(response.failure?.code, "ledger_rejected")
    assert.equal(response.failure?.retryable, false)
  }),
)

void test("builds the default ledger's config, falling back to platform defaults", () =>
  resolve(active, [
    account("payable", null, "acct_payable"),
    account("platform", "fee", "acct_override_fee"),
  ]).then((response) => {
    assert.equal(response.status, "active")
    assert.equal(response.failure, null)
    assert.deepEqual(
      response.steps.map((step) => step.status),
      ["completed", "completed", "deferred"],
    )

    const ledger = response.sessionConfig?.ledger

    assert.equal(ledger?.slug, "ngn_ng")
    assert.equal(ledger?.currency, "NGN")
    assert.equal(ledger?.scale, 2)
    assert.equal(ledger?.payableAccountRef, "acct_payable")
    assert.equal(ledger?.platformAccounts.cash, "acct_default_cash")
    assert.equal(ledger?.platformAccounts.fee, "acct_override_fee")
  }),
)
