import { Database as Pool } from "@pay-tty/database"
import { Context, Layer, type Redacted } from "effect"

export type Executor = Pool.Executor

export type Interface = Pool.Interface

/** Plane's database. */
export class Database extends Context.Service<Database, Interface>()("Database") {}

export const layer = Layer.effect(Database)(Pool.make("DATABASE_URL"))

/** Plane's database at `url`, for tests that make their own. */
export const layerUrl = (url: Redacted.Redacted) => Layer.effect(Database)(Pool.connect(url))
