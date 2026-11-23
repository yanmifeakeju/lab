import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch } from "solid-js"

import {
  collected,
  emptyForm,
  type Form,
  formatTime,
  type Link,
  listHeading,
  listRow,
  type Mode,
  narrowRow,
  oneLine,
  type Overview,
  pricingLines,
  statusLine,
  type Summary,
  totalsLine,
  withMode,
} from "./payment-link.ts"
import { delayLabel, filterLine, filters, type Page, paymentRows, paymentTiming, type State as PaymentState, timelineLines } from "./payments.ts"
import { formatMoney } from "./money.ts"
import {
  amountLine,
  balanceSummary,
  destinationLabel,
  destinationLine,
  expiryTime,
  reviewKey,
  troubled,
  detailLines,
  type Field as PayoutField,
  type Form as PayoutForm,
  formOf,
  type Payout,
  payoutRows,
  settingsLine,
  statusLine as payoutStatusLine,
} from "./payouts.ts"
import { Balance, type Business, type Popup, type PayoutsView, SettingsOrigin, type State, type StatementView, View } from "./session.ts"
import { balanceLine, movementId, type Period, periodLine, periods, type Statement, statementHints, statementRows } from "./statement.ts"

type PayoutSettingsView = Extract<View, { readonly _tag: "PayoutSettings" }>

/** What the screens can ask of the connection; each returns at once. */
export interface Actions {
  readonly createBusiness: (name: string) => void
  readonly openAccount: () => void
  readonly refreshBalance: () => void
  readonly managePayments: () => void
  readonly linkPayments: (id: string) => void
  readonly refreshPayments: () => void
  readonly filterPayments: (state: PaymentState | null) => void
  readonly morePayments: () => void
  readonly openPayment: (id: string) => void
  readonly openStatement: () => void
  readonly statementPeriod: (period: Period) => void
  readonly statementPage: (direction: "next" | "previous") => void
  readonly refreshStatement: () => void
  readonly managePayouts: () => void
  readonly refreshPayouts: () => void
  readonly morePayouts: () => void
  readonly openPayout: (id: string) => void
  readonly editPayoutSettings: () => void
  readonly savePayoutSettings: (form: PayoutForm) => void
  readonly startPayout: () => void
  readonly createPayout: (amount: string) => void
  readonly confirmPayout: () => void
  readonly manageLinks: () => void
  readonly refreshLinks: () => void
  readonly openLink: (id: string) => void
  readonly startPaymentLink: () => void
  readonly createPaymentLink: (form: Form) => void
  readonly back: () => void
  readonly home: () => void
  readonly retry: () => void
  readonly close: () => void
  readonly quit: () => void
}

export const error = "#ff6b6b"

export const muted = "#888888"

export const bright = "#ffffff"

const sourceUrl = "https://github.com/yanmifeakeju/lab/tree/main/pay-tty"

const countries = { NG: "Nigeria", US: "United States" } as const

const CreateBusiness = (props: {
  readonly draft: string
  readonly focused: boolean
  readonly pending: boolean
  readonly onInput: (name: string) => void
  readonly onSubmit: () => void
}) => (
  <box flexDirection="column" gap={1}>
    <text>Create your business</text>
    <box flexDirection="column">
      <text fg={muted}>Business name</text>
      <input
        focused={props.focused}
        value={props.draft}
        maxLength={255}
        placeholder="Acme Ltd"
        onInput={props.onInput}
        onSubmit={props.onSubmit}
      />
    </box>
    {/* Nigeria is the only country with a ledger so far. */}
    <text fg={muted}>Country: Nigeria</text>
    <Show when={props.pending} fallback={<text fg={muted}>Press Enter to create it.</text>}>
      <text>Creating your business…</text>
    </Show>
  </box>
)

const ShowBalance = (props: { readonly balance: Balance }) => (
  <Switch>
    <Match when={Balance.$is("Unavailable")(props.balance)}>
      <text fg={muted}>Balance unavailable · r to retry</text>
    </Match>
    <Match when={Balance.$is("Loaded")(props.balance) ? props.balance : undefined}>
      {(loaded) => (
        <box flexDirection="column">
          <text>Balance</text>
          <text>{"  " + balanceSummary(loaded().figures)}</text>
        </box>
      )}
    </Match>
    <Match when={true}>
      <box flexDirection="column">
        <text>Balance</text>
        <text fg={muted}>  Loading…</text>
      </box>
    </Match>
  </Switch>
)

const ShowBusiness = (props: {
  readonly business: Business
  readonly balance: Balance | null
  readonly pending: boolean
  readonly selected: number
  readonly short: boolean
  // Too few rows for every line: the country goes, its currency still shown in the amounts.
  readonly cramped: boolean
  // Rows to spare below the menu for what a first visit needs to know.
  readonly roomy: boolean
  /** A demo's settlement delay in seconds; null outside a demo. */
  readonly settlementDelay: number | null
}) => (
  <box flexDirection="column" gap={props.short ? 0 : 1}>
    <box flexDirection="column">
      <text>{props.business.name}</text>
      <Show when={!props.cramped || props.balance === null}>
        <text fg={muted}>
          {countries[props.business.country_code]} · {props.business.currency_code}
        </text>
      </Show>
      <Show when={props.business.ledger === null}>
        <text fg={muted}>No account yet</text>
      </Show>
    </box>
    <Show when={props.balance}>{(balance) => <ShowBalance balance={balance()} />}</Show>
    <Switch>
      <Match when={props.pending}>
        <text>{props.business.status === "created" ? "Opening your account…" : "Loading…"}</text>
      </Match>
      <Match when={props.business.status === "created"}>
        <text fg={muted}>Press o to open your account. Payment links need it.</text>
      </Match>
      <Match when={props.business.ledger !== null}>
        <box flexDirection="column">
          <text fg={props.selected === 0 ? bright : muted}>{props.selected === 0 ? "› " : "  "}{"Payments        p"}</text>
          <text fg={props.selected === 1 ? bright : muted}>{props.selected === 1 ? "› " : "  "}{"Payment links   l"}</text>
          <text fg={props.selected === 2 ? bright : muted}>{props.selected === 2 ? "› " : "  "}{"Statement       s"}</text>
          <text fg={props.selected === 3 ? bright : muted}>{props.selected === 3 ? "› " : "  "}{"Payouts         o"}</text>
        </box>
      </Match>
    </Switch>
    <Show when={props.roomy && !props.pending && props.business.ledger !== null}>
      <box flexDirection="column">
        <text fg={muted}>Payments are simulated; no money moves.</text>
        <Show when={props.settlementDelay}>
          {(delay) => <text fg={muted}>Payments settle after {delayLabel(delay())}, then count as Available.</text>}
        </Show>
        <text fg={muted}>Open a payment link in a second terminal to pay it yourself.</text>
        <text fg={muted}>Press d on any screen to come back here.</text>
        <text fg={muted}>
          Source: <a href={sourceUrl}>github.com/yanmifeakeju/lab/tree/main/pay-tty</a>
        </text>
      </box>
    </Show>
  </box>
)

type Field = "title" | "description" | "mode" | "amount" | "suggested" | "minimum" | "maximum"

const fieldsFor = (mode: Mode): ReadonlyArray<Field> =>
  mode === "fixed"
    ? ["title", "description", "mode", "amount"]
    : ["title", "description", "mode", "suggested", "minimum", "maximum"]

const modes: Readonly<Record<Mode, string>> = { fixed: "Fixed amount", customer_chooses: "Customer chooses" }

// Below this the link screens show a resize prompt instead of their content.
export const linkScreenMinimum = { width: 32, height: 10 } as const

const fieldId = (field: Field) => `link-field-${field}`

// Text wraps to the full width before the scrollbar takes the last column, so
// a one-column gutter keeps every character clear of it.
export const gutter = { paddingRight: 1 }

// Keeps the scrollbox's child with this ID in view whenever a trigger changes.
// Positions are only known once a frame is laid out, so the scroll happens
// after one, then redraws.
const useReveal = (
  box: () => ScrollBoxRenderable | undefined,
  id: () => string,
  triggers: ReadonlyArray<() => string | number | undefined>,
) => {
  const renderer = useRenderer()
  let revealing = true

  const reveal = () => {
    const shown = box()

    if (revealing && shown !== undefined) {
      revealing = false
      shown.scrollChildIntoView(id())
      renderer.requestRender()
    }
  }

  renderer.addPostProcessFn(reveal)
  onCleanup(() => renderer.removePostProcessFn(reveal))

  createEffect(on([...triggers], () => {
    revealing = true
    renderer.requestRender()
  }))
}

// A label over its input, kept whole so scrolling never splits them.
const TextField = (props: {
  readonly field: Field
  readonly label: string
  readonly value: string
  readonly focused: boolean
  readonly maxLength: number
  readonly placeholder: string
  readonly onInput: (value: string) => void
  readonly onSubmit: () => void
}) => (
  <box id={fieldId(props.field)} flexDirection="column" flexShrink={0}>
    <text fg={props.focused ? bright : muted}>{props.label}</text>
    <input
      focused={props.focused}
      value={props.value}
      maxLength={props.maxLength}
      placeholder={props.placeholder}
      onInput={props.onInput}
      onSubmit={props.onSubmit}
    />
  </box>
)

const CreateLink = (props: {
  readonly business: Business
  readonly form: Form
  readonly focus: Field
  readonly active: boolean
  readonly pending: boolean
  readonly onChange: (form: Form) => void
  readonly onSubmit: () => void
}) => {
  let fields: ScrollBoxRenderable | undefined

  const terminal = useTerminalDimensions()
  const focused = (field: Field) => props.active && props.focus === field
  const set = (field: Exclude<Field, "mode">) => (value: string) => props.onChange({ ...props.form, [field]: value })

  const amount = (field: Exclude<Field, "title" | "description" | "mode">, label: string, placeholder = "") => (
    <TextField
      field={field}
      label={label}
      value={props.form[field]}
      focused={focused(field)}
      maxLength={24}
      placeholder={placeholder}
      onInput={set(field)}
      onSubmit={props.onSubmit}
    />
  )

  // Keeps the focused field and its label in view.
  useReveal(() => fields, () => fieldId(props.focus), [
    () => props.focus,
    () => props.form.mode,
    () => terminal().width,
    () => terminal().height,
  ])

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <text flexShrink={0}>Create payment link</text>
      <scrollbox ref={(box) => (fields = box)} flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
        <TextField
          field="title"
          label="Title"
          value={props.form.title}
          focused={focused("title")}
          maxLength={255}
          placeholder="Community fundraiser"
          onInput={set("title")}
          onSubmit={props.onSubmit}
        />
        <TextField
          field="description"
          label="Description (optional)"
          value={props.form.description}
          focused={focused("description")}
          maxLength={500}
          placeholder="Help equip the library"
          onInput={set("description")}
          onSubmit={props.onSubmit}
        />
        <box id={fieldId("mode")} flexDirection="column" flexShrink={0}>
          <text fg={focused("mode") ? bright : muted}>Pricing</text>
          <text>{focused("mode") ? `‹ ${modes[props.form.mode]} ›` : modes[props.form.mode]}</text>
          <text fg={muted}>Currency: {props.business.currency_code}</text>
        </box>
        <Show
          when={props.form.mode === "fixed"}
          fallback={
            <>
              {amount("suggested", "Suggested (optional)", "2500.00")}
              {amount("minimum", "Minimum (optional)")}
              {amount("maximum", "Maximum (optional)")}
            </>
          }
        >
          {amount("amount", "Amount", "2500.00")}
        </Show>
      </scrollbox>
      <Show
        when={props.pending}
        fallback={
          <text flexShrink={0} fg={muted}>
            {terminal().width < 56 ? "Tab · ←/→ · Enter · Esc" : "Tab next · ←/→ pricing · Enter create · Esc cancel"}
          </text>
        }
      >
        <text flexShrink={0}>Creating your payment link…</text>
      </Show>
    </box>
  )
}

// A link's title, pricing, and how customers pay it, with anything else the
// screen adds in between.
const LinkDetails = (props: { readonly link: Link; readonly payCommand: string; readonly children?: JSX.Element }) => (
  <>
    <text flexShrink={0}>{props.link.title}</text>
    <Show when={props.link.description}>
      {(description) => <text flexShrink={0} fg={muted}>{description()}</text>}
    </Show>
    <For each={pricingLines(props.link)}>{(line) => <text flexShrink={0}>{line}</text>}</For>
    {props.children}
    <text flexShrink={0} fg={muted}>Reference: {props.link.id}</text>
    <text flexShrink={0} fg={muted}>Customers pay with:</text>
    <text flexShrink={0}>{props.payCommand}</text>
  </>
)

// What became of the last c on a link screen: the terminal was sent the
// command, or it can't take one.
type Copied = "sent" | "unsupported"

// OSC 52 is fire and forget: a terminal that ignores it says nothing, so
// "sent" says what to do if nothing pastes. It names no key: the copy key
// differs by platform, and Ctrl+C here quits.
const copiedLine = (copied: Copied, width: number) =>
  copied === "sent"
    ? width < 65
      ? "Copied; else select and copy"
      : "Copied. If it doesn't paste, select the command and copy it."
    : width < 56
      ? "Can't copy; select it"
      : "This terminal can't copy; select the command"

// The merchant's text wraps inside the scrolled area; Back stays below it.
const LinkScreen = (props: {
  readonly heading: string
  readonly hint?: string
  readonly copied: Copied | null
  readonly onScroll: (scroll: (by: number) => void) => void
  readonly children: JSX.Element
}) => {
  let details: ScrollBoxRenderable | undefined

  const terminal = useTerminalDimensions()
  const narrow = () => terminal().width < 56

  props.onScroll((by) => details?.scrollBy(by))

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <text flexShrink={0}>{props.heading}</text>
      <scrollbox ref={(box) => (details = box)} flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
        {props.children}
      </scrollbox>
      <Show when={props.copied}>
        {(copied) => <text flexShrink={0}>{copiedLine(copied(), terminal().width)}</text>}
      </Show>
      <text flexShrink={0} fg={muted}>
        {props.hint ?? (narrow() ? "[Esc] Back · ↑/↓ · c copy" : "[Esc] Back · ↑/↓ scroll · c copy command")}
      </text>
    </box>
  )
}

const rowId = (link: Summary) => `link-row-${link.id}`

// The border, its padding, the scrollbar and its gutter, and the selection
// marker. A row any wider wraps once the list overflows.
const rowChrome = 2 + 2 + 1 + gutter.paddingRight + 2

const LinkList = (props: {
  readonly business: Business
  readonly overview: Overview
  readonly selected: number
  readonly pending: boolean
}) => {
  let rows: ScrollBoxRenderable | undefined

  const terminal = useTerminalDimensions()
  const scale = () => props.business.ledger?.scale ?? 0
  const selectedId = () => props.overview.links[props.selected]?.id
  const narrow = () => terminal().width - rowChrome < narrowRow

  useReveal(() => rows, () => `link-row-${selectedId() ?? ""}`, [
    selectedId,
    () => terminal().width,
    () => terminal().height,
  ])

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <text flexShrink={0}>{listHeading(props.overview)}</text>
      <text flexShrink={0} fg={muted}>
        {totalsLine(props.overview.totals, scale(), props.business.currency_code, narrow())}
      </text>
      <Show
        when={props.overview.links.length > 0}
        fallback={<text flexShrink={0} fg={muted}>No payment links yet. Press n to create one.</text>}
      >
        <scrollbox ref={(box) => (rows = box)} flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
          <For each={props.overview.links}>
            {(link, index) => (
              <text id={rowId(link)} flexShrink={0} fg={index() === props.selected ? bright : muted}>
                {index() === props.selected ? "› " : "  "}
                {listRow(link, terminal().width - rowChrome)}
              </text>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={props.overview.link_count > props.overview.links.length}>
        <text flexShrink={0} fg={muted}>
          Showing the newest {props.overview.links.length} of {props.overview.link_count}.
        </text>
      </Show>
      <Show
        when={props.pending}
        fallback={
          <text flexShrink={0} fg={muted}>
            {terminal().width < 64 ? "↑/↓ · Enter · n · r · Esc" : "↑/↓ select · Enter open · n new · r refresh · Esc back"}
          </text>
        }
      >
        <text flexShrink={0}>Refreshing…</text>
      </Show>
    </box>
  )
}

const PaymentList = (props: {
  readonly business: Business
  readonly page: Page
  readonly state: PaymentState | null
  readonly title: string | undefined
  readonly selected: number
  readonly pending: boolean
}) => {
  let rows: ScrollBoxRenderable | undefined
  const terminal = useTerminalDimensions()
  const rowWidth = () => terminal().width - rowChrome
  const formattedRows = createMemo(() => paymentRows(props.page.payments, rowWidth(), props.title !== undefined))

  const selectedId = () => props.page.payments[props.selected]?.id ?? "more"

  useReveal(() => rows, () => "payment-row-" + selectedId(), [
    selectedId, () => terminal().width, () => terminal().height,
  ])

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <text flexShrink={0}>{props.title === undefined ? "Payments" : "Payments · " + props.title}</text>
      <text flexShrink={0} fg={muted}>
        {totalsLine(props.page.stats, props.business.ledger?.scale ?? 0, props.business.currency_code, rowWidth() < narrowRow)}
      </text>
      <text flexShrink={0} fg={muted}>
        {filterLine(props.state, rowWidth())}
      </text>
      <Show when={props.page.payments.length > 0} fallback={
        <text flexShrink={0} fg={muted}>
          {props.state === null ? "No payments yet." : "No " + props.state + " payments."}
        </text>
      }>
        <scrollbox ref={(box) => (rows = box)} flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
          <For each={props.page.payments}>{(payment, index) => (
            <text id={"payment-row-" + payment.id} flexShrink={0}
              fg={payment.state === "attention" ? error : index() === props.selected ? bright : muted}>
              {index() === props.selected ? "› " : "  "}
              {formattedRows()[index()]}
            </text>
          )}</For>
          <Show when={props.page.next !== null}>
            <text id="payment-row-more" flexShrink={0} fg={props.selected === props.page.payments.length ? bright : muted}>
              {props.selected === props.page.payments.length ? "› " : "  "}Load more
            </text>
          </Show>
        </scrollbox>
      </Show>
      <text flexShrink={0} fg={muted}>
        {props.pending ? "Loading…" : terminal().width < 64 ? "↑/↓ · Enter · r · Esc" : "↑/↓ select · Enter open · r refresh · Esc back"}
      </text>
    </box>
  )
}

// The header and footer stay outside the scrolled rows, so the opening,
// closing and keys are always on screen.
const StatementScreen = (props: {
  readonly view: StatementView
  readonly selected: number
  readonly pending: boolean
}) => {
  let rows: ScrollBoxRenderable | undefined
  const terminal = useTerminalDimensions()
  // Inside the border and its padding.
  const lineWidth = () => terminal().width - 4
  const formattedRows = createMemo(() => statementRows(props.view.page, terminal().width - rowChrome))

  const selectedId = () => {
    const movement = props.view.page.movements[props.selected]

    return movement === undefined ? "" : movementId(movement)
  }

  useReveal(() => rows, selectedId, [selectedId, () => terminal().width, () => terminal().height])

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <text flexShrink={0}>{periodLine(props.view.period, lineWidth())}</text>
      <text flexShrink={0} fg={muted}>{balanceLine(props.view.page, lineWidth())}</text>
      <Show when={props.view.page.movements.length > 0} fallback={
        <text flexShrink={0} fg={muted}>No movements in this period.</text>
      }>
        <scrollbox ref={(box) => (rows = box)} flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
          <For each={props.view.page.movements}>{(movement, index) => (
            <text id={movementId(movement)} flexShrink={0} fg={index() === props.selected ? bright : muted}>
              {index() === props.selected ? "› " : "  "}
              {formattedRows()[index()]}
            </text>
          )}</For>
        </scrollbox>
      </Show>
      <text flexShrink={0} fg={muted}>Up to a minute ago</text>
      <text flexShrink={0} fg={muted}>
        {props.pending ? "Loading…" : statementHints(props.view.page, terminal().width < 64)}
      </text>
    </box>
  )
}

const PayoutList = (props: { readonly view: PayoutsView; readonly selected: number; readonly pending: boolean }) => {
  let rows: ScrollBoxRenderable | undefined
  const terminal = useTerminalDimensions()
  const manual = () => props.view.settings.mode === "manual"
  const formattedRows = createMemo(() => payoutRows(props.view.page.payouts, terminal().width - rowChrome))
  const selectedId = () => props.view.page.payouts[props.selected]?.id ?? "more"

  useReveal(() => rows, () => "payout-row-" + selectedId(), [
    selectedId, () => terminal().width, () => terminal().height,
  ])

  const hints = () => {
    const narrow = terminal().width < 64

    return manual()
      ? narrow ? "↑/↓ · Enter · n · c · r · Esc" : "↑/↓ · Enter open · n new · c settings · r refresh · Esc back"
      : narrow ? "↑/↓ · Enter · c · r · Esc" : "↑/↓ · Enter open · c settings · r refresh · Esc back"
  }

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <text flexShrink={0}>Payouts</text>
      <text flexShrink={0} fg={props.view.settings.destination === null ? error : muted}>{settingsLine(props.view.settings)}</text>
      <Show when={props.view.page.payouts.length > 0} fallback={
        <text flexShrink={0} fg={muted}>{manual() ? "No payouts yet. Press n to request one." : "No payouts yet."}</text>
      }>
        <scrollbox ref={(box) => (rows = box)} flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
          <For each={props.view.page.payouts}>{(payout, index) => (
            <text id={"payout-row-" + payout.id} flexShrink={0}
              fg={troubled(payout) ? error : index() === props.selected ? bright : muted}>
              {index() === props.selected ? "› " : "  "}
              {formattedRows()[index()]}
            </text>
          )}</For>
          <Show when={props.view.page.next !== null}>
            <text id="payout-row-more" flexShrink={0} fg={props.selected === props.view.page.payouts.length ? bright : muted}>
              {props.selected === props.view.page.payouts.length ? "› " : "  "}Load more
            </text>
          </Show>
        </scrollbox>
      </Show>
      <Show when={reviewKey(props.view.page.payouts)}>
        {(key) => <text flexShrink={0} fg={muted}>{key()}</text>}
      </Show>
      <text flexShrink={0} fg={muted}>{props.pending ? "Loading…" : hints()}</text>
    </box>
  )
}

const payoutFieldId = (field: PayoutField) => `payout-field-${field}`

const PayoutSettingsForm = (props: {
  readonly view: PayoutSettingsView
  readonly form: PayoutForm
  readonly focus: PayoutField
  readonly active: boolean
  readonly pending: boolean
  readonly onChange: (form: PayoutForm) => void
  readonly onSubmit: () => void
}) => {
  let fields: ScrollBoxRenderable | undefined

  const terminal = useTerminalDimensions()
  const focused = (field: PayoutField) => props.active && props.focus === field
  const choice = (field: PayoutField, text: string) => (focused(field) ? `‹ ${text} ›` : text)
  const bank = () => (props.form.bank === null ? undefined : props.view.banks[props.form.bank]?.name) ?? "Choose a bank"

  // Where it was opened from sets its heading and what Esc does.
  const copy = () =>
    SettingsOrigin.$match(props.view.origin, {
      Payouts: () => ({ title: "Payout settings", note: null, escape: "cancel" }),
      Setup: () => ({ title: "Set up payouts", note: "Add the bank account your payouts go to.", escape: "back" }),
      NewLink: () => ({
        title: "Where should we send your money?",
        note: "Payments wait in your balance until you add one.",
        escape: "later",
      }),
    })

  useReveal(() => fields, () => payoutFieldId(props.focus), [
    () => props.focus,
    () => terminal().width,
    () => terminal().height,
  ])

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <text flexShrink={0}>{copy().title}</text>
      <Show when={copy().note}>{(note) => <text flexShrink={0} fg={muted}>{note()}</text>}</Show>
      <scrollbox ref={(box) => (fields = box)} flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
        <box id={payoutFieldId("mode")} flexDirection="column" flexShrink={0}>
          <text fg={focused("mode") ? bright : muted}>Payouts</text>
          <text>{choice("mode", props.form.mode === "automatic" ? "Automatic · daily at 00:00 UTC" : "Manual")}</text>
        </box>
        <box id={payoutFieldId("bank")} flexDirection="column" flexShrink={0}>
          <text fg={focused("bank") ? bright : muted}>Bank</text>
          <text>{choice("bank", bank())}</text>
        </box>
        <box id={payoutFieldId("accountNumber")} flexDirection="column" flexShrink={0}>
          <text fg={focused("accountNumber") ? bright : muted}>Account number</text>
          <input
            focused={focused("accountNumber")}
            value={props.form.accountNumber}
            maxLength={10}
            placeholder="0123456789"
            onInput={(accountNumber) => props.onChange({ ...props.form, accountNumber })}
            onSubmit={props.onSubmit}
          />
        </box>
        {/* Not a field: the account holder is the business. */}
        <box flexDirection="column" flexShrink={0}>
          <text fg={muted}>Account name</text>
          <text>{oneLine(props.view.business.name)}</text>
        </box>
        <text flexShrink={0} fg={muted}>Payouts go to this account in {props.view.settings.currency}.</text>
      </scrollbox>
      <text flexShrink={0} fg={muted}>
        {props.pending
          ? "Saving…"
          : terminal().width < 56
          ? "Tab · ←/→ · Enter · Esc"
          : `Tab next · ←/→ change · Enter save · Esc ${copy().escape}`}
      </text>
    </box>
  )
}

const RequestPayoutForm = (props: {
  readonly view: PayoutsView
  readonly amount: string
  readonly active: boolean
  readonly onInput: (amount: string) => void
  readonly onSubmit: () => void
}) => (
  <box flexDirection="column" flexGrow={1} flexShrink={1}>
    <text flexShrink={0}>New payout</text>
    <Show when={props.view.settings.destination}>
      {(destination) => <text flexShrink={0} fg={muted}>To {destinationLabel(destination())}</text>}
    </Show>
    <box flexDirection="column" flexShrink={0}>
      <text fg={props.active ? bright : muted}>Amount ({props.view.settings.currency})</text>
      <input
        focused={props.active}
        value={props.amount}
        maxLength={24}
        placeholder="2500.00"
        onInput={props.onInput}
        onSubmit={props.onSubmit}
      />
    </box>
    <text flexShrink={0} fg={muted}>Enter continue · Esc cancel</text>
  </box>
)

// The payout as plane created it: its amount and destination are what confirming pays.
const ConfirmPayout = (props: { readonly payout: Payout; readonly pending: boolean }) => (
  <box flexDirection="column" flexGrow={1} flexShrink={1}>
    <text flexShrink={0}>Confirm payout</text>
    <text flexShrink={0}>Pay out {amountLine(props.payout)}</text>
    <text flexShrink={0}>{destinationLine(props.payout)}</text>
    {props.payout.expires_at === null ? null : (
      <text flexShrink={0} fg={muted}>Confirm by {expiryTime(props.payout.expires_at)}, or it expires.</text>
    )}
    <text flexShrink={0} fg={muted}>
      {props.pending ? "Waiting for plane…" : "[Enter] Confirm · [Esc] Back"}
    </text>
  </box>
)

const PayoutDetail = (props: { readonly payout: Payout; readonly pending: boolean }) => (
  <box flexDirection="column" flexGrow={1} flexShrink={1}>
    <text flexShrink={0}>Payout</text>
    <For each={detailLines(props.payout)}>{(line) => <text flexShrink={0}>{line}</text>}</For>
    <text flexShrink={0} fg={troubled(props.payout) ? error : bright}>
      {payoutStatusLine(props.payout)}
    </text>
    <text flexShrink={0} fg={muted}>Payout ID: {props.payout.id}</text>
    <text flexShrink={0} fg={muted}>
      {props.pending ? "Loading…" : "[r] Refresh · [Esc] Back"}
    </text>
  </box>
)

// What a link's payments came to, between its pricing and how to pay it.
const LinkStats = (props: { readonly link: Summary }) => (
  <>
    <text flexShrink={0}>
      Collected: {collected(props.link.stats, props.link.scale, props.link.currency_code)}
    </text>
    <text flexShrink={0} fg={muted}>{statusLine(props.link.stats)}</text>
    <Show when={props.link.stats.last_paid_at}>
      {(at) => <text flexShrink={0} fg={muted}>Last paid: {formatTime(at())}</text>}
    </Show>
    <Show when={!props.link.active}>
      <text flexShrink={0} fg={error}>Inactive: it takes no new payments.</text>
    </Show>
  </>
)

export const ErrorPopup = (props: { readonly popup: Popup<unknown>; readonly pending: boolean }) => {
  // On a short terminal the spacing goes, so the popup ends inside the screen.
  const terminal = useTerminalDimensions()
  const spacing = () => (terminal().height < 16 ? 0 : 1)

  return (
    <box
      position="absolute"
      top="25%"
      left="10%"
      width="80%"
      zIndex={1}
      border
      borderColor={error}
      backgroundColor="#000000"
      paddingX={1}
      paddingY={spacing()}
      flexDirection="column"
      gap={spacing()}
      title=" Error "
    >
      <text fg={error}>{props.popup.message}</text>
      <Show when={!props.pending} fallback={<text>Trying again…</text>}>
        <box flexDirection="row" gap={3}>
          <Show when={props.popup.retry}>
            <text>[Enter] Retry</text>
          </Show>
          <Show when={props.popup.close}>
            <text>[{props.popup.retry === null ? "Enter/Esc" : "Esc"}] Close</text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

export const App = (props: {
  readonly state: Accessor<State>
  readonly actions: Actions
  /** The command a link's customers pay it with over SSH. */
  readonly payCommand: (shareToken: string) => string
}) => {
  // Kept here rather than in the form, which unmounts while /me reloads, so
  // what was typed survives a popup's refresh.
  const [draft, setDraft] = createSignal("")
  // A new link starts from an empty form; a popup leaves it as typed.
  const [form, setForm] = createSignal<Form>(emptyForm)
  const [focus, setFocus] = createSignal<Field>("title")

  const view = () => props.state().view
  const popup = () => props.state().popup

  const home = () => {
    const current = view()

    return View.$is("HasBusiness")(current) ? current : undefined
  }

  const business = () => home()?.business

  const creating = () => {
    const current = view()

    return View.$is("CreatingLink")(current) ? current.business : undefined
  }

  const created = () => {
    const current = view()

    return View.$is("LinkCreated")(current) ? current.link : undefined
  }

  const listing = () => {
    const current = view()

    return View.$is("Links")(current) ? current : undefined
  }

  const detail = () => {
    const current = view()

    return View.$is("LinkDetail")(current) ? current.link : undefined
  }

  const payments = () => {
    const current = view()

    return View.$is("Payments")(current) ? current : undefined
  }

  const paymentDetail = () => {
    const current = view()

    return View.$is("PaymentDetail")(current) ? current : undefined
  }

  const statement = () => {
    const current = view()

    return View.$is("Statement")(current) ? current : undefined
  }

  const payouts = () => {
    const current = view()

    return View.$is("Payouts")(current) ? current : undefined
  }

  const payoutSettings = () => {
    const current = view()

    return View.$is("PayoutSettings")(current) ? current : undefined
  }

  const requestingPayout = () => {
    const current = view()

    return View.$is("RequestingPayout")(current) ? current.list : undefined
  }

  const confirmingPayout = () => {
    const current = view()

    return View.$is("ConfirmingPayout")(current) ? current : undefined
  }

  const payoutDetail = () => {
    const current = view()

    return View.$is("PayoutDetail")(current) ? current.payout : undefined
  }

  const payoutScreen = () =>
    payouts() !== undefined || payoutSettings() !== undefined || requestingPayout() !== undefined ||
    confirmingPayout() !== undefined || payoutDetail() !== undefined

  const [payoutSelected, setPayoutSelected] = createSignal(0)
  const [payoutForm, setPayoutForm] = createSignal<PayoutForm>({ mode: "manual", bank: null, accountNumber: "" })
  const [payoutFocus, setPayoutFocus] = createSignal<PayoutField>("mode")

  // However the form opens, it starts from the saved settings at the first field.
  createEffect(on(() => payoutSettings() !== undefined, (showing, was) => {
    const shown = payoutSettings()

    if (showing && was !== true && shown !== undefined) {
      setPayoutForm(formOf(shown.settings, shown.banks))
      setPayoutFocus("mode")
    }
  }))
  const [payoutAmount, setPayoutAmount] = createSignal("")

  // The last row: the oldest payout, or "Load more" below it while pages remain.
  const lastPayoutRow = () => (payouts()?.page.payouts.length ?? 0) - (payouts()?.page.next === null ? 1 : 0)

  const payoutSelection = () => Math.max(0, Math.min(payoutSelected(), lastPayoutRow()))

  // Back from a payout, the list selects it wherever it sits; one not listed
  // leaves the selection be. From the amount form or a confirmation, the list
  // is read again with any new payout on top, so the selection starts there.
  createEffect(on(view, (shown, before) => {
    if (before !== undefined && View.$is("PayoutDetail")(before) && View.$is("Payouts")(shown)) {
      const at = shown.page.payouts.findIndex((payout) => payout.id === before.payout.id)

      if (at !== -1) {
        setPayoutSelected(at)
      }
    }

    if (before !== undefined && (View.$is("RequestingPayout")(before) || View.$is("ConfirmingPayout")(before)) &&
      View.$is("Payouts")(shown)) {
      setPayoutSelected(0)
    }
  }))

  const payoutFields: ReadonlyArray<PayoutField> = ["mode", "bank", "accountNumber"]

  const stepPayout = (by: number) => {
    const at = payoutFields.indexOf(payoutFocus())

    setPayoutFocus(payoutFields[(at + by + payoutFields.length) % payoutFields.length] ?? "mode")
  }

  const savePayoutSettings = () => props.actions.savePayoutSettings(payoutForm())

  const paymentTitle = () => {
    const origin = payments()?.origin

    return origin?._tag === "LinkDetail" ? origin.link.title : undefined
  }

  const paymentLinkAvailable = () => {
    const shown = paymentDetail()

    return shown?.list.origin._tag === "LinkDetail" &&
      shown.list.origin.overview.links.some((link) => link.id === shown.detail.payment.source.id)
  }

  const [section, setSection] = createSignal(0)
  const [paymentSelected, setPaymentSelected] = createSignal(0)

  const paymentSelection = () => Math.max(0, Math.min(paymentSelected(),
    (payments()?.page.payments.length ?? 0) - (payments()?.page.next === null ? 1 : 0)))

  // The row picked on a page; a page not picked on yet starts where it landed.
  const [statementPicked, setStatementPicked] = createSignal<{ readonly page: Statement; readonly index: number }>()

  const statementSelection = () => {
    const shown = statement()

    if (shown === undefined) {
      return 0
    }

    const picked = statementPicked()
    const last = shown.page.movements.length - 1
    const index = picked?.page === shown.page ? picked.index : shown.landing === "last" ? last : 0

    return Math.max(0, Math.min(index, last))
  }

  const linkScreen = () =>
    creating() !== undefined || created() !== undefined || listing() !== undefined || detail() !== undefined ||
    payments() !== undefined || paymentDetail() !== undefined || statement() !== undefined || payoutScreen()

  // The list's selection, kept while a link is open and reset when the list opens.
  const [selected, setSelected] = createSignal(0)
  // Shown for a few seconds, or until the next key or screen.
  const [copied, setCopied] = createSignal<Copied | null>(null)

  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  const showCopied = (next: Copied) => {
    clearTimeout(copiedTimer)
    setCopied(next)
    // A view timer, owned by this component and cleared with it; no fiber to run it in.
    // oxlint-disable-next-line effecttsgo/global-timers
    copiedTimer = setTimeout(() => setCopied(null), 4000)
  }

  createEffect(on(view, () => setCopied(null)))
  onCleanup(() => clearTimeout(copiedTimer))

  const renderer = useRenderer()

  const shownSelection = () => {
    const count = listing()?.overview.links.length ?? 0

    return Math.max(Math.min(selected(), count - 1), 0)
  }

  const submitLink = () => props.actions.createPaymentLink(form())

  const terminal = useTerminalDimensions()

  // Spacing gives way first, so a short terminal still shows a field whole.
  const short = () => terminal().height < 14

  const roomy = () =>
    terminal().width >= linkScreenMinimum.width && terminal().height >= linkScreenMinimum.height

  let scrollDetails = (_by: number) => {}

  // Moves focus through the fields the chosen mode shows, wrapping around.
  const step = (by: number) => {
    const fields = fieldsFor(form().mode)
    const at = fields.indexOf(focus())

    setFocus(fields[(at + by + fields.length) % fields.length] ?? "title")
  }

  const toggleMode = () => setForm(withMode(form(), form().mode === "fixed" ? "customer_chooses" : "fixed"))

  // The terminal is in raw mode, so Ctrl+C and Ctrl+D arrive as keys. An open
  // popup takes every other key; otherwise letters act only where no input has
  // focus. A key handled here is kept from the input it focuses or unfocuses.
  useKeyboard((key) => {
    if (key.ctrl && (key.name === "c" || key.name === "d")) {
      return props.actions.quit()
    }

    const open = popup()

    if (open !== null) {
      key.preventDefault()

      if (key.name === "return" || key.name === "enter") {
        return open.retry === null ? props.actions.close() : props.actions.retry()
      }

      if (key.name === "escape") {
        props.actions.close()
      }

      return
    }

    if (props.state().pending) {
      return
    }

    // Not from a form, where d is typed.
    if (key.name === "d" && creating() === undefined && payoutSettings() === undefined && requestingPayout() === undefined) {
      return props.actions.home()
    }

    const shownPayout = payoutDetail()

    if (shownPayout !== undefined) {
      if (key.name === "escape" || key.name === "return" || key.name === "enter") {
        props.actions.back()
      }

      // Any payout: even a settled one can turn out mismatched once the
      // ledger answers its capture or void.
      if (key.name === "r") {
        props.actions.openPayout(shownPayout.id)
      }

      return
    }

    if (confirmingPayout() !== undefined) {
      if (key.name === "escape") {
        props.actions.back()
      }

      if (key.name === "return" || key.name === "enter") {
        props.actions.confirmPayout()
      }

      return
    }

    if (requestingPayout() !== undefined) {
      if (key.name === "escape") {
        key.preventDefault()
        props.actions.back()
      }

      return
    }

    const settings = payoutSettings()

    if (settings !== undefined) {
      if (key.name === "escape") {
        key.preventDefault()

        return props.actions.back()
      }

      if (key.name === "tab") {
        key.preventDefault()

        return stepPayout(key.shift ? -1 : 1)
      }

      // The mode and bank rows are no inputs, so they take the keys an input would.
      const by = key.name === "left" ? -1 : key.name === "right" || key.name === "space" ? 1 : 0

      if (payoutFocus() === "mode" && by !== 0) {
        return setPayoutForm({ ...payoutForm(), mode: payoutForm().mode === "manual" ? "automatic" : "manual" })
      }

      if (payoutFocus() === "bank" && by !== 0 && settings.banks.length > 0) {
        const count = settings.banks.length
        const at = payoutForm().bank

        // From no choice, → takes the first bank and ← the last.
        return setPayoutForm({ ...payoutForm(), bank: at === null ? (by > 0 ? 0 : count - 1) : (at + by + count) % count })
      }

      if ((payoutFocus() === "mode" || payoutFocus() === "bank") && (key.name === "return" || key.name === "enter")) {
        return savePayoutSettings()
      }

      return
    }

    const payoutList = payouts()

    if (payoutList !== undefined) {
      if (key.name === "escape") {
        props.actions.back()
      }

      if (key.name === "up" || key.name === "down") {
        setPayoutSelected(Math.max(0, Math.min(payoutSelection() + (key.name === "up" ? -1 : 1), lastPayoutRow())))
      }

      if (key.name === "return" || key.name === "enter") {
        const payout = payoutList.page.payouts[payoutSelection()]

        if (payout === undefined) {
          props.actions.morePayouts()
        } else {
          props.actions.openPayout(payout.id)
        }
      }

      if (key.name === "r") {
        setPayoutSelected(0)
        props.actions.refreshPayouts()
      }

      if (key.name === "c") {
        props.actions.editPayoutSettings()
      }

      if (key.name === "n" && payoutList.settings.mode === "manual") {
        key.preventDefault()
        setPayoutAmount("")
        props.actions.startPayout()
      }

      return
    }

    const payment = paymentDetail()

    if (payment !== undefined) {
      if (key.name === "escape" || key.name === "return" || key.name === "enter") {
        props.actions.back()
      }

      if (key.name === "up" || key.name === "down") {
        scrollDetails(key.name === "up" ? -1 : 1)
      }

      if (key.name === "l" && paymentLinkAvailable()) {
        props.actions.openLink(payment.detail.payment.source.id)
      }

      return
    }

    const paymentList = payments()

    if (paymentList !== undefined) {
      if (key.name === "escape") {
        props.actions.back()
      }

      if (key.name === "up" || key.name === "down") {
        const last = paymentList.page.payments.length - (paymentList.page.next === null ? 1 : 0)
        setPaymentSelected(Math.max(0, Math.min(paymentSelection() + (key.name === "up" ? -1 : 1), last)))
      }

      if (key.name === "left" || key.name === "right") {
        const index = filters.indexOf(paymentList.filter.state)
        setPaymentSelected(0)
        props.actions.filterPayments(filters[(index + (key.name === "left" ? -1 : 1) + filters.length) % filters.length] ?? null)
      }

      if (key.name === "r") {
        setPaymentSelected(0)
        props.actions.refreshPayments()
      }

      if (key.name === "return" || key.name === "enter") {
        const payment = paymentList.page.payments[paymentSelection()]

        if (payment === undefined) {
          props.actions.morePayments()
        } else {
          props.actions.openPayment(payment.id)
        }
      }

      return
    }

    const shownStatement = statement()

    if (shownStatement !== undefined) {
      const { page } = shownStatement

      if (key.name === "escape") {
        props.actions.back()
      }

      if (key.name === "up" || key.name === "down") {
        const index = statementSelection() + (key.name === "up" ? -1 : 1)

        setStatementPicked({ page, index: Math.max(0, Math.min(index, page.movements.length - 1)) })
      }

      if (key.name === "left" || key.name === "right") {
        const index = periods.indexOf(shownStatement.period) + (key.name === "left" ? -1 : 1)

        props.actions.statementPeriod(periods[(index + periods.length) % periods.length] ?? shownStatement.period)
      }

      if (key.name === "n" && page.next !== null) {
        props.actions.statementPage("next")
      }

      if (key.name === "p" && page.previous !== null) {
        props.actions.statementPage("previous")
      }

      if (key.name === "r") {
        props.actions.refreshStatement()
      }

      return
    }

    if (creating() !== undefined) {
      if (key.name === "escape") {
        key.preventDefault()

        return props.actions.back()
      }

      if (key.name === "tab") {
        key.preventDefault()

        return step(key.shift ? -1 : 1)
      }

      // The pricing row is no input, so it takes the keys an input would.
      if (focus() === "mode") {
        if (key.name === "left" || key.name === "right" || key.name === "space") {
          return toggleMode()
        }

        if (key.name === "return" || key.name === "enter") {
          return submitLink()
        }
      }

      return
    }

    const shown = created() ?? detail()

    if (shown !== undefined) {
      setCopied(null)

      if (key.name === "p" && detail() !== undefined) {
        setPaymentSelected(0)

        return props.actions.linkPayments(shown.id)
      }

      if (key.name === "c") {
        return showCopied(renderer.copyToClipboardOSC52(props.payCommand(shown.share_token)) ? "sent" : "unsupported")
      }

      if (key.name === "escape" || key.name === "return" || key.name === "enter" || key.name === "b") {
        props.actions.back()
      }

      if (key.name === "up" || key.name === "down") {
        scrollDetails(key.name === "up" ? -1 : 1)
      }

      return
    }

    const list = listing()

    if (list !== undefined) {
      const links = list.overview.links

      if (key.name === "escape" || key.name === "b") {
        props.actions.back()
      }

      if (key.name === "up" || key.name === "down") {
        setSelected(Math.max(Math.min(shownSelection() + (key.name === "up" ? -1 : 1), links.length - 1), 0))
      }

      if (key.name === "return" || key.name === "enter") {
        const link = links[shownSelection()]

        if (link !== undefined) {
          props.actions.openLink(link.id)
        }
      }

      if (key.name === "r") {
        props.actions.refreshLinks()
      }

      if (key.name === "n") {
        key.preventDefault()
        setForm(emptyForm)
        setFocus("title")
        props.actions.startPaymentLink()
      }

      return
    }

    // o opens the account until it is open, then the payouts.
    if (key.name === "o" && business()?.status === "created") {
      return props.actions.openAccount()
    }

    if (business()?.ledger != null) {
      if (key.name === "up" || key.name === "down") {
        setSection(Math.max(0, Math.min(section() + (key.name === "up" ? -1 : 1), 3)))
      }

      if (key.name === "o" || ((key.name === "return" || key.name === "enter") && section() === 3)) {
        setPayoutSelected(0)
        props.actions.managePayouts()
      }

      if (key.name === "p" || ((key.name === "return" || key.name === "enter") && section() === 0)) {
        setPaymentSelected(0)
        props.actions.managePayments()
      }

      if (key.name === "l" || ((key.name === "return" || key.name === "enter") && section() === 1)) {
        setSelected(0)
        props.actions.manageLinks()
      }

      if (key.name === "s" || ((key.name === "return" || key.name === "enter") && section() === 2)) {
        props.actions.openStatement()
      }

      if (key.name === "r") {
        props.actions.refreshBalance()
      }
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
        <Match when={View.$is("Unknown")(view()) && props.state().pending}>
          <text fg={muted}>Loading…</text>
        </Match>
        <Match when={View.$is("NoBusiness")(view())}>
          <CreateBusiness
            draft={draft()}
            focused={popup() === null}
            pending={props.state().pending}
            onInput={setDraft}
            onSubmit={() => props.actions.createBusiness(draft())}
          />
        </Match>
        <Match when={home()}>
          {(shown) => (
            <ShowBusiness
              business={shown().business}
              balance={shown().balance}
              pending={props.state().pending}
              selected={section()}
              short={short()}
              cramped={terminal().height < 11}
              roomy={terminal().height >= 21}
              settlementDelay={props.state().settlementDelay}
            />
          )}
        </Match>
        <Match when={linkScreen() && !roomy()}>
          <text fg={muted}>
            Enlarge the terminal to {linkScreenMinimum.width}×{linkScreenMinimum.height}.
          </text>
        </Match>
        <Match when={creating()}>
          {(shown) => (
            <CreateLink
              business={shown()}
              form={form()}
              focus={focus()}
              active={popup() === null}
              pending={props.state().pending}
              onChange={setForm}
              onSubmit={submitLink}
            />
          )}
        </Match>
        <Match when={listing()}>
          {(shown) => (
            <LinkList
              business={shown().business}
              overview={shown().overview}
              selected={shownSelection()}
              pending={props.state().pending}
            />
          )}
        </Match>
        <Match when={payments()}>
          {(shown) => <PaymentList
            business={shown().business}
            page={shown().page}
            state={shown().filter.state}
            title={paymentTitle()}
            selected={paymentSelection()}
            pending={props.state().pending}
          />}
        </Match>
        <Match when={statement()}>
          {(shown) => (
            <StatementScreen view={shown()} selected={statementSelection()} pending={props.state().pending} />
          )}
        </Match>
        <Match when={payouts()}>
          {(shown) => <PayoutList view={shown()} selected={payoutSelection()} pending={props.state().pending} />}
        </Match>
        <Match when={payoutSettings()}>
          {(shown) => (
            <PayoutSettingsForm
              view={shown()}
              form={payoutForm()}
              focus={payoutFocus()}
              active={popup() === null}
              pending={props.state().pending}
              onChange={setPayoutForm}
              onSubmit={savePayoutSettings}
            />
          )}
        </Match>
        <Match when={requestingPayout()}>
          {(shown) => (
            <RequestPayoutForm
              view={shown()}
              amount={payoutAmount()}
              active={popup() === null}
              onInput={setPayoutAmount}
              onSubmit={() => props.actions.createPayout(payoutAmount())}
            />
          )}
        </Match>
        <Match when={confirmingPayout()}>
          {(shown) => <ConfirmPayout payout={shown().payout} pending={props.state().pending} />}
        </Match>
        <Match when={payoutDetail()}>
          {(shown) => <PayoutDetail payout={shown()} pending={props.state().pending} />}
        </Match>
        <Match when={paymentDetail()}>
          {(shown) => (
            <LinkScreen heading="Payment" copied={null}
              hint={paymentLinkAvailable() ? "[Esc] Back · ↑/↓ · l link" : "[Esc] Back · ↑/↓"}
              onScroll={(scroll) => (scrollDetails = scroll)}>
              <text flexShrink={0}>{formatMoney(BigInt(shown().detail.payment.amount), shown().detail.payment.scale, shown().detail.payment.currency_code)}</text>
              <Show when={shown().detail.payment.state === "attention"}
                fallback={<text flexShrink={0}>Status: {shown().detail.payment.state}</text>}>
                <text flexShrink={0} fg={error}>Status: attention</text>
              </Show>
              <text flexShrink={0}>Link: {shown().detail.payment.source.title}</text>
              <text flexShrink={0}>Created: {formatTime(shown().detail.payment.created_at)}</text>
              <text flexShrink={0}>{paymentTiming(shown().detail.payment)}</text>
              <For each={timelineLines(shown().detail)}>{(line) => <text flexShrink={0}>{line}</text>}</For>
              <text flexShrink={0} fg={muted}>Payment ID: {shown().detail.payment.id}</text>
            </LinkScreen>
          )}
        </Match>
        <Match when={created()}>
          {(link) => (
            <LinkScreen heading="Payment link created" copied={copied()} onScroll={(scroll) => (scrollDetails = scroll)}>
              <LinkDetails link={link()} payCommand={props.payCommand(link().share_token)} />
            </LinkScreen>
          )}
        </Match>
        <Match when={detail()}>
          {(link) => (
            <LinkScreen heading="Payment link" hint={terminal().width < 56 ? "Esc · c copy · p payments" : "[Esc] Back · ↑/↓ scroll · c copy · p payments"} copied={copied()} onScroll={(scroll) => (scrollDetails = scroll)}>
              <LinkDetails link={link()} payCommand={props.payCommand(link().share_token)}>
                <LinkStats link={link()} />
              </LinkDetails>
            </LinkScreen>
          )}
        </Match>
      </Switch>
      <text flexShrink={0} fg={muted}>Ctrl+C to quit</text>
      <Show when={popup()}>{(open) => <ErrorPopup popup={open()} pending={props.state().pending} />}</Show>
    </box>
  )
}
