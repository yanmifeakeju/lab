import { Context, Layer } from "effect"

import type { Principal } from "./principal.ts"

// The identity the current request acts as. Production supplies it from the
// authenticated caller; nothing here verifies it.
export class Service extends Context.Service<Service, Principal.Identity>()(
  "CurrentPrincipal",
) {}

export const layer = (identity: Principal.Identity) =>
  Layer.succeed(Service, identity)

export const development: Principal.Identity = {
  issuer: "development",
  subject: "local",
}

export * as CurrentPrincipal from "./current.ts"
