import { NodeRuntime } from "@effect/platform-node";
import { Business } from "@pay-tty/core/business";
import { layer as DatabaseLayer } from "@pay-tty/core/database";
import { Catalog, LedgerClient, LedgerPostings, PayableAccounts, RelayNudge } from "@pay-tty/core/ledger";
import { Payments } from "@pay-tty/core/payments";
import { Payouts } from "@pay-tty/core/payouts";
import { AutomaticPayouts } from "@pay-tty/core/payouts/automatic";
import { PayoutDispatcher } from "@pay-tty/core/payouts/dispatcher";
import { SimProvider } from "@pay-tty/core/payouts/providers/sim";
import { Principal } from "@pay-tty/core/principal";
import { ConfigProvider, Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AuthenticationLive } from "../src/api/middleware/authentication.ts";
import { Plane } from "../src/api/server.ts";
import { Token } from "../src/token/token.ts";

const DomainLive = Layer.mergeAll(Principal.layer, Business.layer, Payments.layer, Payouts.layer).pipe(
  Layer.provide(Catalog.layer),
);

// The ledger service's HTTP API, at LEDGER_URL over fetch.
const LedgerClientLive = LedgerClient.layer.pipe(Layer.provide(FetchHttpClient.layer));

// v1 pays out through the simulated provider at SIM_URL; nothing reaches a bank.
const PayoutProviderLive = SimProvider.layer.pipe(Layer.provide(FetchHttpClient.layer));

// Balances and postings, both over the ledger's API.
const LedgerLive = Layer.mergeAll(PayableAccounts.layer, LedgerPostings.layer).pipe(Layer.provide(LedgerClientLive));

const RuntimeLive = Layer.mergeAll(AuthenticationLive, PayoutDispatcher.layer, AutomaticPayouts.layer).pipe(
  Layer.provideMerge(LedgerLive),
  Layer.provideMerge(Token.layer),
  Layer.provideMerge(PayoutProviderLive),
  Layer.provideMerge(DomainLive),
  Layer.provideMerge(RelayNudge.layer),
  Layer.provideMerge(DatabaseLayer),
);

// Every setting is read from the environment as PLANE_<name>.
const ConfigLive = ConfigProvider.layer(ConfigProvider.nested(ConfigProvider.fromEnv(), "PLANE"));

NodeRuntime.runMain(
  Layer.launch(Plane).pipe(Effect.provide(Layer.provideMerge(RuntimeLive, ConfigLive))),
);
