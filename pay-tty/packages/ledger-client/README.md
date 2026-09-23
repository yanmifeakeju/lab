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

Declared API errors fail with the decoded server response body directly. For
example, a rejected account request can be handled without reaching through a
generated error wrapper:

```ts
const result = yield* client.createPayableAccount({
  payload: {
    ledger: "ngn_ng",
    external_id: "merchant_123",
    name: "Acme Ltd",
  },
}).pipe(
  Effect.match({
    onFailure: (error) => ({ ok: false as const, error }),
    onSuccess: (account) => ({ ok: true as const, account }),
  }),
)
```

Transport failures and invalid server responses remain typed client or schema
errors because they do not contain a valid API response body. The
`includeResponse` operation option only adds the raw HTTP response to successful
results; it does not change failure handling.

`src/generated.ts` is generated code. Do not edit it directly. Regenerate and
verify it from the repository root:

```sh
pnpm generate:client
pnpm generate:client:check
```
