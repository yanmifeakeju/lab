# @pay-tty/ledger-client

Effect-native client generated from the repository's `openapi.yaml` contract.

Import application-facing APIs from the package root:

```ts
import { createClient } from "@pay-tty/ledger-client"
```

Provide an Effect HTTP client and the deployment-specific base URL at the
application edge:

```ts
import { Effect } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"

import { createClient } from "@pay-tty/ledger-client"

const health = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient
  const client = createClient(httpClient, {
    baseUrl: "http://localhost:8080",
  })

  return yield* client.getHealth(undefined)
}).pipe(Effect.provide(FetchHttpClient.layer))
```

Declared API errors fail with the decoded server response body directly. Keep
those failures in the Effect channel while composing requests, then handle the
whole client program once at the application boundary:

```ts
import { Console, Effect } from "effect"

import { catchClientErrors } from "@pay-tty/ledger-client"

const program = Effect.gen(function* () {
  const account = yield* client.createPayableAccount({
    payload: {
      ledger: "ngn_ng",
      external_id: "merchant_123",
      name: "Acme Ltd",
    },
  })

  return yield* client.getAccount(account.reference, undefined)
})

const main = catchClientErrors(program, {
  onApiError: (response) => Console.error(response.error),
  onConfigError: (error) => Console.error(error),
  onHttpClientError: (error) => Console.error(error),
  onSchemaError: (error) => Console.error(error),
})
```

Transport failures and invalid server responses remain typed client or schema
errors because they do not contain a valid API response body.
`catchClientErrors` distinguishes those failures from configuration errors and
decoded API responses. The `includeResponse` operation option only adds the raw
HTTP response to successful results; it does not change failure handling.

`src/generated.ts` is generated code. Do not edit it directly. Regenerate and
verify it from the repository root:

```sh
pnpm generate:client
pnpm generate:client:check
```
