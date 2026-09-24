import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { Business } from "../src/core/business/business.ts"
import { layer as DatabaseLive } from "../src/database/client.ts"
import { LedgerClient } from "../src/core/ledger/client.ts"
import { Ledgers } from "../src/core/ledger/ledgers.ts"
import { CurrentPrincipal } from "../src/core/principal/current.ts"
import { Principal } from "../src/core/principal/principal.ts"
import { Provisioning } from "../src/core/provisioning/provisioning.ts"
import { ControlPlane } from "../src/server/server.ts"
import { Session } from "../src/core/session/session.ts"
import { Workspace } from "../src/core/workspace/workspace.ts"

const DomainLive = Layer.mergeAll(Principal.layer, Business.layer, Ledgers.layer)

const RuntimeLive = Layer.mergeAll(
  Provisioning.layer.pipe(
    Layer.provide(LedgerClient.layer.pipe(Layer.provide(FetchHttpClient.layer))),
  ),
  Session.layer.pipe(Layer.provide(Workspace.dummyLayer)),
  CurrentPrincipal.layer(CurrentPrincipal.development),
).pipe(Layer.provide(DomainLive), Layer.provide(DatabaseLive))

NodeRuntime.runMain(
  Layer.launch(ControlPlane).pipe(Effect.provide(RuntimeLive)),
)
