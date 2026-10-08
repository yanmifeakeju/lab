// Prints plane's OpenAPI document, the contract @pay-tty/plane-client is
// generated from.
import * as OpenApi from "effect/unstable/httpapi/OpenApi"

import { api } from "../src/api/routes/index.ts"

process.stdout.write(`${JSON.stringify(OpenApi.fromApi(api), null, 2)}\n`)
