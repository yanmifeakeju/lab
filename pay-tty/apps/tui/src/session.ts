import {
  type AuthorizedClient,
  type BusinessBalanceEncoded,
  type BusinessInfoEncoded,
  CreatePaymentLinkRequestEncoded,
  type PaymentsListPaymentsParams,
} from "@pay-tty/plane-client";
import {
  Clock,
  Data,
  Effect,
  Encoding,
  FiberSet,
  Match,
  Predicate,
  Ref,
  Result,
  Schema,
  SubscriptionRef,
} from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { type Form, type Link, type Overview, type Request, type Summary, toRequest } from "./payment-link.ts";
import type { Detail, Filter, Page, State as PaymentState } from "./payments.ts";
import { Plane } from "./plane.ts";

export type Business = BusinessInfoEncoded;

// The home screen's balance, loaded beside the screen rather than as an
// Operation: a slow ledger must hold up nothing. `request` names the fetch
// that wrote it, so an answer meant for an earlier one is dropped.
export type Balance = Data.TaggedEnum<{
  Loading: { readonly request: number };
  Loaded: { readonly request: number; readonly figures: BusinessBalanceEncoded };
  Unavailable: { readonly request: number };
}>;

export const Balance = Data.taggedEnum<Balance>();

export interface Home {
  readonly business: Business;
  /** Null while the business has no open account, so no balance. */
  readonly balance: Balance | null;
}

export type PaymentOrigin =
  | ({ readonly _tag: "HasBusiness" } & Home)
  | { readonly _tag: "LinkDetail"; readonly business: Business; readonly overview: Overview; readonly link: Summary };

export interface PaymentsView {
  readonly business: Business;
  readonly origin: PaymentOrigin;
  readonly filter: Filter;
  readonly page: Page;
}

// What the screen behind any popup shows. Unknown until /me answers: a failed
// load is never taken to mean there is no business.
export type View = Data.TaggedEnum<{
  Unknown: {};
  NoBusiness: {};
  HasBusiness: Home;
  /** The business's payments, optionally filtered to one link. */
  Payments: PaymentsView;
  /** A payment from the loaded list with its timeline; the list is kept for Back. */
  PaymentDetail: { readonly list: PaymentsView; readonly detail: Detail };
  /** The business's payment links, for one whose account is open. */
  Links: { readonly business: Business; readonly overview: Overview };
  /** One link of the list, as the list loaded it. */
  LinkDetail: {
    readonly business: Business;
    readonly overview: Overview;
    readonly link: Summary;
  };
  // The list stays with the form and its result, to show until it reloads.
  CreatingLink: { readonly business: Business; readonly overview: Overview };
  LinkCreated: {
    readonly business: Business;
    readonly overview: Overview;
    readonly link: Link;
  };
}>;

export const View = Data.taggedEnum<View>();

// A request the user started, kept with what was submitted so Retry repeats
// exactly that.
export type Operation = Data.TaggedEnum<{
  Load: {};
  CreateBusiness: { readonly name: string };
  OpenAccount: {};
  ListLinks: { readonly business: Business };
  ListPayments: {
    readonly business: Business;
    readonly origin: PaymentOrigin;
    readonly filter: Filter;
    readonly before: string | null;
    readonly previous: Page | null;
  };
  OpenPayment: { readonly list: PaymentsView; readonly id: string };
  // The key goes with the request, so Retry can't create a second link.
  CreatePaymentLink: {
    readonly business: Business;
    readonly overview: Overview;
    readonly request: Request;
    readonly key: string;
  };
}>;

export const Operation = Data.taggedEnum<Operation>();

export interface Popup<Retry = Operation> {
  readonly message: string;
  /** Repeated by Retry; null when repeating it can't help. */
  readonly retry: Retry | null;
  /**
   * What Close does: "refresh" reloads /me and shows what it returns. Null on a
   * failed load, where Close would only load again, so Retry is the one action.
   * "back" leaves an unavailable link filter and returns to the link list.
   */
  readonly close: "dismiss" | "refresh" | "back" | null;
}

// What one SSH connection shows. Only one request is ever in flight, marked by
// `pending`, so a late answer can't overwrite a newer screen.
export interface State {
  readonly view: View;
  readonly pending: boolean;
  readonly popup: Popup | null;
}

// Plane's declared errors arrive as their decoded bodies; anything else, a 500
// included, as a transport or decoding failure.
interface ApiError {
  readonly message: string;
  readonly error: { readonly code: string };
}

type Failure = ApiError | HttpClientError.HttpClientError | Schema.SchemaError;

const codeOf = (failure: Failure) =>
  HttpClientError.isHttpClientError(failure) || Schema.isSchemaError(failure)
    ? undefined
    : failure.error.code;

// Renewed this long before it expires, so a request never carries a token
// that lapses on the way.
const renewMargin = 60_000;

export interface Interface {
  readonly state: SubscriptionRef.SubscriptionRef<State>;
  /** Loads the caller and their business, once the connection opens. */
  readonly load: Effect.Effect<void>;
  /** Ignored unless the form is showing and idle. */
  readonly createBusiness: (name: string) => Effect.Effect<void>;
  /** Ignored unless a created business is showing and idle. */
  readonly openAccount: Effect.Effect<void>;
  /** Fetches the balance again; ignored unless home shows one that isn't loading. */
  readonly refreshBalance: Effect.Effect<void>;
  /** Loads payments; ignored unless an active business is showing and idle. */
  readonly managePayments: Effect.Effect<void>;
  /** Loads one link's payments; ignored unless that link is showing and idle. */
  readonly linkPayments: (linkId: string) => Effect.Effect<void>;
  /** Reloads the first page; ignored unless payments are showing and idle. */
  readonly refreshPayments: Effect.Effect<void>;
  /** Changes the state and resets paging; ignored unless payments are showing and idle. */
  readonly filterPayments: (state: PaymentState | null) => Effect.Effect<void>;
  /** Appends the next page; ignored unless payments are showing, idle and have more. */
  readonly morePayments: Effect.Effect<void>;
  /** Loads a listed payment's detail; ignored unless payments are showing and idle. */
  readonly openPayment: (id: string) => Effect.Effect<void>;
  /** Loads the links; ignored unless an active business is showing and idle. */
  readonly manageLinks: Effect.Effect<void>;
  /** Loads the links again; ignored unless they are showing and idle. */
  readonly refreshLinks: Effect.Effect<void>;
  /** Shows one listed link; ignored unless the list is showing and idle. */
  readonly openLink: (id: string) => Effect.Effect<void>;
  /** Shows the link form; ignored unless the links are showing and idle. */
  readonly startPaymentLink: Effect.Effect<void>;
  /** Ignored unless the form is showing and idle. */
  readonly createPaymentLink: (form: Form) => Effect.Effect<void>;
  /**
   * One screen back, when idle: from a link to the list, from the list to the
   * business, and from the form or a created link to the list, reloaded.
   */
  readonly back: Effect.Effect<void>;
  /** Repeats the failed operation; ignored unless the popup offers it. */
  readonly retry: Effect.Effect<void>;
  /** Ignored unless the popup offers it. */
  readonly close: Effect.Effect<void>;
}

// Plane's declared refusals won't change by repeating the request. Anything
// else, a 500 or a dropped connection included, arrives undecoded and might.
const popupFor = (operation: Operation, failure: Failure): Popup => {
  const code = codeOf(failure);

  return Operation.$match(operation, {
    Load: () => ({
      message: "Couldn't load your account.",
      retry: operation,
      close: null,
    }),
    CreateBusiness: () =>
      Match.value(code).pipe(
        Match.when("validation_error", () => ({
          message: "Enter a business name of at most 255 characters.",
          retry: null,
          close: "dismiss" as const,
        })),
        Match.when("conflict", () => ({
          message: "This key already has a business.",
          retry: null,
          close: "refresh" as const,
        })),
        Match.when("country_unavailable", () => ({
          message: "Businesses can't be created in this country yet.",
          retry: null,
          close: "refresh" as const,
        })),
        Match.orElse(() => ({
          message: "Couldn't create the business.",
          retry: operation,
          close: "refresh" as const,
        })),
      ),
    OpenAccount: () =>
      Match.value(code).pipe(
        Match.when("business_required", () => ({
          message: "Create a business first.",
          retry: null,
          close: "refresh" as const,
        })),
        Match.when(
          (value) => value === "conflict" || value === "ledger_rejected",
          () => ({
            message:
              "The ledger couldn't open an account for this business. Contact support.",
            retry: null,
            close: "refresh" as const,
          }),
        ),
        Match.orElse(() => ({
          message: "Couldn't open the account.",
          retry: operation,
          close: "refresh" as const,
        })),
      ),
    ListPayments: (): Popup => Match.value(code).pipe(
      Match.when("not_found", () => ({
        message: "This payment link is no longer available.", retry: null, close: "back" as const,
      })),
      Match.when("business_required", () => ({
        message: "Create a business first.", retry: null, close: "refresh" as const,
      })),
      Match.orElse(() => ({
        message: "Couldn't load your payments.", retry: operation, close: "dismiss" as const,
      })),
    ),
    OpenPayment: (): Popup => Match.value(code).pipe(
      Match.when("not_found", () => ({
        message: "This payment is no longer available.", retry: null, close: "dismiss" as const,
      })),
      Match.when("business_required", () => ({
        message: "Create a business first.", retry: null, close: "refresh" as const,
      })),
      Match.orElse(() => ({
        message: "Couldn't load the payment.", retry: operation, close: "dismiss" as const,
      })),
    ),
    ListLinks: () =>
      Match.value(code).pipe(
        Match.when("business_required", () => ({
          message: "Create a business first.",
          retry: null,
          close: "refresh" as const,
        })),
        Match.orElse(() => ({
          message: "Couldn't load your payment links.",
          retry: operation,
          close: "dismiss" as const,
        })),
      ),
    // Close keeps the form as typed. Submitting it unchanged reuses the key,
    // so a link whose answer was lost comes back instead of a second one.
    CreatePaymentLink: () =>
      Match.value(code).pipe(
        Match.when("validation_error", () => ({
          message: "Plane refused the link's details. Check them and try again.",
          retry: null,
          close: "dismiss" as const,
        })),
        Match.when("conflict", () => ({
          message:
            "That request was already used for a different link, so no link was created. Submit again to create one.",
          retry: null,
          close: "dismiss" as const,
        })),
        Match.when("business_required", () => ({
          message: "Create a business first.",
          retry: null,
          close: "refresh" as const,
        })),
        // Close reloads the business, which shows its account opening.
        Match.when("business_inactive", () => ({
          message: "Your account isn't open yet, so no link was created.",
          retry: null,
          close: "refresh" as const,
        })),
        Match.orElse(() => ({
          message: "Couldn't create the payment link.",
          retry: operation,
          close: "dismiss" as const,
        })),
      ),
  });
};

// Refusals that settle the submission: nothing was created under its key.
const settles = (failure: Failure) => {
  const code = codeOf(failure);

  return code === "validation_error" || code === "conflict" || code === "business_required" ||
    code === "business_inactive";
};

const sameRequest = Schema.toEquivalence(CreatePaymentLinkRequestEncoded);

const idempotencyKey = Effect.sync(() =>
  Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))
);

interface Submission {
  readonly businessId: string;
  readonly request: Request;
  readonly key: string;
}

/**
 * One connection's session, for the key that authenticated it. Nothing is
 * shared between connections, so each makes its own.
 */
export const make = Effect.fnUntraced(function* (fingerprint: string) {
  const plane = yield* Plane.Service;

  const state = yield* SubscriptionRef.make<State>({
    view: View.Unknown(),
    pending: false,
    popup: null,
  });

  const token = yield* Ref.make<
    { readonly value: string; readonly expiresAt: number } | undefined
  >(undefined);

  // Balance fetches run here, apart from the operation that showed home, so
  // they end with the connection and nothing waits on them.
  const balances = yield* FiberSet.make();

  const requests = yield* Ref.make(0);

  const nextRequest = Ref.updateAndGet(requests, (count) => count + 1);

  // The last link submission whose outcome is unknown, kept for this
  // connection only.
  const unresolved = yield* Ref.make<Submission | undefined>(undefined);

  // The SSH key already proved who this is; plane trades it for a token.
  const exchange = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const session = yield* plane.createSession({
      payload: { issuer: "ssh", sub: fingerprint },
    });

    yield* Ref.set(token, {
      value: session.access_token,
      expiresAt: now + session.expires_in * 1000,
    });

    return session.access_token;
  });

  const currentToken = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const held = yield* Ref.get(token);

    return held !== undefined && held.expiresAt - now > renewMargin
      ? held.value
      : yield* exchange;
  });

  // A 401 means plane stopped accepting the token, say after a key rotation:
  // exchange once more and retry, and give up if that is refused too.
  const authorized = <A, E extends Failure>(
    call: (client: AuthorizedClient) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const first = yield* Effect.result(
        Effect.flatMap(currentToken, (value) => call(plane.authorized(value))),
      );

      if (Result.isSuccess(first)) {
        return first.success;
      }

      if (codeOf(first.failure) !== "unauthorized") {
        return yield* Effect.fail(first.failure);
      }

      return yield* Effect.flatMap(exchange, (value) =>
        call(plane.authorized(value)));
    });

  const succeed = (view: View) =>
    SubscriptionRef.set(state, { view, pending: false, popup: null });

  // Home for the business; its balance loads under `request` once shown.
  const home = (business: Business, request: number) =>
    View.HasBusiness({
      business,
      balance: business.status === "active" && business.ledger !== null ? Balance.Loading({ request }) : null,
    });

  // The answer lands only if home still waits on this very request.
  const fetchBalance = (business: Business, request: number) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(authorized((client) => client.getBalance(undefined)));

      if (Result.isFailure(outcome)) {
        yield* Effect.logWarning("balance failed", outcome.failure);
      }

      yield* SubscriptionRef.update(state, (current) =>
        View.$is("HasBusiness")(current.view) &&
        current.view.business.id === business.id &&
        current.view.balance !== null &&
        Balance.$is("Loading")(current.view.balance) &&
        current.view.balance.request === request
          ? {
              ...current,
              view: View.HasBusiness({
                business: current.view.business,
                balance: Result.isSuccess(outcome)
                  ? Balance.Loaded({ request, figures: outcome.success })
                  : Balance.Unavailable({ request }),
              }),
            }
          : current);
    });

  // Starts the fetch if what's showing is home, loading under `request`.
  const startBalance = (request: number) =>
    Effect.gen(function* () {
      const { view } = yield* SubscriptionRef.get(state);

      if (
        View.$is("HasBusiness")(view) &&
        view.balance !== null &&
        Balance.$is("Loading")(view.balance) &&
        view.balance.request === request
      ) {
        yield* FiberSet.run(balances, fetchBalance(view.business, request));
      }
    });

  // Runs an operation already marked pending. Its failure keeps the screen
  // behind as it was, except a failed load, which leaves the business unknown.
  const perform = (operation: Operation): Effect.Effect<void> =>
    Effect.gen(function* () {
      const request = yield* nextRequest;

      const outcome = yield* Effect.result(
        Operation.$match(operation, {
          Load: () =>
            Effect.map(
              authorized((client) => client.me(undefined)),
              ({ business }) =>
                business === null
                  ? View.NoBusiness()
                  : home(business, request),
            ),
          // Nigeria is the only country with a ledger; see TASK-004.
          CreateBusiness: ({ name }) =>
            Effect.map(
              authorized((client) =>
                client.createBusiness({ payload: { name, country_code: "NG" } })
              ),
              (business) => home(business, request),
            ),
          // The business stays created whatever failed, so repeating this is safe.
          OpenAccount: () =>
            Effect.map(
              authorized((client) =>
                client.createAccount(undefined)
              ),
              (opened) => home(opened, request),
            ),
          ListPayments: ({ business, origin, filter, before, previous }) =>
            Effect.map(
              authorized((client) => {
                const params: PaymentsListPaymentsParams = {
                  ...(filter.linkId === null ? undefined : { link_id: filter.linkId }),
                  ...(filter.state === null ? undefined : { state: filter.state }),
                  ...(before === null ? undefined : { before }),
                };

                return client.listPayments({ params });
              }),
              (page) =>
                View.Payments({
                  business,
                  origin,
                  filter,
                  page: previous === null
                    ? page
                    : { ...page, payments: [...previous.payments, ...page.payments] },
                }),
            ),
          OpenPayment: ({ list, id }) =>
            Effect.map(
              authorized((client) => client.getPayment(id)),
              (detail) => View.PaymentDetail({ list, detail }),
            ),
          ListLinks: ({ business }) =>
            Effect.map(
              authorized((client) => client.listPaymentLinks(undefined)),
              (overview) => View.Links({ business, overview }),
            ),
          CreatePaymentLink: ({ business, overview, request, key }) =>
            Effect.map(
              authorized((client) =>
                client.createPaymentLink({
                  params: { "idempotency-key": key },
                  payload: request,
                })
              ),
              (link) => View.LinkCreated({ business, overview, link }),
            ),
        }),
      );

      if (Operation.$is("CreatePaymentLink")(operation) && (Result.isSuccess(outcome) || settles(outcome.failure))) {
        yield* Ref.set(unresolved, undefined);
      }

      if (Result.isSuccess(outcome)) {
        yield* succeed(outcome.success);

        return yield* startBalance(request);
      }

      yield* Effect.logWarning(`${operation._tag} failed`, outcome.failure);

      const popup = popupFor(operation, outcome.failure);

      yield* SubscriptionRef.update(state, (current) => ({
        view: Operation.$is("Load")(operation) ? View.Unknown() : current.view,
        pending: false,
        popup,
      }));
    });

  // Marks the operation pending if `allowed` passes and nothing is in flight.
  const begin = (
    allowed: (current: State) => boolean,
    next: (current: State) => State,
  ) =>
    SubscriptionRef.modify(
      state,
      (current) =>
        allowed(current) && !current.pending
          ? ([true, next(current)] as const)
          : ([false, current] as const),
    );

  const reload = { view: View.Unknown(), pending: true, popup: null };

  const load = Effect.gen(function* () {
    if (yield* begin(() => true, () => reload)) {
      yield* perform(Operation.Load());
    }
  });

  const createBusiness = Effect.fnUntraced(function* (input: string) {
    const name = input.trim();

    const showing = (current: State) =>
      View.$is("NoBusiness")(current.view) && current.popup === null;

    if (name === "") {
      return yield* begin(showing, (current) => ({
        ...current,
        popup: {
          message: "Enter a business name.",
          retry: null,
          close: "dismiss",
        },
      }));
    }

    if (yield* begin(showing, (current) => ({ ...current, pending: true }))) {
      yield* perform(Operation.CreateBusiness({ name }));
    }
  });

  const openAccount = Effect.gen(function* () {
    const showing = (current: State) =>
      View.$is("HasBusiness")(current.view) &&
      current.view.business.status === "created" &&
      current.popup === null;

    if (yield* begin(showing, (current) => ({ ...current, pending: true }))) {
      yield* perform(Operation.OpenAccount());
    }
  });

  // Never pending: home stays usable while the ledger answers.
  const refreshBalance = Effect.gen(function* () {
    const request = yield* nextRequest;

    yield* SubscriptionRef.update(state, (current) =>
      View.$is("HasBusiness")(current.view) &&
      current.view.balance !== null &&
      !Balance.$is("Loading")(current.view.balance) &&
      current.popup === null
        ? { ...current, view: home(current.view.business, request) }
        : current);

    yield* startBalance(request);
  });

  const manageLinks = Effect.gen(function* () {
    const business = yield* SubscriptionRef.modify(
      state,
      (current) =>
        View.$is("HasBusiness")(current.view) &&
        current.view.business.ledger !== null &&
        current.popup === null &&
        !current.pending
          ? ([current.view.business, { ...current, pending: true }] as const)
          : ([undefined, current] as const),
    );

    if (business !== undefined) {
      yield* perform(Operation.ListLinks({ business }));
    }
  });

  const requestPayments = (
    choose: (view: View) => Omit<Extract<Operation, { readonly _tag: "ListPayments" }>, "_tag"> | undefined,
  ) =>
    Effect.gen(function* () {
      const operation = yield* SubscriptionRef.modify(state, (current) => {
        const request = current.pending || current.popup !== null ? undefined : choose(current.view);

        return request === undefined
          ? ([undefined, current] as const)
          : ([Operation.ListPayments(request), { ...current, pending: true }] as const);
      });

      if (operation !== undefined) {
        yield* perform(operation);
      }
    });

  const managePayments = requestPayments((view) =>
    View.$is("HasBusiness")(view) && view.business.ledger !== null
      ? {
          business: view.business,
          origin: view,
          filter: { linkId: null, state: null },
          before: null,
          previous: null,
        }
      : undefined,
  );

  const linkPayments = (linkId: string) =>
    requestPayments((view) =>
      View.$is("LinkDetail")(view) && view.link.id === linkId
        ? {
            business: view.business,
            origin: view,
            filter: { linkId, state: null },
            before: null,
            previous: null,
          }
        : undefined,
    );

  const refreshPayments = requestPayments((view) =>
    View.$is("Payments")(view)
      ? { ...view, before: null, previous: null }
      : undefined,
  );

  const filterPayments = (state: PaymentState | null) =>
    requestPayments((view) =>
      View.$is("Payments")(view)
        ? { ...view, filter: { ...view.filter, state }, before: null, previous: null }
        : undefined,
    );

  const morePayments = requestPayments((view) =>
    View.$is("Payments")(view) && view.page.next !== null
      ? { ...view, before: view.page.next, previous: view.page }
      : undefined,
  );

  const openPayment = (id: string) =>
    Effect.gen(function* () {
      const list = yield* SubscriptionRef.modify(state, (current) =>
        View.$is("Payments")(current.view) &&
        current.popup === null &&
        !current.pending &&
        current.view.page.payments.some((payment) => payment.id === id)
          ? ([current.view, { ...current, pending: true }] as const)
          : ([undefined, current] as const),
      );

      if (list !== undefined) {
        yield* perform(Operation.OpenPayment({ list, id }));
      }
    });

  const refreshLinks = Effect.gen(function* () {
    const business = yield* SubscriptionRef.modify(
      state,
      (current) =>
        View.$is("Links")(current.view) && current.popup === null && !current.pending
          ? ([current.view.business, { ...current, pending: true }] as const)
          : ([undefined, current] as const),
    );

    if (business !== undefined) {
      yield* perform(Operation.ListLinks({ business }));
    }
  });

  const linkOverview = (view: View) => {
    if (View.$is("Links")(view)) {
      return view;
    }

    if (View.$is("PaymentDetail")(view) && Predicate.isTagged(view.list.origin, "LinkDetail")) {
      return view.list.origin;
    }

    return undefined;
  };

  const openLink = (id: string) =>
    Effect.asVoid(
      begin(
        (current) =>
          current.popup === null &&
          linkOverview(current.view)?.overview.links.some((link) => link.id === id) === true,
        (current) => {
          const shown = linkOverview(current.view);
          const link = shown?.overview.links.find((listed) => listed.id === id);

          return shown === undefined || link === undefined
            ? current
            : { ...current, view: View.LinkDetail({ business: shown.business, overview: shown.overview, link }) };
        },
      ),
    );

  const startPaymentLink = Effect.asVoid(
    begin(
      (current) =>
        View.$is("Links")(current.view) &&
        current.view.business.ledger !== null &&
        current.popup === null,
      (current) =>
        View.$is("Links")(current.view)
          ? { ...current, view: View.CreatingLink(current.view) }
          : current,
    ),
  );

  const createPaymentLink = Effect.fnUntraced(function* (form: Form) {
    const showing = (current: State) =>
      View.$is("CreatingLink")(current.view) && current.popup === null;

    const shown = yield* SubscriptionRef.get(state).pipe(
      Effect.map((current) =>
        View.$is("CreatingLink")(current.view) ? current.view : undefined
      ),
    );

    const ledger = shown?.business.ledger;

    if (shown === undefined || ledger == null) {
      return;
    }

    const { business, overview } = shown;

    const request = toRequest(form, ledger.scale, ledger.currency);

    if (Result.isFailure(request)) {
      return yield* begin(showing, (current) => ({
        ...current,
        popup: { message: request.failure, retry: null, close: "dismiss" },
      }));
    }

    if (!(yield* begin(showing, (current) => ({ ...current, pending: true })))) {
      return;
    }

    const fresh = yield* idempotencyKey;

    const key = yield* Ref.modify(unresolved, (held) =>
      held !== undefined && held.businessId === business.id && sameRequest(held.request, request.success)
        ? ([held.key, held] as const)
        : ([fresh, { businessId: business.id, request: request.success, key: fresh }] as const));

    yield* perform(Operation.CreatePaymentLink({ business, overview, request: request.success, key }));
  });

  // Leaving the form or a created link shows the list as it was while it
  // reloads, so a new link joins it.
  const back = Effect.gen(function* () {
    const request = yield* nextRequest;

    const reload = yield* SubscriptionRef.modify(state, (current): readonly [Business | undefined, State] => {
      if (current.popup !== null || current.pending) {
        return [undefined, current];
      }

      const stay = [undefined, current] as const;

      const reloading = ({ business, overview }: { readonly business: Business; readonly overview: Overview }) =>
        [business, { ...current, view: View.Links({ business, overview }), pending: true }] as const;

      return View.$match(current.view, {
        Payments: ({ origin }) =>
          [undefined, { ...current, view: Predicate.isTagged(origin, "HasBusiness") ? home(origin.business, request) : origin }] as const,
        PaymentDetail: ({ list }) => [undefined, { ...current, view: View.Payments(list) }] as const,
        Unknown: () => stay,
        NoBusiness: () => stay,
        HasBusiness: () => stay,
        Links: ({ business }) => [undefined, { ...current, view: home(business, request) }] as const,
        LinkDetail: ({ business, overview }) =>
          [undefined, { ...current, view: View.Links({ business, overview }) }] as const,
        CreatingLink: reloading,
        LinkCreated: reloading,
      });
    });

    if (reload !== undefined) {
      return yield* perform(Operation.ListLinks({ business: reload }));
    }

    yield* startBalance(request);
  });

  // The popup stays up while the retry runs; its answer replaces or clears it.
  const retry = Effect.gen(function* () {
    const operation = yield* SubscriptionRef.modify(
      state,
      (current) =>
        current.popup?.retry != null && !current.pending
          ? ([current.popup.retry, { ...current, pending: true }] as const)
          : ([undefined, current] as const),
    );

    if (operation !== undefined) {
      yield* perform(operation);
    }
  });

  // A refresh never repeats the failed request. It also recovers one that
  // succeeded after its answer was lost, or a business made from another terminal.
  const close = Effect.gen(function* () {
    const request = yield* nextRequest;

    const refresh = yield* SubscriptionRef.modify(state, (current) => {
      if (current.popup?.close == null || current.pending) {
        return [false, current] as const;
      }

      if (current.popup.close === "back") {
        const origin = View.$is("Payments")(current.view) ? current.view.origin : current.view;

        const view = Predicate.isTagged(origin, "LinkDetail")
          ? View.Links({ business: origin.business, overview: origin.overview })
          : Predicate.isTagged(origin, "HasBusiness") ? home(origin.business, request) : origin;

        return [false, { ...current, view, popup: null }] as const;
      }

      return current.popup.close === "refresh"
        ? ([true, reload] as const)
        : ([false, { ...current, popup: null }] as const);
    });

    if (refresh) {
      return yield* perform(Operation.Load());
    }

    yield* startBalance(request);
  });

  return {
    state,
    load,
    createBusiness,
    openAccount,
    refreshBalance,
    managePayments,
    linkPayments,
    refreshPayments,
    filterPayments,
    morePayments,
    openPayment,
    manageLinks,
    refreshLinks,
    openLink,
    startPaymentLink,
    createPaymentLink,
    back,
    retry,
    close,
  } satisfies Interface;
});

export * as Session from "./session.ts";
