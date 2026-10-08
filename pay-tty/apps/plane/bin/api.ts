import { NodeRuntime } from "@effect/platform-node";
import { Business } from "@pay-tty/core/business";
import { Catalog } from "@pay-tty/core/catalog";
import { layer as DatabaseLayer } from "@pay-tty/core/database";
import { Principal } from "@pay-tty/core/principal";
import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AuthenticationLive } from "../src/api/middleware/authentication.ts";
import { Plane } from "../src/api/server.ts";
import { BusinessLedger } from "../src/ledger/business-ledger.ts";
import { LedgerClient } from "../src/ledger/client.ts";
import { Token } from "../src/token/token.ts";

const DomainLive = Layer.mergeAll(Principal.layer, Business.layer).pipe(
  Layer.provide(Catalog.layer),
);

// The ledger service's HTTP API, at LEDGER_BASE_URL over fetch.
const LedgerClientLive = LedgerClient.layer.pipe(Layer.provide(FetchHttpClient.layer));

const RuntimeLive = Layer.mergeAll(
  AuthenticationLive,
  BusinessLedger.layer.pipe(Layer.provide(LedgerClientLive)),
).pipe(
  Layer.provideMerge(Token.layer),
  Layer.provideMerge(DomainLive),
  Layer.provide(DatabaseLayer),
);

NodeRuntime.runMain(
  Layer.launch(Plane).pipe(Effect.provide(RuntimeLive)),
);
