import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"

import { emptyForm, type Form, type Link, type Mode, pricingLines, withMode } from "./payment-link.ts"
import { type Business, type Popup, type State, View } from "./session.ts"

/** What the screens can ask of the connection; each returns at once. */
export interface Actions {
  readonly createBusiness: (name: string) => void
  readonly openAccount: () => void
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

const ShowBusiness = (props: { readonly business: Business; readonly pending: boolean }) => (
  <box flexDirection="column" gap={1}>
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
        <text>Opening your account…</text>
      </Match>
      <Match when={props.business.status === "created"}>
        <text fg={muted}>Press o to open your account. Payment links need it.</text>
      </Match>
      <Match when={props.business.ledger !== null}>
        <text fg={muted}>Collect payment: press p to create a payment link.</text>
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

  // Keeps the focused field and its label in view. Positions are only known
  // once a frame is laid out, so the scroll happens after one, then redraws.
  const renderer = useRenderer()
  let revealing = true

  const reveal = () => {
    if (revealing && fields !== undefined) {
      revealing = false
      fields.scrollChildIntoView(fieldId(props.focus))
      renderer.requestRender()
    }
  }

  renderer.addPostProcessFn(reveal)
  onCleanup(() => renderer.removePostProcessFn(reveal))

  createEffect(on([() => props.focus, () => props.form.mode, () => terminal().width, () => terminal().height], () => {
    revealing = true
    renderer.requestRender()
  }))

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

// The merchant's text wraps inside the scrolled area; Back stays below it.
const LinkCreated = (props: {
  readonly link: Link
  readonly payCommand: string
  readonly onScroll: (scroll: (by: number) => void) => void
}) => {
  let details: ScrollBoxRenderable | undefined

  props.onScroll((by) => details?.scrollBy(by))

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <text flexShrink={0}>Payment link created</text>
      <scrollbox ref={(box) => (details = box)} flexGrow={1} flexShrink={1} scrollY contentOptions={gutter}>
        <text flexShrink={0}>{props.link.title}</text>
        <Show when={props.link.description}>
          {(description) => <text flexShrink={0} fg={muted}>{description()}</text>}
        </Show>
        <For each={pricingLines(props.link)}>{(line) => <text flexShrink={0}>{line}</text>}</For>
        <text flexShrink={0} fg={muted}>Reference: {props.link.id}</text>
        <text flexShrink={0} fg={muted}>Customers pay with:</text>
        <text flexShrink={0}>{props.payCommand}</text>
      </scrollbox>
      <text flexShrink={0} fg={muted}>[Esc] Back · ↑/↓ scroll</text>
    </box>
  )
}

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

  const submitLink = () => props.actions.createPaymentLink(form())

  const terminal = useTerminalDimensions()

  // Spacing gives way first, so a short terminal still shows a field whole.
  const short = () => terminal().height < 14

  const roomy = () =>
    terminal().width >= linkScreenMinimum.width && terminal().height >= linkScreenMinimum.height

  let scrollResult = (_by: number) => {}

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

    if (created() !== undefined) {
      if (key.name === "escape" || key.name === "return" || key.name === "enter" || key.name === "b") {
        props.actions.back()
      }

      if (key.name === "up" || key.name === "down") {
        scrollResult(key.name === "up" ? -1 : 1)
      }

      return
    }

    if (key.name === "o" && business() !== undefined) {
      props.actions.openAccount()
    }

    if (key.name === "p" && business()?.ledger != null) {
      key.preventDefault()
      setForm(emptyForm)
      setFocus("title")
      props.actions.startPaymentLink()
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
          {(shown) => <ShowBusiness business={shown()} pending={props.state().pending} />}
        </Match>
        <Match when={(creating() !== undefined || created() !== undefined) && !roomy()}>
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
        <Match when={created()}>
          {(link) => (
            <LinkCreated
              link={link()}
              payCommand={props.payCommand(link().share_token)}
              onScroll={(scroll) => (scrollResult = scroll)}
            />
          )}
        </Match>
      </Switch>
      <text flexShrink={0} fg={muted}>Ctrl+C to quit</text>
      <Show when={popup()}>{(open) => <ErrorPopup popup={open()} pending={props.state().pending} />}</Show>
    </box>
  )
}
