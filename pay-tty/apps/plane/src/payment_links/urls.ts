import { Config, Context, Effect, Layer, Schema } from "effect"

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "PaymentLinkUrls.ConfigError",
  { message: Schema.String },
) {}

export interface Interface {
  /** The public URL a link's share token is served at. */
  readonly urlFor: (shareToken: string) => string
}

export class Service extends Context.Service<Service, Interface>()("PaymentLinkUrls") {}

/** Checks a base URL and gives it the trailing slash a token is appended to. */
export const base = (raw: string) =>
  Effect.gen(function* () {
    const invalid = new ConfigError({
      message: "PAYMENT_LINK_BASE_URL must be an absolute http(s) URL without credentials, query, or fragment",
    })

    if (!URL.canParse(raw) || raw.includes("?") || raw.includes("#")) {
      return yield* invalid
    }

    const url = new URL(raw)

    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
      return yield* invalid
    }

    return url.href.endsWith("/") ? url.href : `${url.href}/`
  })

const make = (prefix: string) => Service.of({ urlFor: (shareToken) => `${prefix}${shareToken}` })

export const layerFrom = (raw: string) => Layer.effect(Service)(Effect.map(base(raw), make))

/** Reads `PAYMENT_LINK_BASE_URL`, and refuses to build without a valid one. */
export const layer = Layer.effect(Service)(
  Effect.gen(function* () {
    return make(yield* base(yield* Config.String("PAYMENT_LINK_BASE_URL")))
  }),
)

export * as PaymentLinkUrls from "./urls.ts"
