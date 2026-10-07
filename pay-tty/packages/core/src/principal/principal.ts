import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"

import { Database } from "../database/client.ts"
import { createId } from "../database/ids.ts"
import { principals } from "./sql.ts"

export const ID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("prn_")),
  Schema.brand("Principal.ID"),
)

export type ID = typeof ID.Type

// Who is connecting, as asserted by the authenticated caller: the SSH front end
// issues it and the subject is the key fingerprint.
export const Identity = Schema.Struct({
  issuer: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
})

export type Identity = typeof Identity.Type

export class Info extends Schema.Class<Info>("Principal.Info")({
  id: ID,
  issuer: Schema.String,
  subject: Schema.String,
  createdAt: Schema.Date,
}) {}

export interface Interface {
  readonly find: (identity: Identity) => Effect.Effect<Info | undefined>
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Returns the principal for an identity, recording it on first sight. */
  readonly ensure: (identity: Identity) => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("Principal") {}

const fromRow = (row: typeof principals.$inferSelect) =>
  new Info({
    id: ID.make(row.id),
    issuer: row.issuer,
    subject: row.subject,
    createdAt: row.createdAt,
  })

const make = Effect.gen(function* () {
  const database = yield* Database

  const find = Effect.fn("Principal.find")(function* (identity: Identity) {
    const rows = yield* database.use((db) =>
      db
        .select()
        .from(principals)
        .where(
          and(
            eq(principals.issuer, identity.issuer),
            eq(principals.subject, identity.subject),
          ),
        )
        .limit(1),
    )

    const row = rows[0]

    return row === undefined ? undefined : fromRow(row)
  })

  const get = Effect.fn("Principal.get")(function* (id: ID) {
    const rows = yield* database.use((db) =>
      db.select().from(principals).where(eq(principals.id, id)),
    )

    const row = rows[0]

    return row === undefined ? undefined : fromRow(row)
  })

  const ensure = Effect.fn("Principal.ensure")(function* (identity: Identity) {
    // The unique (issuer, subject) index settles concurrent first sightings;
    // the loser's insert is a no-op and both read the same row back.
    yield* database.use((db) =>
      db
        .insert(principals)
        .values({
          id: createId("prn"),
          issuer: identity.issuer,
          subject: identity.subject,
        })
        .onConflictDoNothing({ target: [principals.issuer, principals.subject] }),
    )

    const principal = yield* find(identity)

    if (principal === undefined) {
      return yield* Effect.die(new Error("principal missing after insert"))
    }

    return principal
  })

  return Service.of({ find, get, ensure })
})

export const layer = Layer.effect(Service)(make)

export * as Principal from "./principal.ts"
