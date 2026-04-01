import { createCommands } from "../index.ts";
import { z } from "zod";

const commands = createCommands<{ logger: Console }>();
commands.add("greet", {
  schema: z.object({ name: z.string() }),
  run: (data, ctx) => {
    ctx.logger.log(`Hello, ${data.name}!`);
    return { greeted: data.name };
  },
});

const runner = commands.init({ logger: console });
const result = await runner.execute("greet", { name: "world" });

console.log("Result:", result);
