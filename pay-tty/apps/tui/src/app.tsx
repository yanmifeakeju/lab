import { useKeyboard } from "@opentui/solid"
import { type Accessor, createSignal, Match, Show, Switch } from "solid-js"

import { type Business, State } from "./session.ts"

/** What the screens can ask of the connection; each returns at once. */
export interface Actions {
  readonly retry: () => void
  readonly createBusiness: (name: string) => void
  readonly openLedger: () => void
  readonly quit: () => void
}

const error = "#ff6b6b"

const muted = "#888888"

const countries = { NG: "Nigeria", US: "United States" } as const

const LoadFailed = (props: { readonly message: string }) => (
  <box flexDirection="column" gap={1}>
    <text fg={error}>{props.message}</text>
    <text fg={muted}>Press r to retry.</text>
  </box>
)

const CreateBusiness = (props: {
  readonly pending: boolean
  readonly error: string | null
  readonly onSubmit: (name: string) => void
}) => {
  const [name, setName] = createSignal("")

  return (
    <box flexDirection="column" gap={1}>
      <text>Create your business</text>
      <box flexDirection="column">
        <text fg={muted}>Business name</text>
        <input
          focused
          maxLength={255}
          placeholder="Acme Ltd"
          onInput={setName}
          onSubmit={() => props.onSubmit(name())}
        />
      </box>
      {/* Nigeria is the only country with a ledger so far. */}
      <text fg={muted}>Country: Nigeria</text>
      <Switch fallback={<text fg={muted}>Press Enter to create it.</text>}>
        <Match when={props.pending}>
          <text>Creating your business…</text>
        </Match>
        <Match when={props.error}>{(message) => <text fg={error}>{message()}</text>}</Match>
      </Switch>
    </box>
  )
}

const ShowBusiness = (props: {
  readonly business: Business
  readonly pending: boolean
  readonly error: string | null
}) => (
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
      <Match when={props.error}>
        {(message) => (
          <box flexDirection="column">
            <text fg={error}>{message()}</text>
            <text fg={muted}>Press o to try again.</text>
          </box>
        )}
      </Match>
      <Match when={props.business.status === "created"}>
        <text fg={muted}>Press o to open your account.</text>
      </Match>
    </Switch>
  </box>
)

export const App = (props: { readonly state: Accessor<State>; readonly actions: Actions }) => {
  // Narrowed views of the state; a Match stays mounted while its value
  // changes, so the form keeps what was typed through a failed submit.
  const noBusiness = () => {
    const state = props.state()

    return State.$is("NoBusiness")(state) ? state : undefined
  }

  const hasBusiness = () => {
    const state = props.state()

    return State.$is("HasBusiness")(state) ? state : undefined
  }

  const failed = () => {
    const state = props.state()

    return State.$is("LoadFailed")(state) ? state : undefined
  }

  // The terminal is in raw mode, so Ctrl+C and Ctrl+D arrive as keys. The
  // letter keys only act where no input has focus.
  useKeyboard((key) => {
    if (key.ctrl && (key.name === "c" || key.name === "d")) {
      return props.actions.quit()
    }

    if (key.name === "r" && failed() !== undefined) {
      return props.actions.retry()
    }

    if (key.name === "o" && hasBusiness() !== undefined) {
      props.actions.openLedger()
    }
  })

  return (
    <box border width="100%" height="100%" padding={1} flexDirection="column" gap={1} title=" pay-tty ">
      <Switch>
        <Match when={State.$is("Loading")(props.state())}>
          <text fg={muted}>Loading…</text>
        </Match>
        <Match when={failed()}>{(state) => <LoadFailed message={state().message} />}</Match>
        <Match when={noBusiness()}>
          {(state) => (
            <CreateBusiness
              pending={state().pending}
              error={state().error}
              onSubmit={props.actions.createBusiness}
            />
          )}
        </Match>
        <Match when={hasBusiness()}>
          {(state) => <ShowBusiness business={state().business} pending={state().pending} error={state().error} />}
        </Match>
      </Switch>
      <text fg={muted}>Ctrl+C to quit</text>
    </box>
  )
}
