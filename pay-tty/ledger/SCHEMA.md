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
  ├── journal entries
  │       └── journal lines
  └── authorizations
          ├── entry ──────────> pending journal entry
          └── resolution ─────> resolving journal entry

holder
  └── payable accounts
```

An entry, every account referenced by its lines, and an authorization with both
of its entries must belong to the same ledger. Composite foreign keys enforce
this in the database.

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
| `debits_must_not_exceed_credits` | Prevents debit exposure from exceeding posted credits. Fixed at creation (immutable). |
| `credits_must_not_exceed_debits` | Prevents credit exposure from exceeding posted debits. Fixed at creation (immutable). |
| `movement_count` | Number of balance movements recorded for this account. Incremented atomically under the account lock. |
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

### Balance tracking and untracked accounts

An account tracks a balance only when the ledger reads its counters during a posting:
```text
debits_must_not_exceed_credits OR credits_must_not_exceed_debits OR records_movements
```

- Payable accounts always record movements, so they always track a balance.
- Platform accounts track a balance only when created with a limit flag or with `records_movements = true`.
- The limit flags (`debits_must_not_exceed_credits`, `credits_must_not_exceed_debits`) are fixed at creation and immutable, enforced by trigger.

Accounts that do not track a balance keep their counters (`debits_pending`, `credits_pending`, `debits_posted`, `credits_posted`, and `movement_count`) at zero, enforced by the `accounts_untracked_counters_zero` CHECK constraint. These counters are always zero and are not the account's balance.

The ledger does not lock untracked accounts `FOR UPDATE` or serve their balances; platform balances come from a column store fed from `journal_lines` by change data capture (`journal_lines` is append-only, making it a clean source). Postings touching untracked accounts therefore run in parallel without queueing on platform account rows.

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
| `kind` | Client-defined business classification string (e.g. `payment`, `settlement`, `fee`). |
| `description` | Required human-readable explanation naming the business event. |
| `effective_at` | Business time of the operation or resolution. |
| `created_at` | Time the ledger stored the entry. |

Journal entries record what was posted and are never updated once their
routine commits; a trigger refuses updates to entries and lines. A pending entry's lifecycle lives in its authorization. An
entry with no authorization is posted.

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
accounts, amounts, effective time, description, and whether the entry is
pending. The pending key is hashed only for pending entries, so an immediate
entry hashes as it did before pending entries existed.

A resolution has its own fingerprint over the pending reference, action, and
effective time, marked with a different operation, so a post and a resolution
never look alike. Request ids share one keyspace per ledger across every entry
endpoint.

### Lifecycle

An entry may be posted immediately, or it may begin pending and open an
authorization:

```text
                     capture
                ┌──────────────> captured
                │
pending entry ──┴── void ─────> voided

immediate operation ───────────> posted
```

Capture and void each write a posted resolution entry that copies the
pending entry's lines, kind, and description, and close the authorization. The
pending entry's own lines are never rewritten. The resolution preserves when
and why the balance transition happened.

## Authorizations

An authorization is the state machine of one pending entry. It is the only row
in the journal that changes, and it changes once.

| Column | Meaning and reason |
| --- | --- |
| `id` | Internal identity; the lock that serialises resolutions. |
| `ledger_id` | Ledger shared by the authorization and both of its entries. |
| `entry_id` | The pending journal entry. Unique. |
| `state` | `pending`, `captured`, or `voided`. |
| `resolution_entry_id` | The entry that resolved it. Unique; null while pending. |
| `resolved_at` | When it was resolved; null while pending. |

Keeping the lifecycle apart from the journal leaves journal entries
append-only, gives exactly one place to enforce one resolution per pending
entry. A CHECK pairs `state = 'pending'` with a
null resolution, so the state and the resolution cannot disagree.

There is no ledger expiry: a pending entry stays pending until the caller
captures or voids it. Auto-voiding a hold whose money did leave would let the
holder spend it twice, so a lost hold stays held until a person resolves it.

**Partial capture** is not supported. It would move resolutions to a child
table of (authorization, entry, action, amount) and keep captured and released
totals on the authorization, checked against its amount. Which lines a partial
capture takes from a multi-line entry is left to that change.

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
| `purpose` | Required client-defined classification describing this line's specific role in the entry. |
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

After capture, for example, the authorization has state `captured` but the
pending entry's lines still have effect `pending`. The resolution entry's
copied lines have effect `pending_posted`.

A pending credit is not spendable: the limit checks count it with the pending
counters, never as posted.

## Account movements

An account movement records one recorded-account side of a posted journal line,
its per-account sequence, and the posted balance after it, at posting time.

| Column | Meaning and reason |
| --- | --- |
| `account_id` | Account affected by the movement. |
| `sequence` | Monotonically increasing per-account ordinal starting at 1. Unique and gapless within an account. |
| `journal_entry_id` | Entry that produced the movement. |
| `line_number` | Line within the entry that produced the movement. |
| `direction` | Side of the movement: `debit` or `credit`. |
| `amount` | Positive integer amount in the ledger's minor units. |
| `purpose` | Copied from the immutable journal line. |
| `balance_after` | Posted balance of the account immediately following this movement. |
| `recorded_at` | Commit-ordered timestamp assigned under the account lock, monotonically non-decreasing within the account. |

Statements are served directly from `account_movements` rather than scanning
`journal_lines`.

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
- one authorization per pending entry and one resolution per authorization;
- a resolution exactly when the authorization is not pending;
- non-negative account counters and account exposure limits;
- untracked accounts maintain zero counters;
- immutable balance limit flags and records_movements.

The posting and resolution routines enforce:

- at least one line;
- every supplied account resolves exactly once;
- all affected balance-tracking accounts are locked in a stable order;
- closed ledgers and accounts reject new activity;
- an idempotent retry has the same fingerprint;
- only a pending authorization is captured or voided, decided under
  its row lock;
- a resolution copies the pending entry's lines exactly;
- the line effect matches the requested operation;
- balance-counter updates and journal writes commit or roll back together.

Posted journal lines are append-only audit records. Corrections are represented
by new reversing entries, never by editing historical amounts or accounts.

## Posting routines

Two routines post entries, immediate or pending, and two resolve them. Each
pair is a single and a batch implementation, separate on purpose:
`post_entry` raises on the first problem it finds, while `post_entries` has to
record an outcome for every entry in a batch, and giving each entry its own
`BEGIN ... EXCEPTION` block would open a subtransaction per entry — past 64 of
those in one transaction, Postgres slows every backend, not only the one
running the batch. Routing single postings through the batch routine was
measured at roughly a quarter of the throughput, so they stay apart.

What they must agree on is factored out rather than duplicated:

- `journal_fingerprint()` identifies a request by its content. Both routines
  must hash identically, or an entry posted through one would look new to the
  other.
- `account_limit_exceeded()` is the overdraft arithmetic. The same expressions
  appear in the `accounts` CHECK constraints, which cannot call a function;
  those constraints are the enforcement, this is the pre-check that turns a
  violation into a domain error instead of a constraint failure.
- `journal_entry_totals()` aggregates one entry's lines by account.
- `accounts.tracks_balance` is a stored generated column: an account has a
  limit to enforce or a movement history to keep. Only these accounts are
  locked and have their counters updated.

### Lock order

Every routine uses the same global lock order: ledger, idempotency keys,
authorizations, then every account it touches that tracks a balance. Only the
resolution routines lock authorizations, in id order. A request key is claimed by
inserting its `journal_entries` row; a batch inserts claims in request-id order.
Accounts use `FOR UPDATE` in id order.

Before the lines because the line foreign keys take KEY SHARE locks on the
accounts they reference, so locking afterwards would let two concurrent
entries each hold KEY SHARE while waiting for the other's `FOR UPDATE`.

Everything read to decide an entry's fate is read after that lock, too:
whether an account is closed, and what its counters say. A check made before
the lock can be overtaken by a transaction that was in flight at the time and
commits while the posting waits.

Request claims come before account locks because an idempotency conflict can
name different accounts, so account locks cannot protect the request-id
namespace. Keeping the phases in this order also prevents a single post from
holding an uncommitted id while waiting for an account a batch holds and that
batch waits for the same id — a cycle Postgres would break with `40P01`.

The batch creates provisional entry rows before checking individual accounts
and limits. It deletes the rows for rejected items before inserting any lines,
so a rejected request still leaves no journal entry and its idempotency key can
be reused. Accepted claims become the posted entries.

### `post_entry`

Posts one entry, or returns the existing one when the idempotency key
identifies an identical request. A replay is answered before any account lock
is taken, and reports the entry's current state. A pending entry moves only the
pending counters, writes no movements, and inserts its authorization.

### `post_entries`

Posts 10 to 1,000 entries, capped at 5,000 lines in total, in one transaction
under one commit flush. The lower bound is not arbitrary: setting up a batch
costs about what ten single postings cost, so a smaller batch would be slower
than sending the same entries to `post_entry` one at a time. Callers with
fewer than ten entries to flush belong on that routine, and the API says so.

- **Outcomes.** One result per entry, in request order: `created`, `existing`,
  or `rejected` with one of `account_not_found`, `account_closed`,
  `insufficient_funds` or `idempotency_conflict`. Every check is a query or
  plain arithmetic, so a rejected entry never needs rolling back.
- **Limits.** Running balances for limited accounts are held in memory and
  advanced in batch order, so only the entry that would breach a limit is
  rejected; later entries are checked against the balance without it. Request
  ids are claimed and classified before this simulation, so an entry that will
  resolve as existing or conflicting is never included in the running balance.
- **Movements.** Accounts that record them get gapless sequences and running
  balances across the whole batch. An account's movements in one batch share a
  single `recorded_at`, taken as `greatest(clock_timestamp(), previous
  recorded_at)`; `sequence` orders them.
- **Counters** are updated once per tracked account with the batch's totals.
- **Whole-batch failure**, rolling back everything: a malformed payload, an
  entry with no lines, a duplicate request id within the batch, a batch outside
  the size or line caps, an unknown ledger, or a closed ledger unless every
  entry in the batch is an idempotent replay.

Pending entries post in a batch exactly as through `post_entry`. A batch may
mix pending and immediate entries; the running balances move pending counters
for pending ones, so holds are checked against funds in batch order.

The 1,000 cap is about the lock, not throughput. A batch holds each tracked
account's lock until it commits, so a larger batch mostly makes that account's
other postings wait longer, for little gain per item.

### `resolve_entry`

Captures or voids one pending entry. The pending entry is read without a lock,
since entries are immutable, then the request id is claimed and the
authorization locked before anything that decides the outcome is read. It
refuses an unknown entry, an immediate one, one already resolved (naming the
winner). Resolutions check neither
account closure nor limits: a capture keeps each account's exposure the same
and a void lowers it, and refusing either on a closed account would strand the
amount in its pending counters.

### `resolve_entries`

Resolves 10 to 1,000 entries, capped at 5,000 copied lines, with one outcome per
item, as `post_entries` does for posts. Claims are taken in request-id order,
authorizations locked in id order, and captures write gapless movements in item
order under one `recorded_at` per account. A batch may not name one pending
entry twice. It shares `resolve_entry`'s fingerprint, so either endpoint
replays the other.

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
