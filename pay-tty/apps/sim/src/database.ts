import { Database as Pool } from "@pay-tty/database"
import { Context, Layer, type Redacted } from "effect"

/** The simulator's database. Plane and core never connect to it. */
export class SimDatabase extends Context.Service<SimDatabase, Pool.Interface>()("SimDatabase") {}

export const layer = Layer.effect(SimDatabase)(Pool.make("SIM_DATABASE_URL"))

/** The simulator's database at `url`, for tests that make their own. */
export const layerUrl = (url: Redacted.Redacted) => Layer.effect(SimDatabase)(Pool.connect(url))
