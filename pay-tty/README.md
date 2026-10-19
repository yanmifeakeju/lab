# pay-tty

pay-tty serves a fictional payment gateway over the terminal. The motivation is
purely educational. It started as a way to learn Effect by building something.
I was also trying to demo the idea of a ledger service to some colleagues.
Along the line, I needed a user interface, so I scratched an old itch of
serving apps over SSH. The result is this overengineered, and hopefully fun,
project.

No real money moves. Payments are simulated; you pick whether one succeeds.

## Try it

```sh
ssh paytty.akeju.me                 # set up a business and create a payment link
ssh <share_token>@paytty.akeju.me   # pay it as a customer
```
