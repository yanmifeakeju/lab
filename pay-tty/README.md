# pay-tty

pay-tty serves a fictional payment gateway over the terminal. The motivation is
purely educational and exploratory. It started as a way to learn Effect by
building something small enough to experiment with, but complex enough to get a
good feel for it.

Around the same time, I was reworking a ledger implementation and had come
across TigerBeetle. I liked a lot about its design and was curious to see what
an imitation—albeit a lesser one—would look like in PostgreSQL. The two
interests came together naturally: I could build a fictional payment API on top
of the ledger using Effect.

Along the way, I wanted a user interface to interact with the API, which gave
me an excuse to explore serving a TUI over SSH.

No real money moves. Payments and payouts are simulated.

## Try it

```sh
ssh paytty.akeju.me                 # set up a business and create a payment link
ssh <share_token>@paytty.akeju.me   # pay it as a customer
```

## Payouts locally

Payouts go to a simulated provider, `apps/sim`, with its own database. Create
and migrate it once with `pnpm --filter @pay-tty/sim db:setup` (it reads
`apps/sim/.env`); `pnpm dev` then runs it beside plane.
