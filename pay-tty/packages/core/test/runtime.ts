import { after } from "node:test"

import { Layer, ManagedRuntime } from "effect"

import { Business } from "../src/business/business.ts"
import { layer as DatabaseLayer } from "../src/database/client.ts"
import { Ledgers } from "../src/ledger/ledgers.ts"
import { Principal } from "../src/principal/principal.ts"

// One pool per test file, over the database the global setup created.
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(Principal.layer, Business.layer, Ledgers.layer).pipe(
    Layer.provideMerge(DatabaseLayer),
  ),
)

after(() => runtime.dispose())
