import { Effect } from "effect"

export const greeting = (name: string): Effect.Effect<string> =>
  Effect.succeed(`Hello from ${name}!`)
