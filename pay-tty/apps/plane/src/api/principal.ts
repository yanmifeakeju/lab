import type { Principal } from "@pay-tty/core/principal"
import { Context } from "effect"

// The principal the current request acts as, as stored, provided per request
// by the Authentication middleware once the caller's token checks out.
export class Service extends Context.Service<Service, Principal.Info>()(
  "CurrentPrincipal",
) {}

export * as CurrentPrincipal from "./principal.ts"
