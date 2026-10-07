import { Principal } from "@pay-tty/core/principal"
import { Clock, Config, Context, DateTime, Effect, Encoding, Layer, Redacted, Result, Schema } from "effect"
import { jwtVerify, SignJWT } from "jose"

// Plane's access tokens. Plane both issues and verifies them, so a shared
// HS256 key is enough; the gateway holds tokens, never the key.

export const issuer = "pay-tty-plane"

export const audience = "pay-tty-plane"

export const type = "at+jwt"

/** Seconds a token is valid for. */
export const lifetime = 15 * 60

/** Seconds of clock difference tolerated when checking iat and exp. */
export const skew = 30

const keyIdPattern = /^[A-Za-z0-9_-]{1,64}$/

// Tokens name a principal by its internal ID, never by the asserted identity.
const Subject = Principal.ID.check(Schema.isPattern(/^prn_[0-9A-HJKMNP-TV-Z]{26}$/))

export class Key extends Schema.Class<Key>("Token.Key")({
  id: Schema.String.check(Schema.isPattern(keyIdPattern)),
  secret: Schema.Uint8Array.check(
    Schema.makeFilter((bytes: Uint8Array) => bytes.length >= 32, {
      expected: "a secret of at least 32 bytes",
    }),
  ),
}) {}

/**
 * Every key a token may be verified with, and the one new tokens are signed
 * with. Rotation adds a key, moves signing to it, and removes the old one once
 * every token it signed has expired.
 */
export class Keys extends Schema.Class<Keys>("Token.Keys")({
  signing: Key,
  verifying: Schema.Array(Key),
}) {}

export class KeyConfigError extends Schema.TaggedError<KeyConfigError>()(
  "Token.KeyConfigError",
  { message: Schema.String },
) {}

// The reason is for logs; callers only learn the token was rejected.
export class InvalidTokenError extends Schema.TaggedError<InvalidTokenError>()(
  "Token.InvalidTokenError",
  { reason: Schema.String },
) {}

export interface Issued {
  readonly accessToken: Redacted.Redacted<string>
  readonly expiresIn: number
}

export interface Interface {
  readonly issue: (principal: Principal.ID) => Effect.Effect<Issued>
  /** The principal a token names, once its signature and claims check out. */
  readonly verify: (token: string) => Effect.Effect<Principal.ID, InvalidTokenError>
}

export class Service extends Context.Service<Service, Interface>()("Token") {}

/**
 * Reads `PLANE_TOKEN_KEYS`, comma-separated `<key id>:<base64url secret>`
 * entries, and `PLANE_TOKEN_SIGNING_KEY_ID`, which must name one of them.
 */
export const keysFromConfig = Effect.gen(function* () {
  const entries = Redacted.value(yield* Config.Redacted("PLANE_TOKEN_KEYS"))
  const signingId = yield* Config.String("PLANE_TOKEN_SIGNING_KEY_ID")

  const verifying = yield* Effect.forEach(entries.split(","), (entry) => {
    const [id = "", encoded = "", ...rest] = entry.trim().split(":")
    const secret = Encoding.decodeBase64Url(encoded)

    // Re-encoding catches characters the decoder would skip over.
    if (rest.length > 0 || Result.isFailure(secret) || Encoding.encodeBase64Url(secret.success) !== encoded) {
      return Effect.fail(new KeyConfigError({ message: `PLANE_TOKEN_KEYS: key "${id}" is not <id>:<base64url secret>` }))
    }

    return Schema.decodeEffect(Key)({ id, secret: secret.success }).pipe(
      Effect.mapError(() =>
        new KeyConfigError({ message: `PLANE_TOKEN_KEYS: key "${id}" needs an id of [A-Za-z0-9_-] and a secret of at least 32 bytes` }),
      ),
    )
  })

  if (new Set(verifying.map((key) => key.id)).size !== verifying.length) {
    return yield* new KeyConfigError({ message: "PLANE_TOKEN_KEYS: key ids must be unique" })
  }

  const signing = verifying.find((key) => key.id === signingId)

  if (signing === undefined) {
    return yield* new KeyConfigError({
      message: `PLANE_TOKEN_SIGNING_KEY_ID: "${signingId}" is not in PLANE_TOKEN_KEYS`,
    })
  }

  return new Keys({ signing, verifying })
})

const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

const make = (keys: Keys) => {
  const byId = new Map(keys.verifying.map((key) => [key.id, key.secret]))

  const issue = Effect.fn("Token.issue")(function* (principal: Principal.ID) {
    const now = yield* nowSeconds

    const token = yield* Effect.promise(() =>
      new SignJWT()
        .setProtectedHeader({ alg: "HS256", typ: type, kid: keys.signing.id })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(principal)
        .setIssuedAt(now)
        .setExpirationTime(now + lifetime)
        .sign(keys.signing.secret),
    )

    return { accessToken: Redacted.make(token), expiresIn: lifetime }
  })

  const verify = Effect.fn("Token.verify")(function* (token: string) {
    const now = DateTime.toDate(yield* DateTime.now)

    const { payload } = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(
          token,
          // Only a configured key id selects a key; anything else is rejected.
          (header) => {
            const secret = byId.get(header.kid ?? "")

            if (secret === undefined) {
              throw new Error("unknown key id")
            }

            return secret
          },
          {
            algorithms: ["HS256"],
            issuer,
            audience,
            typ: type,
            requiredClaims: ["iat", "exp", "sub"],
            clockTolerance: skew,
            maxTokenAge: lifetime,
            currentDate: now,
          },
        ),
      catch: (cause) => new InvalidTokenError({ reason: cause instanceof Error ? cause.message : "unverifiable" }),
    })

    // A token valid for longer than plane ever issues wasn't issued by it.
    if (payload.exp === undefined || payload.iat === undefined || payload.exp - payload.iat > lifetime) {
      return yield* new InvalidTokenError({ reason: "lifetime exceeds the issued maximum" })
    }

    return yield* Schema.decodeUnknownEffect(Subject)(payload.sub).pipe(
      Effect.mapError(() => new InvalidTokenError({ reason: "subject is not a principal id" })),
    )
  })

  return Service.of({ issue, verify })
}

export const layerFrom = (keys: Keys) => Layer.succeed(Service, make(keys))

export const layer = Layer.effect(Service)(Effect.map(keysFromConfig, make))

export * as Token from "./token.ts"
