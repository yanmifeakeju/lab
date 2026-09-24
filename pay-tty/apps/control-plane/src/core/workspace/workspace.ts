import { Context, Layer, Schema } from "effect"

// A business's own database. Only a placeholder exists until Turso lands, when
// provisioning creates one per business and the handle moves onto the business.
export const Kind = Schema.Literal("dummy")

export type Kind = typeof Kind.Type

export class Info extends Schema.Class<Info>("Workspace.Info")({
  kind: Kind,
  handle: Schema.String,
}) {}

export class Service extends Context.Service<Service, Info>()("Workspace") {}

export const dummyLayer = Layer.succeed(
  Service,
  new Info({ kind: "dummy", handle: "dummy" }),
)

export * as Workspace from "./workspace.ts"
