import assert from "node:assert/strict"
import { test } from "node:test"

import { eq, sql } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect"

import { Database } from "../src/database/client.ts"
import { createId } from "../src/database/ids.ts"
import { principals } from "../src/principal/sql.ts"
import { runtime } from "./runtime.ts"

class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}

const insert = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((db) => db.insert(principals).values({ id, issuer: "database-test", subject: id }))
  })

// Read on the pool, outside any transaction: only committed rows are visible.
const committed = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    const rows = yield* database.use((db) => db.select().from(principals).where(eq(principals.id, id)))

    return rows.length === 1
  })

const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = yield* Database

    return yield* database.transaction(effect)
  })

void test("commits the transaction's writes when it succeeds", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const first = createId("prn")
      const second = createId("prn")

      yield* transaction(Effect.andThen(insert(first), insert(second)))

      assert.equal(yield* committed(first), true)
      assert.equal(yield* committed(second), true)
    }),
  ))

void test("rolls back and surfaces a typed failure unchanged", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const id = createId("prn")

      const exit = yield* Effect.exit(transaction(Effect.andThen(insert(id), Effect.fail(new Boom()))))

      assert.ok(Exit.isFailure(exit) && Cause.hasFails(exit.cause))
      assert.equal(yield* committed(id), false)
    }),
  ))

void test("rolls back on a defect", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const id = createId("prn")

      const exit = yield* Effect.exit(transaction(Effect.andThen(insert(id), Effect.die("defect"))))

      assert.ok(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
      assert.equal(yield* committed(id), false)
    }),
  ))

void test("rolls back when interrupted", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const id = createId("prn")
      const inserted = yield* Deferred.make<void>()

      const fiber = yield* Effect.forkChild(
        transaction(insert(id).pipe(Effect.andThen(Deferred.succeed(inserted, undefined)), Effect.andThen(Effect.never))),
      )

      yield* Deferred.await(inserted)
      yield* Fiber.interrupt(fiber)

      // Waits on the open transaction's row lock, then succeeds only if that
      // transaction rolled back rather than committing the same key.
      yield* insert(id)
    }),
  ))

void test("a nested transaction joins the outer one", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const outer = createId("prn")
      const inner = createId("prn")

      const exit = yield* Effect.exit(
        transaction(
          Effect.gen(function* () {
            yield* insert(outer)
            yield* transaction(insert(inner))

            return yield* new Boom()
          }),
        ),
      )

      assert.ok(Exit.isFailure(exit))
      assert.equal(yield* committed(outer), false)
      // Had the inner call committed on its own, its row would survive.
      assert.equal(yield* committed(inner), false)
    }),
  ))

void test("interruption waits for the body's finalizers and the rollback", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database
      const id = createId("prn")
      const inserted = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          transaction(
            insert(id).pipe(
              Effect.andThen(Deferred.succeed(inserted, undefined)),
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.await(gate)),
            ),
          ),
        )

        yield* Deferred.await(inserted)
        yield* Effect.forkChild(Fiber.interrupt(fiber).pipe(Effect.andThen(Deferred.succeed(interrupted, undefined))))
        yield* Effect.sleep("200 millis")

        // The body's finalizer is still blocked, so interruption can't be done.
        assert.equal(yield* Deferred.isDone(interrupted), false)

        yield* Deferred.succeed(gate, undefined)
        yield* Deferred.await(interrupted)

        // Interruption has returned, so the rollback has released the row: an
        // insert that refuses to wait for a lock gets the same key.
        yield* transaction(
          Effect.andThen(
            database.use((db) => db.execute(sql`set local lock_timeout = '1ms'`)),
            insert(id),
          ),
        )
      }).pipe(
        // Never leave the body blocked if an assertion fails.
        Effect.ensuring(Deferred.succeed(gate, undefined)),
      )
    }),
  ))

