import { Console, Effect, Match } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { ledgerClient } from "./ledger-client.ts";

const program = Effect.gen(function* () {
  const client = yield* ledgerClient;
  const health = yield* client.getHealth(undefined);
  yield* Console.log(health);

  // const result = yield* client.getAccount(reference, {
  //   config: { includeResponse: true },
  // }).pipe(
  //   Effect.match({
  //     onFailure: (error) => ({
  //       ok: false as const,
  //       error,
  //     }),
  //     onSuccess: ([account, response]) => ({
  //       ok: true as const,
  //       account,
  //       response,
  //     }),
  //   }),
  // )

  // if (result.ok) {
  //   yield* Console.log(result.account)
  // } else {
  //   yield* Console.error(result.error)
  // }

  const result = yield* client.createPayableAccount({
    payload: { external_id: "tester", ledger: "ngn_usd", name: "oluwayanmife" },
  }).pipe(Effect.match({
    onFailure: (error) => Match.value(error).pipe(
      Match.tags({
        HttpClientError: (error) => ({
          _tag: "HttpClientFailure" as const,
          error,
        }),
        SchemaError: (error) => ({
          _tag: "SchemaFailure" as const,
          error,
        }),
      }),
      Match.orElse((response) => ({
        _tag: "ApiFailure" as const,
        response,
      })),
    ),
    onSuccess: (account) => ({ _tag: "Success" as const, account }),
  }));

  yield* Match.value(result).pipe(
    Match.tagsExhaustive({
      ApiFailure: ({ response }) => Console.error(response.error),
      HttpClientFailure: ({ error }) => Console.error(error),
      SchemaFailure: ({ error }) => Console.error(error),
      Success: ({ account }) => Console.log(account),
    }),
  );

  // yield* Console.log(createAccount);
});

void Effect.runPromise(
  program.pipe(Effect.provide(FetchHttpClient.layer)),
);
