import { after } from "node:test"

import { Testing } from "@pay-tty/database/testing"
import { Layer, ManagedRuntime } from "effect"

import { Business } from "../src/business/business.ts"
import { Catalog } from "../src/ledger/catalog.ts"
import { Payments } from "../src/payments/payments.ts"
import { Principal } from "../src/principal/principal.ts"
import { schema } from "../src/testing/setup.ts"

const db = await Testing.withDatabase(schema)

/** This file's own plane database; each build opens a pool on it. */
export const database = db.layer

// Shared runtime with a single connection pool over this file's database.
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(Principal.layer, Business.layer, Payments.layer).pipe(
    Layer.provideMerge(Catalog.layer),
    Layer.provideMerge(database),
  ),
)

// Close the pools, then drop, even if closing fails.
after(() => runtime.dispose().finally(() => db.drop()))
