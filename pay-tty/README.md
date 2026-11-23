# pay-tty

pay-tty is a simulated payment processor in the terminal. The motivation is
purely educational and exploratory. It started as a way to learn
[Effect](https://effect.website) by building something small enough to
experiment with, but complex enough to get a good feel for it.

Around the same time, I was reworking a ledger implementation and had come
across [TigerBeetle](https://tigerbeetle.com). I liked a lot about its design
and was curious to see what an imitation—albeit a lesser one—would look like in
PostgreSQL. The two interests came together naturally: I could build a payment
API on top of the ledger using Effect.

Along the way, I wanted a user interface to interact with the API, which gave
me an excuse to explore serving a TUI over SSH.

No real money moves; payments and payouts are simulated.

## Structure

- [Ledger](ledger/) — Handles pure double-entry accounting primitives in Go and
  PostgreSQL.
- [Plane](apps/plane/) (and [core](packages/core/)) — The payment API and
  domain logic (businesses, payment links, payments, and payouts), built with
  Effect and PostgreSQL.
- [Sim](apps/sim/) — Simulates an external bank payout provider that processes
  transfers and delivers webhook callbacks to Plane.
- [TUI](apps/tui/) — Serves the merchant and customer terminal interface over
  SSH using [OpenTUI](https://github.com/sst/opentui) and
  [Solid](https://www.solidjs.com).

## Try it

```sh
ssh paytty.akeju.me                 # set up a business and create a payment link
ssh <share_token>@paytty.akeju.me   # pay it as a customer
```
