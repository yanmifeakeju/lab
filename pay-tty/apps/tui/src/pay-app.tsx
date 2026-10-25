import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js"

import { bright, error, ErrorPopup, gutter, linkScreenMinimum, muted } from "./app.tsx"
import { formatDecimal, formatMoney } from "./money.ts"
import { type Outcome, type Payable, type Payment, type State, View } from "./pay-session.ts"

/** What the customer's screens can ask of the connection; each returns at once. */
export interface PayActions {
  readonly start: (amount: string) => void
  readonly simulate: (outcome: Outcome) => void
  readonly tryAgain: () => void
  readonly retry: () => void
  readonly close: () => void
  readonly quit: () => void
}

const warning = "#e5c07b"

const success = "#98c379"

const outcomes: ReadonlyArray<readonly [Outcome, string]> = [
  ["succeeded", "Succeed"],
  ["failed", "Fail"],
  ["cancelled", "Cancel"],
]

const money = (link: Payable, minor: number) => formatMoney(minor, link.scale, link.currency_code)

/** Minutes and seconds left until the expiry, never below zero. */
export const countdown = (expiresAt: string, now: number) => {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))

  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
}

// What the amount field starts with: the suggestion, if the link has one.
const suggested = (link: Payable) =>
  link.pricing.mode === "customer_chooses" && link.pricing.suggested_amount !== null
    ? formatDecimal(link.pricing.suggested_amount, link.scale)
    : ""

const bounds = (link: Payable) => {
  const { pricing } = link

  if (pricing.mode === "fixed") {
    return ""
  }

  const settings = [
    ["Suggested", pricing.suggested_amount],
    ["Min", pricing.minimum_amount],
    ["Max", pricing.maximum_amount],
  ] as const

  return settings.flatMap(([label, minor]) => (minor === null ? [] : [`${label} ${money(link, minor)}`])).join(" · ")
}

const Heading = (props: { readonly link: Payable }) => (
  <>
    <text flexShrink={0} fg={muted}>{props.link.business_name}</text>
    <text flexShrink={0}>{props.link.title}</text>
  </>
)

const LinkScreen = (props: {
  readonly link: Payable
  readonly amount: string
  readonly focused: boolean
  readonly onAmount: (amount: string) => void
  readonly onSubmit: () => void
}) => (
  <scrollbox flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
    <Heading link={props.link} />
    <Show when={props.link.description}>
      {(description) => <text flexShrink={0} fg={muted}>{description()}</text>}
    </Show>
    <Switch>
      <Match when={!props.link.active}>
        <text flexShrink={0} fg={error}>This link is no longer accepting payments.</text>
      </Match>
      <Match when={props.link.pricing.mode === "fixed" ? props.link.pricing : undefined}>
        {(fixed) => <text flexShrink={0}>▸ Pay {money(props.link, fixed().amount)}</text>}
      </Match>
      <Match when={props.link.pricing.mode === "customer_chooses"}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={props.focused ? bright : muted}>Amount ({props.link.currency_code})</text>
          <input
            focused={props.focused}
            value={props.amount}
            maxLength={24}
            placeholder="2500.00"
            onInput={props.onAmount}
            onSubmit={props.onSubmit}
          />
          <Show when={bounds(props.link)}>{(shown) => <text fg={muted}>{shown()}</text>}</Show>
        </box>
      </Match>
    </Switch>
  </scrollbox>
)

// The outcomes stay in view below the details, which scroll on a short terminal.
const PayingScreen = (props: {
  readonly link: Payable
  readonly payment: Payment
  readonly now: number
  readonly choice: number
}) => (
  <box flexDirection="column" flexGrow={1} flexShrink={1}>
    <scrollbox flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
      <Heading link={props.link} />
      <text flexShrink={0}>Paying {money(props.link, props.payment.amount)}</text>
      <text flexShrink={0} fg={muted}>Expires in {countdown(props.payment.expires_at, props.now)}</text>
      <text flexShrink={0} fg={warning}>SIMULATED · no money moves</text>
    </scrollbox>
    <For each={outcomes}>
      {([, label], index) => (
        <text flexShrink={0} fg={index() === props.choice ? bright : muted}>
          {index() === props.choice ? "▸ " : "  "}
          {label}
        </text>
      )}
    </For>
  </box>
)

const results: Readonly<Record<Payment["status"], { readonly line: (amount: string) => string; readonly color: string }>> = {
  pending: { line: (amount) => `Paying ${amount}`, color: bright },
  succeeded: { line: (amount) => `✓ Paid ${amount}`, color: success },
  failed: { line: () => "✗ Payment failed", color: error },
  cancelled: { line: () => "Payment cancelled", color: muted },
  expired: { line: () => "This payment expired", color: muted },
}

const EndedScreen = (props: { readonly link: Payable; readonly payment: Payment }) => (
  <scrollbox flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
    <text flexShrink={0} fg={results[props.payment.status].color}>
      {results[props.payment.status].line(money(props.link, props.payment.amount))}
    </text>
    <Heading link={props.link} />
    <text flexShrink={0} fg={muted}>Reference {props.payment.id}</text>
  </scrollbox>
)

export const PayApp = (props: {
  readonly state: Accessor<State>
  readonly now: Accessor<number>
  readonly actions: PayActions
}) => {
  // Null until the customer types, so the field starts at the suggestion.
  const [typed, setTyped] = createSignal<string | null>(null)
  const [choice, setChoice] = createSignal(0)

  const view = () => props.state().view
  const popup = () => props.state().popup
  const pending = () => props.state().pending

  const showing = () => {
    const current = view()

    return View.$is("Link")(current) ? current.link : undefined
  }

  const paying = () => {
    const current = view()

    return View.$is("Paying")(current) ? current : undefined
  }

  const ended = () => {
    const current = view()

    return View.$is("Ended")(current) ? current : undefined
  }

  const amount = () => {
    const link = showing()

    return typed() ?? (link === undefined ? "" : suggested(link))
  }

  // Each pending payment starts on the first outcome.
  createEffect(on(() => paying()?.payment.id, () => setChoice(0)))

  const terminal = useTerminalDimensions()
  const short = () => terminal().height < 14

  const roomy = () => terminal().width >= linkScreenMinimum.width && terminal().height >= linkScreenMinimum.height

  const hint = () => {
    if (pending()) {
      return View.$is("Paying")(view()) ? "Reporting the outcome…" : "Starting your payment…"
    }

    const link = showing()
    const result = ended()

    if (link !== undefined) {
      return link.active ? "Enter pay · Esc quit" : "Esc quit"
    }

    if (paying() !== undefined) {
      return terminal().width < 56 ? "↑/↓ · Enter · Esc" : "↑/↓ choose · Enter confirm · Esc quit"
    }

    if (result !== undefined) {
      return result.payment.status === "succeeded" ? "Esc quit" : "Enter try again · Esc quit"
    }

    return "Esc quit"
  }

  const start = () => props.actions.start(amount())

  useKeyboard((key) => {
    if (key.ctrl && (key.name === "c" || key.name === "d")) {
      return props.actions.quit()
    }

    const open = popup()
    const enter = key.name === "return" || key.name === "enter"

    if (open !== null) {
      key.preventDefault()

      if (enter) {
        return open.retry === null ? props.actions.close() : props.actions.retry()
      }

      if (key.name === "escape") {
        props.actions.close()
      }

      return
    }

    if (key.name === "escape") {
      return props.actions.quit()
    }

    // A customer-chosen amount submits from its input.
    if (showing()?.pricing.mode === "fixed" && enter) {
      return start()
    }

    if (paying() !== undefined) {
      if (key.name === "up" || key.name === "down") {
        setChoice((at) => (at + (key.name === "up" ? -1 : 1) + outcomes.length) % outcomes.length)
      }

      if (enter) {
        props.actions.simulate(outcomes[choice()]?.[0] ?? "succeeded")
      }

      return
    }

    const result = ended()

    if (result !== undefined && enter) {
      if (result.payment.status === "succeeded") {
        return props.actions.quit()
      }

      setTyped(null)
      props.actions.tryAgain()
    }

    if (View.$is("NotFound")(view()) && enter) {
      props.actions.quit()
    }
  })

  return (
    <box
      border
      width="100%"
      height="100%"
      paddingX={1}
      paddingY={short() ? 0 : 1}
      flexDirection="column"
      gap={short() ? 0 : 1}
      title=" pay-tty "
    >
      <Switch>
        <Match when={View.$is("Loading")(view())}>
          <text fg={muted}>Loading…</text>
        </Match>
        <Match when={View.$is("NotFound")(view())}>
          <text>No payment link has this token.</text>
        </Match>
        <Match when={!roomy()}>
          <text fg={muted}>
            Enlarge the terminal to {linkScreenMinimum.width}×{linkScreenMinimum.height}.
          </text>
        </Match>
        <Match when={showing()}>
          {(link) => (
            <LinkScreen
              link={link()}
              amount={amount()}
              focused={popup() === null && !pending()}
              onAmount={setTyped}
              onSubmit={start}
            />
          )}
        </Match>
        <Match when={paying()}>
          {(shown) => <PayingScreen link={shown().link} payment={shown().payment} now={props.now()} choice={choice()} />}
        </Match>
        <Match when={ended()}>{(shown) => <EndedScreen link={shown().link} payment={shown().payment} />}</Match>
      </Switch>
      <text flexShrink={0} fg={muted}>{hint()}</text>
      <Show when={popup()}>{(open) => <ErrorPopup popup={open()} pending={pending()} />}</Show>
    </box>
  )
}
