import { useKeyboard } from "@opentui/solid"
import { type Accessor, createSignal, Match, Show, Switch } from "solid-js"

import { type Business, type Popup, type State, View } from "./session.ts"

/** What the screens can ask of the connection; each returns at once. */
export interface Actions {
  readonly createBusiness: (name: string) => void
  readonly openLedger: () => void
  readonly retry: () => void
  readonly close: () => void
  readonly quit: () => void
}

const error = "#ff6b6b"

const muted = "#888888"

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
        <text fg={muted}>Press o to open your account.</text>
      </Match>
    </Switch>
  </box>
)

const ErrorPopup = (props: { readonly popup: Popup; readonly pending: boolean }) => (
  <box
    position="absolute"
    top="25%"
    left="10%"
    width="80%"
    zIndex={1}
    border
    borderColor={error}
    backgroundColor="#000000"
    padding={1}
    flexDirection="column"
    gap={1}
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

export const App = (props: { readonly state: Accessor<State>; readonly actions: Actions }) => {
  // Kept here rather than in the form, which unmounts while /me reloads, so
  // what was typed survives a popup's refresh.
  const [draft, setDraft] = createSignal("")

  const view = () => props.state().view
  const popup = () => props.state().popup

  const business = () => {
    const current = view()

    return View.$is("HasBusiness")(current) ? current.business : undefined
  }

  // The terminal is in raw mode, so Ctrl+C and Ctrl+D arrive as keys. An open
  // popup takes every other key; otherwise letters act only where no input has
  // focus.
  useKeyboard((key) => {
    if (key.ctrl && (key.name === "c" || key.name === "d")) {
      return props.actions.quit()
    }

    const open = popup()

    if (open !== null) {
      if (key.name === "return" || key.name === "enter") {
        return open.retry === null ? props.actions.close() : props.actions.retry()
      }

      if (key.name === "escape") {
        props.actions.close()
      }

      return
    }

    if (key.name === "o" && business() !== undefined) {
      props.actions.openLedger()
    }
  })

  return (
    <box border width="100%" height="100%" padding={1} flexDirection="column" gap={1} title=" pay-tty ">
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
      </Switch>
      <text fg={muted}>Ctrl+C to quit</text>
      <Show when={popup()}>{(open) => <ErrorPopup popup={open()} pending={props.state().pending} />}</Show>
    </box>
  )
}
