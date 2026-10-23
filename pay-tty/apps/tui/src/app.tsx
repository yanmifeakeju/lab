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
  type Overview,
  pricingLines,
  statusLine,
  type Summary,
  totalsLine,
  withMode,
} from "./payment-link.ts"
import { filterLabel, filters, type Page, paymentRows, paymentTiming, type Status } from "./payments.ts"
import { formatMoney } from "./money.ts"
import { type Business, type Popup, type State, View } from "./session.ts"

/** What the screens can ask of the connection; each returns at once. */
export interface Actions {
  readonly createBusiness: (name: string) => void
  readonly openAccount: () => void
  readonly managePayments: () => void
  readonly linkPayments: (id: string) => void
  readonly refreshPayments: () => void
  readonly filterPayments: (status: Status | null) => void
  readonly morePayments: () => void
  readonly openPayment: (id: string) => void
  readonly manageLinks: () => void
  readonly refreshLinks: () => void
  readonly openLink: (id: string) => void
  readonly startPaymentLink: () => void
  readonly createPaymentLink: (form: Form) => void
  readonly back: () => void
  readonly retry: () => void
  readonly close: () => void
  readonly quit: () => void
}

export const error = "#ff6b6b"

export const muted = "#888888"

export const bright = "#ffffff"

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

const ShowBusiness = (props: { readonly business: Business; readonly pending: boolean; readonly selected: number; readonly short: boolean }) => (
  <box flexDirection="column" gap={props.short ? 0 : 1}>
    <text>{props.business.name}</text>
    <box flexDirection="column">
      <text fg={muted}>
        {countries[props.business.country_code]} · {props.business.currency_code}
      </text>
      <Show when={props.business.ledger} fallback={<text fg={muted}>No account yet</text>}>
        {(ledger) => (
          <text fg={muted}>
            Account {ledger().payable_account_ref} in {ledger().slug}
          </text>
        )}
      </Show>
    </box>
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
        </box>
      </Match>
    </Switch>
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
  readonly status: Status | null
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
        {rowWidth() < narrowRow ? "← " + filterLabel(props.status) + " →"
          : "← " + filters.map((status) => status === props.status ? "[" + filterLabel(status) + "]" : filterLabel(status)).join(" · ") + " →"}
      </text>
      <Show when={props.page.payments.length > 0} fallback={
        <text flexShrink={0} fg={muted}>
          {props.status === null ? "No payments yet." : "No " + props.status + " payments."}
        </text>
      }>
        <scrollbox ref={(box) => (rows = box)} flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
          <For each={props.page.payments}>{(payment, index) => (
            <text id={"payment-row-" + payment.id} flexShrink={0} fg={index() === props.selected ? bright : muted}>
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

  const business = () => {
    const current = view()

    return View.$is("HasBusiness")(current) ? current.business : undefined
  }

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

  const paymentTitle = () => {
    const origin = payments()?.origin

    return origin?._tag === "LinkDetail" ? origin.link.title : undefined
  }

  const paymentLinkAvailable = () => {
    const shown = paymentDetail()

    return shown?.list.origin._tag === "LinkDetail" &&
      shown.list.origin.overview.links.some((link) => link.id === shown.payment.source.id)
  }

  const [section, setSection] = createSignal(0)
  const [paymentSelected, setPaymentSelected] = createSignal(0)

  const paymentSelection = () => Math.max(0, Math.min(paymentSelected(),
    (payments()?.page.payments.length ?? 0) - (payments()?.page.next === null ? 1 : 0)))

  const linkScreen = () =>
    creating() !== undefined || created() !== undefined || listing() !== undefined || detail() !== undefined || payments() !== undefined || paymentDetail() !== undefined

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

    const payment = paymentDetail()

    if (payment !== undefined) {
      if (key.name === "escape" || key.name === "return" || key.name === "enter") {
        props.actions.back()
      }

      if (key.name === "up" || key.name === "down") {
        scrollDetails(key.name === "up" ? -1 : 1)
      }

      if (key.name === "l" && paymentLinkAvailable()) {
        props.actions.openLink(payment.payment.source.id)
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
        const index = filters.indexOf(paymentList.filter.status)
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

    if (key.name === "o" && business() !== undefined) {
      props.actions.openAccount()
    }

    if (business()?.ledger != null) {
      if (key.name === "up" || key.name === "down") {
        setSection(key.name === "up" ? 0 : 1)
      }

      if (key.name === "p" || ((key.name === "return" || key.name === "enter") && section() === 0)) {
        setPaymentSelected(0)
        props.actions.managePayments()
      }

      if (key.name === "l" || ((key.name === "return" || key.name === "enter") && section() === 1)) {
        setSelected(0)
        props.actions.manageLinks()
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
        <Match when={business()}>
          {(shown) => <ShowBusiness business={shown()} pending={props.state().pending} selected={section()} short={short()} />}
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
            status={shown().filter.status}
            title={paymentTitle()}
            selected={paymentSelection()}
            pending={props.state().pending}
          />}
        </Match>
        <Match when={paymentDetail()}>
          {(shown) => (
            <LinkScreen heading="Payment" copied={null}
              hint={paymentLinkAvailable() ? "[Esc] Back · ↑/↓ · l link" : "[Esc] Back · ↑/↓"}
              onScroll={(scroll) => (scrollDetails = scroll)}>
              <text flexShrink={0}>{formatMoney(BigInt(shown().payment.amount_minor), shown().payment.scale, shown().payment.currency_code)}</text>
              <text flexShrink={0}>Status: {shown().payment.status}</text>
              <text flexShrink={0}>Link: {shown().payment.source.title}</text>
              <text flexShrink={0}>Created: {formatTime(shown().payment.created_at)}</text>
              <text flexShrink={0}>{paymentTiming(shown().payment)}</text>
              <text flexShrink={0} fg={muted}>Payment ID: {shown().payment.id}</text>
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
