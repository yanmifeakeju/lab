# Ledger schema

This document explains the intent and invariants of the ledger data model. The
SQL migrations in [`migrations/`](migrations/) are the executable source of
truth. This document records why the schema has its current shape and should be
updated whenever that design changes.

## Conventions

### Internal IDs and public references

Sequential integer IDs are used for primary keys and foreign keys because they
are compact and efficient for joins. They are private implementation details
and are not returned by the API.

Externally addressable resources receive stable, opaque, prefixed ULID
references:

| Resource | Example |
| --- | --- |
| Holder | `hld_01K33YVADP5Z8B0T3X2Q91C6RH` |
| Account | `acct_01K33YV8M82N9MXP4E7J6B1QWK` |
| Journal entry | `jrn_01K33YW0MDHJ9E4N7Z2QPV6R8K` |

The prefixes make references recognizable in logs and support tooling. The
values remain opaque to clients: callers must not extract timestamps or infer
authorization from them.

### Amounts

Money is stored as a positive `bigint` in a ledger's minor units. Floating
point values are never stored. The ledger's `scale` determines how to interpret
an amount:

```text
scale = 2
10000 = 100.00
150   =   1.50
```

Negative amounts are not used. A reversal swaps the debit and credit accounts
and records a new journal entry.

### Time

All timestamps include a time zone. `created_at` is assigned by the database.
`effective_at` represents business time and may differ from ingestion time.

## Relationships

```text
ledger
  ├── accounts
  │     └── journal lines (debit or credit side)
  └── journal entries
          ├── journal lines
          └── resolution entry ──> pending entry

holder
  └── payable accounts
```

An entry and every account referenced by its lines must belong to the same
ledger. Composite foreign keys enforce this in the database.

## Ledgers

A ledger defines an isolated accounting domain with one currency and scale.

| Column | Meaning and reason |
| --- | --- |
| `id` | Internal identity used by foreign keys. |
| `slug` | Stable, opaque identifier used to address the ledger. It is unique. |
| `currency` | Three-letter uppercase ISO 4217 currency code. All accounts and entries in the ledger use it. |
| `scale` | Number of fractional decimal places used to interpret integer amounts. It is restricted to `0` through `4`. |
| `description` | Optional human-readable explanation of the ledger. |
| `is_closed` | Prevents new accounting activity without deleting historical records. |
| `created_at` | Time the ledger was created. |

## Holders

A holder represents the external party that owns a payable account. A payment
gateway can store the holder's public reference as the ledger-side identity of
its merchant or customer.

| Column | Meaning and reason |
| --- | --- |
| `id` | Internal identity used by accounts. |
| `public_ref` | Ledger-generated stable reference returned to clients. |
| `external_id` | Caller-owned identity used to make holder creation idempotent. It is currently globally unique. |
| `name` | Human-readable holder name. Blank names are rejected. |
| `created_at` | Time the holder was created. |

## Accounts

Accounts hold materialized debit and credit totals. They belong to one ledger
and may optionally belong to a holder.

| Column | Meaning and reason |
| --- | --- |
| `id` | Internal identity used by journal lines. |
| `public_ref` | Ledger-generated stable account reference returned to clients. |
| `ledger_id` | Ledger that defines the account's currency, scale, and namespace. |
| `kind` | Account role: `payable` or `platform`. |
| `label` | Client-defined role identifying platform accounts. Present only for `platform`. |
| `holder_id` | Owner of a payable account. It is present only for `payable`. |
| `description` | Optional human-readable explanation. |
| `debits_pending` | Authorized debit movements not yet captured or released. |
| `credits_pending` | Authorized credit movements not yet captured or released. |
| `debits_posted` | Final debit movements. |
| `credits_posted` | Final credit movements. |
| `debits_must_not_exceed_credits` | Prevents debit exposure from exceeding posted credits. |
| `credits_must_not_exceed_debits` | Prevents credit exposure from exceeding posted debits. |
| `records_movements` | Fixed at creation. Immutable flag indicating whether account records running balance movements (always true for `payable`). |
| `closed_at` | Time the account was closed or scheduled to close. An account is closed once `closed_at <= clock_timestamp()`. Once reached, it cannot be modified. Past values are rounded up to `clock_timestamp()` to prevent backdating history. |
| `created_at` | Time the account was created. |

### Balance counters

The four counters distinguish side and settlement layer:

| | Pending | Posted |
| --- | ---: | ---: |
| Debit | `debits_pending` | `debits_posted` |
| Credit | `credits_pending` | `credits_posted` |

They are a transactionally maintained projection of journal history. They make
balance reads and funds checks constant-time: the ledger does not sum an
account's entire journal history for every request. Journal entries and lines
remain the audit source from which the counters can be reconciled.

For an account whose debits cannot exceed its credits, available debit capacity
is:

```text
credits_posted - debits_posted - debits_pending
```

Pending incoming credits are not spendable until captured. For an account whose
credits cannot exceed its debits, available credit capacity is:

```text
debits_posted - credits_posted - credits_pending
```

The two restriction flags are mutually exclusive. Counters cannot be negative,
and database constraints provide a final guard against invalid exposure.

## Journal entries

A journal entry describes one business operation and its lifecycle. It owns one
or more balanced transfer lines.

| Column | Meaning and reason |
| --- | --- |
| `id` | Internal identity referenced by journal lines and resolution entries. |
| `public_ref` | Ledger-generated stable reference used by callers for later capture or void requests. |
| `ledger_id` | Ledger containing the entry and all accounts touched by it. |
| `request_id` | Caller-provided idempotency identifier. It is unique within a ledger. |
| `fingerprint` | Digest of the meaningful request contents. It detects reuse of a request ID with different content. It is not a secret. |
| `kind` | Business classification: `payment`, `settlement`, or `transfer`. |
| `state` | Current business lifecycle state: `pending`, `posted`, `captured`, `voided`, or `expired`. |
| `description` | Optional human-readable explanation. It does not control accounting behavior. |
| `expires_at` | Deadline for resolving an authorization. Pending and terminal authorization entries retain it for audit. |
| `pending_entry_id` | Original pending authorization resolved by this entry. Only a posted resolution entry may set it. |
| `effective_at` | Business time of the operation or resolution. |
| `created_at` | Time the ledger stored the entry. |

### Idempotency

`request_id` answers whether the caller has already submitted an operation.
`public_ref` is the ledger's identity for the resulting entry:

```text
request_id   caller-generated; prevents duplicate processing
public_ref   ledger-generated; identifies the stored journal entry
```

A retry with the same ledger, request ID, and fingerprint returns the existing
entry. Reusing the request ID with a different fingerprint is an idempotency
conflict. The fingerprint must cover every meaningful input, including kind,
requested state, accounts, amounts, expiry, effective time, and description.

### Lifecycle

An entry may be posted immediately, or it may begin as a pending authorization:

```text
                         capture
                    ┌──────────────> captured
                    │
pending authorization ── void ─────> voided
                    │
                    └── timeout ───> expired

immediate operation ───────────────> posted
```

The pending entry changes to the terminal business state. Capture, void, and
expiry also create a new posted resolution entry whose `pending_entry_id`
references the authorization. A unique index permits only one resolution entry
for an authorization, including under concurrent requests.

The resolution entry preserves when and why the balance transition happened.
The authorization's original lines are never rewritten.

## Journal lines

A journal line is a balanced transfer between two different accounts. Since
each line contains both sides with the same amount, an entry cannot be
arithmetically unbalanced.

| Column | Meaning and reason |
| --- | --- |
| `id` | Internal sequential line identity. |
| `journal_entry_id` | Entry that owns the transfer. |
| `ledger_id` | Ledger shared by the entry and both accounts. It enables database-enforced cross-ledger protection. |
| `debit_account_id` | Account receiving the debit movement. |
| `credit_account_id` | Account receiving the credit movement. |
| `line_number` | One-based stable position within the entry. It preserves deterministic request order and diagnostics. |
| `amount` | Positive integer amount in the ledger's minor units. |
| `effect` | Immutable counter transition: `pending`, `posted`, `pending_posted`, or `pending_voided`. |

The debit and credit accounts must exist in the line's ledger and must be
different. Duplicate line numbers within an entry are rejected.

### Balance effects

| Effect | Debit account | Credit account |
| --- | --- | --- |
| `pending` | `debits_pending += amount` | `credits_pending += amount` |
| `posted` | `debits_posted += amount` | `credits_posted += amount` |
| `pending_posted` | `debits_pending -= amount`; `debits_posted += amount` | `credits_pending -= amount`; `credits_posted += amount` |
| `pending_voided` | `debits_pending -= amount` | `credits_pending -= amount` |

`state` and `effect` answer different questions:

```text
entry state   what happened to the business operation
line effect   what this immutable movement did to balance counters
```

After capture, for example, the original authorization has state `captured` but
its original lines still have effect `pending`. The linked resolution entry is
`posted`, and its copied lines have effect `pending_posted`.

## Posting and resolution invariants

Some invariants are structural and belong in table constraints and foreign
keys. Others require inspecting multiple rows and must be enforced by the
atomic PostgreSQL routines.

The schema enforces:

- valid public-reference formats;
- positive amounts and line numbers;
- different debit and credit accounts;
- valid kinds, states, and effects;
- one ledger for the entry and both accounts;
- one request ID per ledger;
- one resolution entry per pending authorization;
- required expiry for pending and terminal authorization states;
- non-negative account counters and account exposure limits.

The posting and resolution routines must enforce:

- at least one line;
- every supplied account resolves exactly once;
- all affected accounts are locked in a stable order;
- closed ledgers and accounts reject new activity;
- an idempotent retry has the same fingerprint;
- only a pending entry can be captured, voided, or expired;
- capture and release copy the authorization's lines exactly;
- the line effect matches the requested operation;
- balance-counter updates and journal writes commit or roll back together.

Posted journal lines are append-only audit records. Corrections are represented
by new reversing entries, never by editing historical amounts or accounts.

## Deferred decisions

The following decisions should be resolved when their requirements become
concrete:

- whether holder `external_id` and journal `request_id` need an explicit client
  namespace when multiple independent callers share a ledger;
- whether payable accounts must always reject negative balances, or whether
  chargebacks may create merchant debt; a bounded debit limit may eventually
  be more appropriate than the current boolean restriction;
- the canonical fingerprint algorithm and serialization format;
- retention, archival, and partitioning for high-volume journal history;
- whether additional entry kinds are needed beyond payment, settlement, and
  transfer.
