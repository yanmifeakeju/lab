import {
  type AuthorizedClient,
  type BusinessBalanceEncoded,
  type BusinessInfoEncoded,
  CreatePaymentLinkRequestEncoded,
  type PaymentsListPaymentsParams,
  type PayoutSettingsRequestEncoded,
} from "@pay-tty/plane-client";
import {
  Clock,
  Data,
  Duration,
  Effect,
  Encoding,
  Fiber,
  FiberHandle,
  FiberSet,
  Match,
  Predicate,
  Ref,
  Result,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { type Form, type Link, type Overview, type Request, type Summary, toRequest } from "./payment-link.ts";
import type { Detail, Filter, Page, State as PaymentState } from "./payments.ts";
import {
  type Bank,
  type Form as PayoutForm,
  moving,
  type Page as PayoutPage,
  type Payout,
  type Settings as PayoutSettings,
  toAmount,
  toSettingsRequest,
} from "./payouts.ts";
import { Plane } from "./plane.ts";
import { defaultPeriod, type Period, type Statement } from "./statement.ts";

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

// Which row a page selects when it lands: the newest, or the oldest after
// paging to newer movements, so crossing a page boundary reads on.
export type Landing = "first" | "last";

export interface PayoutsView {
  readonly business: Business;
  readonly settings: PayoutSettings;
  readonly page: PayoutPage;
}

/** Where the payout settings form was opened from, which decides where Save and Back go. */
export type SettingsOrigin = Data.TaggedEnum<{
  /** Asked to change them from the payouts screen. */
  Payouts: { readonly list: PayoutsView };
  /** Payouts had no payout account to show; Back leaves payouts, and Save shows them. */
  Setup: {};
  /** Asked before a payment link, once per connection; Later goes on to the link. */
  NewLink: { readonly overview: Overview };
}>;

export const SettingsOrigin = Data.taggedEnum<SettingsOrigin>();

export interface StatementView {
  readonly business: Business;
  readonly period: Period;
  readonly page: Statement;
  readonly landing: Landing;
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
  /** A page of the business's ledger statement. */
  Statement: StatementView;
  /** The business's payment links, for one whose account is open. */
  Links: { readonly business: Business; readonly overview: Overview };
  /** The business's payouts under its payout settings; the views below keep the list for Back. */
  Payouts: PayoutsView;
  PayoutSettings: {
    readonly business: Business;
    readonly settings: PayoutSettings;
    readonly banks: ReadonlyArray<Bank>;
    readonly origin: SettingsOrigin;
  };
  RequestingPayout: { readonly list: PayoutsView };
  /** A created payout, as plane holds it: confirming pays exactly this. */
  ConfirmingPayout: { readonly list: PayoutsView; readonly payout: Payout };
  /** One payout, as last read. */
  PayoutDetail: { readonly list: PayoutsView; readonly payout: Payout };
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
  // Without a cursor, the settings and the newest page; with one, the next page under the settings shown.
  ListPayouts: {
    readonly business: Business;
    readonly before: string | null;
    readonly previous: PayoutsView | null;
    /** Opening payouts: with no payout account, show its form first. */
    readonly setup: boolean;
  };
  SavePayoutSettings: {
    readonly business: Business;
    readonly origin: SettingsOrigin;
    readonly change: PayoutSettingsRequestEncoded;
  };
  /** Loads the banks for the settings form. */
  EditPayoutSettings: { readonly list: PayoutsView };
  /** Checks for a payout account before the link form. */
  StartLink: { readonly business: Business; readonly overview: Overview };
  CreatePayout: { readonly list: PayoutsView; readonly amount: number };
  // Confirming is idempotent by the payout's ID, so Retry can't pay twice.
  ConfirmPayout: { readonly list: PayoutsView; readonly payout: Payout };
  OpenPayout: { readonly list: PayoutsView; readonly id: string };
  // A cursor carries its own period; without one, the period's newest page.
  ListStatement: {
    readonly business: Business;
    readonly period: Period;
    readonly cursor: string | null;
    readonly landing: Landing;
  };
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
   * "back" leaves an unavailable link filter and returns to the link list,
   * or leaves a confirmation that can't go on for the amount form.
   * "payouts" reloads the payout list and its settings.
   */
  readonly close: "dismiss" | "refresh" | "back" | "payouts" | null;
}

// What one SSH connection shows. Only one request is ever in flight, marked by
// `pending`, so a late answer can't overwrite a newer screen.
export interface State {
  readonly view: View;
  readonly pending: boolean;
  readonly popup: Popup | null;
  /** In a demo, the seconds a payment takes to settle, from /me; null otherwise. */
  readonly settlementDelay: number | null;
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

/** How often a payout's screen reads it again while plane is moving it, unless told otherwise. */
export const followEvery = Duration.seconds(2);

/** The longest a follow waits between reads, while nothing changes or plane can't be reached. */
export const followBackoff = Duration.seconds(30);

/**
 * How long a follow keeps reading a payout that doesn't change; `r` starts it
 * again. Plane checks a pending payout with its provider 2, 4, 9, 19 and 49
 * minutes after the send; this outlasts the first two, so nearly every
 * payout's settling shows, and stays under a merchant's SSH idle limit
 * (limits.ts), which would otherwise end the session of one watching without
 * typing. A payout still pending past the 4-minute check needs `r`.
 */
export const followQuiet = Duration.minutes(5);

export interface Options {
  readonly followEvery?: Duration.Duration;
  readonly followBackoff?: Duration.Duration;
  readonly followQuiet?: Duration.Duration;
}

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
  /** Loads the statement; ignored unless an active business is showing and idle. */
  readonly openStatement: Effect.Effect<void>;
  /** Loads another period's newest page; ignored unless the statement is showing and idle. */
  readonly statementPeriod: (period: Period) => Effect.Effect<void>;
  /** Loads the older or newer page; ignored unless the statement is showing, idle and has one. */
  readonly statementPage: (direction: "next" | "previous") => Effect.Effect<void>;
  /** Reloads the period from its newest page; ignored unless the statement is showing and idle. */
  readonly refreshStatement: Effect.Effect<void>;
  /** Loads the payout settings and payouts; ignored unless an active business is showing and idle. */
  readonly managePayouts: Effect.Effect<void>;
  /** Reloads them; ignored unless payouts are showing and idle. */
  readonly refreshPayouts: Effect.Effect<void>;
  /** Appends the next page; ignored unless payouts are showing, idle and have more. */
  readonly morePayouts: Effect.Effect<void>;
  /** Loads a listed payout, or reads the one showing again; ignored unless idle. */
  readonly openPayout: (id: string) => Effect.Effect<void>;
  /** Loads the banks and shows the settings form; ignored unless payouts are showing and idle. */
  readonly editPayoutSettings: Effect.Effect<void>;
  /** Ignored unless the settings form is showing and idle. */
  readonly savePayoutSettings: (form: PayoutForm) => Effect.Effect<void>;
  /** Shows the amount form; ignored unless manual payouts are showing and idle. */
  readonly startPayout: Effect.Effect<void>;
  /**
   * Creates a payout of the amount, for the confirmation to show; ignored
   * unless the amount form is showing and idle. Nothing moves until it is
   * confirmed; left unconfirmed, it expires.
   */
  readonly createPayout: (amount: string) => Effect.Effect<void>;
  /** Confirms the payout shown; ignored unless a confirmation is showing and idle. */
  readonly confirmPayout: Effect.Effect<void>;
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
// Why no payout screen can go on: no business, no open account, or a
// currency without payouts. None is helped by Retry.
const payoutBlocked = (code: string | undefined): Popup | undefined =>
  Match.value(code).pipe(
    Match.when("business_required", (): Popup => ({ message: "Create a business first.", retry: null, close: "refresh" })),
    Match.when("account_not_opened", (): Popup => ({ message: "Your account isn't open yet.", retry: null, close: "refresh" })),
    Match.when("payouts_unavailable", (): Popup => ({
      message: "Payouts aren't available in your account's currency yet.",
      retry: null,
      close: "dismiss",
    })),
    Match.orElse(() => undefined),
  );

// The list keeps its pages; this payout takes its standing as last read. One
// not on them was just confirmed, so it is the newest.
const listing = (list: PayoutsView, payout: Payout): PayoutsView => {
  const listed = list.page.payouts.some((shown) => shown.id === payout.id);

  const payouts = listed
    ? list.page.payouts.map((shown) => (shown.id === payout.id ? payout : shown))
    : [payout, ...list.page.payouts];

  return { ...list, page: { ...list.page, payouts } };
};

// What a read of a payout in flight can change; the rest is fixed at creation.
const moved = (shown: Payout, read: Payout) =>
  shown.status !== read.status || shown.reason !== read.reason || shown.journal_ref !== read.journal_ref ||
  shown.under_review !== read.under_review || shown.sent_at !== read.sent_at ||
  shown.completed_at !== read.completed_at;

// Refusals that end a payout's follow: asking again can't change them.
const followEnds = new Set(["not_found", "unauthorized", "business_required", "account_not_opened"]);

// Plane's block while support reviews a mismatch: calm, and nothing to do.
const payoutsPaused = "Payouts are paused while we review your account. No action needed; you can request one again once we're done."

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
              "We couldn't open an account for this business. Contact support.",
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
    EditPayoutSettings: (): Popup =>
      payoutBlocked(code) ?? { message: "Couldn't load the banks.", retry: operation, close: "dismiss" },
    // The link form opens whatever the payout check answers, so this can't show.
    StartLink: (): Popup => ({ message: "Couldn't open the link form.", retry: operation, close: "dismiss" }),
    ListPayouts: (): Popup =>
      payoutBlocked(code) ?? { message: "Couldn't load your payouts.", retry: operation, close: "dismiss" },
    SavePayoutSettings: (): Popup => payoutBlocked(code) ?? Match.value(code).pipe(
      Match.when("validation_error", () => ({
        message: "Plane refused the payout account. Check it and try again.", retry: null, close: "dismiss" as const,
      })),
      Match.orElse(() => ({
        message: "Couldn't save your payout settings.", retry: operation, close: "dismiss" as const,
      })),
    ),
    // Retry after an unknown outcome may create a second payout; the one
    // lost is never confirmed, so it expires and moves nothing.
    CreatePayout: (): Popup => payoutBlocked(code) ?? Match.value(code).pipe(
      // The list, read again, shows the settings as they now are.
      Match.when("payouts_automatic", () => ({
        message: "Payouts are automatic, so plane pays you out daily.", retry: null, close: "payouts" as const,
      })),
      // Most likely its bank was dropped, which a reload wouldn't show.
      Match.when("no_payout_account", () => ({
        message: "Save a payout account whose bank takes payouts first.", retry: null, close: "dismiss" as const,
      })),
      // Nothing here can succeed until support corrects it.
      Match.when("payouts_paused", () => ({
        message: payoutsPaused, retry: null, close: "payouts" as const,
      })),
      // Drafts expire in moments, so the form stays for another try.
      Match.when("payout_drafts_full", () => ({
        message: "Too many payouts are waiting to be confirmed. Wait a moment for them to expire, then try again.",
        retry: null,
        close: "dismiss" as const,
      })),
      Match.when("validation_error", () => ({
        message: "Plane refused the amount.", retry: null, close: "dismiss" as const,
      })),
      Match.orElse(() => ({
        message: "Couldn't create the payout.", retry: operation, close: "dismiss" as const,
      })),
    ),
    // A confirmation that can't go on goes back to the amount form.
    ConfirmPayout: (): Popup => payoutBlocked(code) ?? Match.value(code).pipe(
      Match.when("payout_expired", () => ({
        message: "This payout wasn't confirmed in time, so nothing was paid. Enter the amount again.",
        retry: null,
        close: "back" as const,
      })),
      // Plane cancels a draft when the mode or the rules changed, or while
      // payouts are paused; the list, read again, shows where things stand.
      Match.when("payout_cancelled", () => ({
        message: "This payout was cancelled, so nothing was paid.",
        retry: null,
        close: "payouts" as const,
      })),
      Match.when("not_found", () => ({
        message: "This payout is no longer available.", retry: null, close: "back" as const,
      })),
      Match.when("payout_rules_changed", () => ({
        message: "Payout rules changed, so this payout was cancelled and nothing was paid.",
        retry: null,
        close: "payouts" as const,
      })),
      Match.when("payouts_automatic", () => ({
        message: "Payouts are automatic now, so this payout was cancelled and plane pays you out daily.",
        retry: null,
        close: "payouts" as const,
      })),
      // Nothing here can succeed until support corrects it.
      Match.when("payouts_paused", () => ({
        message: `This payout was cancelled, so nothing was paid. ${payoutsPaused}`,
        retry: null,
        close: "payouts" as const,
      })),
      // The confirm may have gone through unseen. Retry is safe, by ID; Close
      // reads the list again, so a payout already going out shows there and
      // isn't requested twice.
      Match.orElse(() => ({
        message: "Couldn't confirm the payout.", retry: operation, close: "payouts" as const,
      })),
    ),
    OpenPayout: (): Popup => payoutBlocked(code) ?? Match.value(code).pipe(
      Match.when("not_found", () => ({
        message: "This payout is no longer available.", retry: null, close: "dismiss" as const,
      })),
      Match.orElse(() => ({
        message: "Couldn't load the payout.", retry: operation, close: "dismiss" as const,
      })),
    ),
    ListStatement: (): Popup => Match.value(code).pipe(
      Match.when("business_required", () => ({
        message: "Create a business first.", retry: null, close: "refresh" as const,
      })),
      Match.when("account_not_opened", () => ({
        message: "Your account isn't open yet.", retry: null, close: "refresh" as const,
      })),
      // Only a page's cursor can be refused; the period itself still loads.
      Match.when("validation_error", () => ({
        message: "That page is no longer available. Press r to reload the period.", retry: null, close: "dismiss" as const,
      })),
      Match.orElse(() => ({
        message: "Couldn't load your statement.", retry: operation, close: "dismiss" as const,
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
export const make = Effect.fnUntraced(function* (fingerprint: string, options: Options = {}) {
  const plane = yield* Plane.Service;

  const state = yield* SubscriptionRef.make<State>({
    view: View.Unknown(),
    pending: false,
    popup: null,
    settlementDelay: null,
  });

  const token = yield* Ref.make<
    { readonly value: string; readonly expiresAt: number } | undefined
  >(undefined);

  // Balance fetches run here, apart from the operation that showed home, so
  // they end with the connection and nothing waits on them.
  const balances = yield* FiberSet.make();

  const requests = yield* Ref.make(0);

  // Plane's bank list depends only on the ledger's currency, so each ledger's
  // is fetched once.
  const bankLists = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<Bank>>>(new Map());

  // Whether a payment link already asked for a payout account on this connection.
  const payoutAsked = yield* Ref.make(false);

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
    SubscriptionRef.update(state, (current) => ({ ...current, view, pending: false, popup: null }));

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

  const loadBanks = (business: Business) =>
    Effect.gen(function* () {
      const ledger = business.ledger?.slug ?? "";
      const cached = (yield* Ref.get(bankLists)).get(ledger);

      if (cached !== undefined) {
        return cached;
      }

      const { banks } = yield* authorized((client) => client.listBanks(undefined));

      yield* Ref.update(bankLists, (lists) => new Map([...lists, [ledger, banks]]));

      return banks;
    });

  // Without a cursor, the settings and the newest page; with one, the next page under the settings shown.
  const listPayouts = ({ business, before, previous, setup }: {
    readonly business: Business;
    readonly before: string | null;
    readonly previous: PayoutsView | null;
    readonly setup: boolean;
  }): Effect.Effect<View, Failure> =>
    Effect.gen(function* () {
      const list = authorized((client) => client.listPayouts({ params: before === null ? {} : { before } }));

      if (previous !== null) {
        const page = yield* list;

        return View.Payouts({ business, settings: previous.settings, page: { ...page, payouts: [...previous.page.payouts, ...page.payouts] } });
      }

      // The page is fetched alongside the settings, saving a round trip, but
      // only the list waits for it: its failure, or no answer at all, never
      // holds up the account form.
      const history = yield* Effect.forkChild(list, { startImmediately: true });
      const settings = yield* authorized((client) => client.getPayoutSettings(undefined));

      // No payout account means no payouts to list, only the form.
      if (setup && settings.destination === null) {
        yield* Fiber.interrupt(history);

        const banks = yield* loadBanks(business);

        return View.PayoutSettings({ business, settings, banks, origin: SettingsOrigin.Setup() });
      }

      return View.Payouts({ business, settings, page: yield* Fiber.join(history) });
    });

  // Runs an operation already marked pending. Its failure keeps the screen
  // behind as it was, except a failed load, which leaves the business unknown.
  const perform = (operation: Operation): Effect.Effect<void> =>
    Effect.gen(function* () {
      const request = yield* nextRequest;

      const outcome = yield* Effect.result(
        Operation.$match(operation, {
          Load: () =>
            authorized((client) => client.me(undefined)).pipe(
              Effect.tap(({ settlement_delay_seconds }) =>
                SubscriptionRef.update(state, (current) => ({ ...current, settlementDelay: settlement_delay_seconds })),
              ),
              Effect.map(({ business }) =>
                business === null
                  ? View.NoBusiness()
                  : home(business, request),
              ),
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
          ListStatement: ({ business, period, cursor, landing }) =>
            Effect.map(
              authorized((client) =>
                client.getStatement({ params: cursor === null ? { period } : { cursor } })
              ),
              (page) => View.Statement({ business, period, page, landing }),
            ),
          ListLinks: ({ business }) =>
            Effect.map(
              authorized((client) => client.listPaymentLinks(undefined)),
              (overview) => View.Links({ business, overview }),
            ),
          ListPayouts: listPayouts,
          SavePayoutSettings: ({ business, origin, change }) =>
            Effect.gen(function* () {
              const settings = yield* authorized((client) => client.changePayoutSettings({ payload: change }));

              return yield* SettingsOrigin.$match(origin, {
                Payouts: ({ list }) => Effect.succeed(View.Payouts({ ...list, settings })),
                // A payout needs saved settings, so before this save there were none.
                Setup: () => Effect.succeed(View.Payouts({ business, settings, page: { payouts: [], next: null } })),
                NewLink: ({ overview }) => Effect.succeed(View.CreatingLink({ business, overview })),
              });
            }),
          EditPayoutSettings: ({ list }) =>
            Effect.map(
              loadBanks(list.business),
              (banks) =>
                View.PayoutSettings({
                  business: list.business,
                  settings: list.settings,
                  banks,
                  origin: SettingsOrigin.Payouts({ list }),
                }),
            ),
          // Asked once, and never in the link's way: if the check fails, or the
          // currency has no payouts, the link form opens.
          StartLink: ({ business, overview }) =>
            Effect.gen(function* () {
              yield* Ref.set(payoutAsked, true);

              const prompt = Effect.gen(function* () {
                const settings = yield* authorized((client) => client.getPayoutSettings(undefined));

                if (settings.destination !== null) {
                  return View.CreatingLink({ business, overview });
                }

                const banks = yield* loadBanks(business);

                return View.PayoutSettings({ business, settings, banks, origin: SettingsOrigin.NewLink({ overview }) });
              });

              return yield* prompt.pipe(
                Effect.tapError((failure) => Effect.logInfo("payout account check skipped", failure)),
                Effect.orElseSucceed(() => View.CreatingLink({ business, overview })),
              );
            }),
          CreatePayout: ({ list, amount }) =>
            Effect.map(
              authorized((client) => client.createPayout({ payload: { amount } })),
              (payout) => View.ConfirmingPayout({ list, payout }),
            ),
          ConfirmPayout: ({ list, payout }) =>
            Effect.map(
              authorized((client) => client.confirmPayout(payout.id)),
              (confirmed) => View.PayoutDetail({ list, payout: confirmed }),
            ),
          OpenPayout: ({ list, id }) =>
            Effect.map(
              authorized((client) => client.getPayout(id)),
              (payout) => View.PayoutDetail({ list, payout }),
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
        ...current,
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

  const reload = (current: State): State => ({ ...current, view: View.Unknown(), pending: true, popup: null });

  const load = Effect.gen(function* () {
    if (yield* begin(() => true, reload)) {
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

  const requestStatement = (
    choose: (view: View) => Omit<Extract<Operation, { readonly _tag: "ListStatement" }>, "_tag"> | undefined,
  ) =>
    Effect.gen(function* () {
      const operation = yield* SubscriptionRef.modify(state, (current) => {
        const request = current.pending || current.popup !== null ? undefined : choose(current.view);

        return request === undefined
          ? ([undefined, current] as const)
          : ([Operation.ListStatement(request), { ...current, pending: true }] as const);
      });

      if (operation !== undefined) {
        yield* perform(operation);
      }
    });

  const openStatement = requestStatement((view) =>
    View.$is("HasBusiness")(view) && view.business.ledger !== null
      ? { business: view.business, period: defaultPeriod, cursor: null, landing: "first" }
      : undefined,
  );

  const statementPeriod = (period: Period) =>
    requestStatement((view) =>
      View.$is("Statement")(view)
        ? { business: view.business, period, cursor: null, landing: "first" }
        : undefined,
    );

  // Pages replace each other, so the opening and closing always cover the whole period.
  const statementPage = (direction: "next" | "previous") =>
    requestStatement((view) => {
      if (!View.$is("Statement")(view)) {
        return undefined;
      }

      const cursor = view.page[direction];

      return cursor === null
        ? undefined
        : { business: view.business, period: view.period, cursor, landing: direction === "next" ? "first" : "last" };
    });

  const refreshStatement = requestStatement((view) =>
    View.$is("Statement")(view)
      ? { business: view.business, period: view.period, cursor: null, landing: "first" }
      : undefined,
  );

  // Starts what `choose` picks for the screen showing, if anything, but only
  // when idle: no popup open and nothing pending. A `show` needs no request.
  const startWhenIdle = (choose: (view: View) => Operation | { readonly show: View } | undefined) =>
    Effect.gen(function* () {
      const operation = yield* SubscriptionRef.modify(state, (current) => {
        const chosen = current.pending || current.popup !== null ? undefined : choose(current.view);

        if (chosen === undefined) {
          return [undefined, current] as const;
        }

        return "show" in chosen
          ? ([undefined, { ...current, view: chosen.show }] as const)
          : ([chosen, { ...current, pending: true }] as const);
      });

      if (operation !== undefined) {
        yield* perform(operation);
      }
    });

  const managePayouts = startWhenIdle((view) =>
    View.$is("HasBusiness")(view) && view.business.status === "active" && view.business.ledger !== null
      ? Operation.ListPayouts({ business: view.business, before: null, previous: null, setup: true })
      : undefined,
  );

  const refreshPayouts = startWhenIdle((view) =>
    View.$is("Payouts")(view)
      ? Operation.ListPayouts({ business: view.business, before: null, previous: null, setup: false })
      : undefined,
  );

  const morePayouts = startWhenIdle((view) =>
    View.$is("Payouts")(view) && view.page.next !== null
      ? Operation.ListPayouts({ business: view.business, before: view.page.next, previous: view, setup: false })
      : undefined,
  );

  // From the list, or the payout itself, read again.
  const openPayout = (id: string) =>
    startWhenIdle((view) => {
      const list = View.$is("Payouts")(view) && view.page.payouts.some((payout) => payout.id === id)
        ? view
        : View.$is("PayoutDetail")(view) && view.payout.id === id
        ? view.list
        : undefined;

      return list === undefined ? undefined : Operation.OpenPayout({ list, id });
    });

  const editPayoutSettings = startWhenIdle((view) =>
    View.$is("Payouts")(view) ? Operation.EditPayoutSettings({ list: view }) : undefined
  );

  const savePayoutSettings = Effect.fnUntraced(function* (form: PayoutForm) {
    const shown = yield* SubscriptionRef.get(state).pipe(
      Effect.map((current) => (View.$is("PayoutSettings")(current.view) ? current.view : undefined)),
    );

    if (shown === undefined) {
      return;
    }

    const showing = (current: State) => View.$is("PayoutSettings")(current.view) && current.popup === null;
    const request = toSettingsRequest(form, shown.banks);

    if (Result.isFailure(request)) {
      return yield* begin(showing, (current) => ({
        ...current,
        popup: { message: request.failure, retry: null, close: "dismiss" },
      }));
    }

    if (yield* begin(showing, (current) => ({ ...current, pending: true }))) {
      yield* perform(Operation.SavePayoutSettings({ business: shown.business, origin: shown.origin, change: request.success }));
    }
  });

  // Automatic mode pays out on its own, so there is no form to show. The list
  // only shows once a payout account is saved.
  const startPayout = Effect.asVoid(
    begin(
      (current) =>
        View.$is("Payouts")(current.view) &&
        current.view.settings.mode === "manual" &&
        current.view.settings.destination !== null &&
        current.popup === null,
      (current) => (View.$is("Payouts")(current.view) ? { ...current, view: View.RequestingPayout({ list: current.view }) } : current),
    ),
  );

  const createPayout = Effect.fnUntraced(function* (text: string) {
    const operation = yield* SubscriptionRef.modify(state, (current): readonly [Operation | undefined, State] => {
      if (!View.$is("RequestingPayout")(current.view) || current.popup !== null || current.pending) {
        return [undefined, current];
      }

      const { list } = current.view;
      const amount = toAmount(text, list.settings.scale, list.settings.currency, Number(list.settings.minimum));

      return Result.isFailure(amount)
        ? [undefined, { ...current, popup: { message: amount.failure, retry: null, close: "dismiss" } }]
        : [Operation.CreatePayout({ list, amount: amount.success }), { ...current, pending: true }];
    });

    if (operation !== undefined) {
      yield* perform(operation);
    }
  });

  const confirmPayout = startWhenIdle((view) =>
    View.$is("ConfirmingPayout")(view) ? Operation.ConfirmPayout({ list: view.list, payout: view.payout }) : undefined
  );

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

  // The first link on a connection asks for a payout account if none is
  // saved; after that the form opens at once.
  const startPaymentLink = Effect.gen(function* () {
    const asked = yield* Ref.get(payoutAsked);

    yield* startWhenIdle((view) => {
      if (!View.$is("Links")(view) || view.business.ledger === null) {
        return undefined;
      }

      return asked ? { show: View.CreatingLink(view) } : Operation.StartLink(view);
    });
  });

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

    const reload = yield* SubscriptionRef.modify(state, (current): readonly [Operation | undefined, State] => {
      if (current.popup !== null || current.pending) {
        return [undefined, current];
      }

      const stay = [undefined, current] as const;

      const reloading = ({ business, overview }: { readonly business: Business; readonly overview: Overview }) =>
        [Operation.ListLinks({ business }), { ...current, view: View.Links({ business, overview }), pending: true }] as const;

      return View.$match(current.view, {
        Payments: ({ origin }) =>
          [undefined, { ...current, view: Predicate.isTagged(origin, "HasBusiness") ? home(origin.business, request) : origin }] as const,
        PaymentDetail: ({ list }) => [undefined, { ...current, view: View.Payments(list) }] as const,
        Statement: ({ business }) => [undefined, { ...current, view: home(business, request) }] as const,
        Unknown: () => stay,
        NoBusiness: () => stay,
        HasBusiness: () => stay,
        Links: ({ business }) => [undefined, { ...current, view: home(business, request) }] as const,
        LinkDetail: ({ business, overview }) =>
          [undefined, { ...current, view: View.Links({ business, overview }) }] as const,
        CreatingLink: reloading,
        LinkCreated: reloading,
        Payouts: ({ business }) => [undefined, { ...current, view: home(business, request) }] as const,
        PayoutSettings: ({ business, origin }) =>
          [
            undefined,
            {
              ...current,
              view: SettingsOrigin.$match(origin, {
                Payouts: ({ list }) => View.Payouts(list),
                Setup: () => home(business, request),
                // Later: the link doesn't need a payout account.
                NewLink: ({ overview }) => View.CreatingLink({ business, overview }),
              }),
            },
          ] as const,
        RequestingPayout: ({ list }) => [undefined, { ...current, view: View.Payouts(list) }] as const,
        // Left unconfirmed, it expires.
        ConfirmingPayout: ({ list }) => [undefined, { ...current, view: View.RequestingPayout({ list }) }] as const,
        PayoutDetail: ({ list, payout }) => [undefined, { ...current, view: View.Payouts(listing(list, payout)) }] as const,
      });
    });

    if (reload !== undefined) {
      return yield* perform(reload);
    }

    yield* startBalance(request);
  });

  // The payout screen showing while the payout can still change without the
  // merchant. Each new read of it is a new screen, which starts the follow
  // afresh.
  const followed = (current: State) =>
    View.$is("PayoutDetail")(current.view) && moving(current.view.payout.status) ? current.view : undefined;

  // The follow's rules, in one place:
  // - It reads the payout quietly, not as an operation, so the screen stays
  //   usable, and lands a change only on the screen it was read for, idle.
  //   A change that lands replaces the screen, which starts a fresh follow.
  // - A change held back by a popup or a request waits and lands on a later
  //   read once that clears; the follow never goes quiet while one waits.
  // - Only a read that differs from the last is news: news reads again after
  //   `every`; no news or a failed read doubles the wait, up to the backoff.
  // - It stops on a refusal asking again can't change (followEnds), and after
  //   `quiet` without news; `r` starts it again.
  const follow = (shown: Extract<View, { readonly _tag: "PayoutDetail" }>) =>
    Effect.gen(function* () {
      const every = options.followEvery ?? followEvery;
      const backoff = Duration.max(every, options.followBackoff ?? followBackoff);
      const quiet = Duration.toMillis(options.followQuiet ?? followQuiet);
      let quietSince = yield* Clock.currentTimeMillis;
      // The latest read, so only news restarts the quiet clock and the pace.
      let last = shown.payout;
      let wait = every;

      for (;;) {
        yield* Effect.sleep(wait);

        const waiting = moved(shown.payout, last);

        if (!waiting && (yield* Clock.currentTimeMillis) - quietSince >= quiet) {
          return yield* Effect.logDebug("payout follow went quiet");
        }

        const read = yield* Effect.result(authorized((client) => client.getPayout(shown.payout.id)));

        if (Result.isFailure(read)) {
          if (followEnds.has(codeOf(read.failure) ?? "")) {
            return yield* Effect.logWarning("payout follow stopped", read.failure);
          }

          yield* Effect.logWarning("payout follow failed", read.failure);
        } else {
          if (moved(shown.payout, read.success)) {
            yield* SubscriptionRef.update(state, (current) =>
              current.view === shown && !current.pending && current.popup === null
                ? { ...current, view: View.PayoutDetail({ list: shown.list, payout: read.success }) }
                : current);
          }

          const news = moved(last, read.success);

          last = read.success;

          if (news) {
            wait = every;
            quietSince = yield* Clock.currentTimeMillis;

            continue;
          }
        }

        wait = Duration.min(Duration.times(wait, 2), backoff);
      }
    });

  // One follow at a time, for this connection only: it starts when a moving
  // payout's screen shows, and stops once it settles or the screen changes.
  // Screens compare by identity, so a new read of the same payout restarts it.
  const following = yield* FiberHandle.make();

  yield* Effect.forkScoped(
    Stream.runForEach(
      SubscriptionRef.changes(state).pipe(Stream.map(followed), Stream.changesWith((a, b) => a === b)),
      (view) => (view === undefined ? FiberHandle.clear(following) : FiberHandle.run(following, follow(view))),
    ),
  );

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

    const next = yield* SubscriptionRef.modify(state, (current): readonly [Operation | undefined, State] => {
      if (current.popup?.close == null || current.pending) {
        return [undefined, current];
      }

      const draftView = View.$is("RequestingPayout")(current.view) || View.$is("ConfirmingPayout")(current.view)
        ? current.view
        : undefined;

      if (current.popup.close === "payouts" && draftView !== undefined) {
        return [
          Operation.ListPayouts({ business: draftView.list.business, before: null, previous: null, setup: false }),
          { ...current, view: View.Payouts(draftView.list), popup: null, pending: true },
        ];
      }

      if (current.popup.close === "back" && View.$is("ConfirmingPayout")(current.view)) {
        return [undefined, { ...current, view: View.RequestingPayout({ list: current.view.list }), popup: null }];
      }

      if (current.popup.close === "back") {
        const origin = View.$is("Payments")(current.view) ? current.view.origin : current.view;

        const view = Predicate.isTagged(origin, "LinkDetail")
          ? View.Links({ business: origin.business, overview: origin.overview })
          : Predicate.isTagged(origin, "HasBusiness") ? home(origin.business, request) : origin;

        return [undefined, { ...current, view, popup: null }];
      }

      return current.popup.close === "refresh"
        ? [Operation.Load(), reload(current)]
        : [undefined, { ...current, popup: null }];
    });

    if (next !== undefined) {
      return yield* perform(next);
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
    openStatement,
    statementPeriod,
    statementPage,
    refreshStatement,
    managePayouts,
    refreshPayouts,
    morePayouts,
    openPayout,
    editPayoutSettings,
    savePayoutSettings,
    startPayout,
    createPayout,
    confirmPayout,
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
