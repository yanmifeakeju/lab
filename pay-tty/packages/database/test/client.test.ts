import assert from "node:assert/strict"
import { after, test } from "node:test"

import { sql } from "drizzle-orm"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, type Redacted, Schema } from "effect"

import { connect, type Interface } from "../src/client.ts"
import { Testing } from "../src/testing.ts"

// The transaction wrapper against a one-table schema of its own.

class Database extends Context.Service<Database, Interface>()("Database") {}

const schema: Testing.Schema<Database> = {
  prefix: "pay_tty_t_database_",
  migrations: { migrationsFolder: new URL("./migrations", import.meta.url).pathname },
  seed: "",
  layer: (url: Redacted.Redacted) => Layer.effect(Database)(connect(url)),
}

const db = await Testing.withDatabase(schema)

const runtime = ManagedRuntime.make(db.layer)

// Close the pool, then drop, even if closing fails.
after(() => runtime.dispose().finally(() => db.drop()))

class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}

// Unique within this file's database.
let ids = 0

const newId = () => `row_${(ids += 1)}`

const insert = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((client) => client.execute(sql`insert into rows (id) values (${id})`))
  })

// Queries the pool outside any open transaction so only committed rows are visible.
const committed = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    const result = yield* database.use((client) => client.execute(sql`select 1 from rows where id = ${id}`))

    return result.rows.length === 1
  })

const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = yield* Database

    return yield* database.transaction(effect)
  })

void test("commits the transaction's writes when it succeeds", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const first = newId()
      const second = newId()

      yield* transaction(Effect.andThen(insert(first), insert(second)))

      assert.equal(yield* committed(first), true)
      assert.equal(yield* committed(second), true)
    }),
  ))

void test("rolls back and surfaces a typed failure unchanged", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const id = newId()

      const exit = yield* Effect.exit(transaction(Effect.andThen(insert(id), Effect.fail(new Boom()))))

      assert.ok(Exit.isFailure(exit) && Cause.hasFails(exit.cause))
      assert.equal(yield* committed(id), false)
    }),
  ))

void test("rolls back on a defect", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const id = newId()

      const exit = yield* Effect.exit(transaction(Effect.andThen(insert(id), Effect.die("defect"))))

      assert.ok(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
      assert.equal(yield* committed(id), false)
    }),
  ))

void test("rolls back when interrupted", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const id = newId()
      const inserted = yield* Deferred.make<void>()

      const fiber = yield* Effect.forkChild(
        transaction(insert(id).pipe(Effect.andThen(Deferred.succeed(inserted, undefined)), Effect.andThen(Effect.never))),
      )

      yield* Deferred.await(inserted)
      yield* Fiber.interrupt(fiber)

      // Succeeds only if the interrupted transaction rolled back and released its primary-key lock.
      yield* insert(id)
    }),
  ))

void test("a nested transaction joins the outer one", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const outer = newId()
      const inner = newId()

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
      assert.equal(yield* committed(inner), false)
    }),
  ))

void test("interruption waits for the body's finalizers and the rollback", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database
      const id = newId()
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

        // Interruption waits while the body's finalizer is blocked on `gate`.
        assert.equal(yield* Deferred.isDone(interrupted), false)

        yield* Deferred.succeed(gate, undefined)
        yield* Deferred.await(interrupted)

        // Once interruption completes, the rollback has finished and the row lock is released.
        yield* transaction(
          Effect.andThen(
            database.use((client) => client.execute(sql`set local lock_timeout = '1ms'`)),
            insert(id),
          ),
        )
      }).pipe(
        Effect.ensuring(Deferred.succeed(gate, undefined)),
      )
    }),
  ))

void test("a pool on another database never joins this pool's transaction, nor this one its", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const other = yield* Effect.promise(() => Testing.withDatabase(schema))

      const nameOn = (database: Interface) =>
        Effect.map(database.use((client) => client.execute<{ name: string }>(sql`select current_database() as name`)), (result) => result.rows[0]?.name)

      yield* Effect.gen(function* () {
        const ours = yield* Database
        // Built as the first was, from the same layer.
        const theirs = Context.get(yield* Layer.build(other.layer), Database)
        const names = [yield* nameOn(ours), yield* nameOn(theirs)]

        assert.notEqual(names[0], names[1])
        assert.deepEqual(yield* ours.transaction(Effect.all([nameOn(ours), nameOn(theirs)])), names)
        assert.deepEqual(yield* theirs.transaction(Effect.all([nameOn(ours), nameOn(theirs)])), names)
      }).pipe(Effect.scoped, Effect.ensuring(Effect.promise(() => other.drop())))
    }),
  ))
