# Technical Records Browser

A catalog for an application's schema, for when the ERD has grown past what anyone can
read.

The diagram is the symptom. The problem is that there is no queryable, authoritative
place that says what records exist, what fields they carry, what type each field is,
where each value comes from, and how records relate. This is that place.

Platform-agnostic on purpose: a **record** is whatever the source system calls an
entity, table, or object; a **field** is whatever it calls a column or attribute. No
vendor vocabulary is baked in.

## What it does

**Three identities per object.** Every record and field carries a technical name, a
human label, and the source system's opaque ID. One toggle switches what the whole app
displays; search always hits all three. The gaps become visible the moment you switch
to a mode something is missing.

**Provenance.** Each field's value comes from exactly one place:

| Source kind | Meaning | Shape |
|---|---|---|
| `user_entry` | A person types it | No upstream |
| `reference` | Copied from one field on another record | Exactly one upstream |
| `derived` | Computed | An expression plus its dependencies |

Trace any field upstream to its origins and downstream to everything that would break
if you changed it — across as many hops as it takes.

**Native vs. custom** on records and fields — the split that decides what is safe to
touch.

**Reports** for the questions a diagram cannot answer: circular dependencies, reference
fields whose type disagrees with their source, orphan records, fields nothing reads,
duplicated or missing identifiers.

**ERD** with real layered layout, module grouping, and collapse — because the answer to
a 400-node diagram is not a bigger screen.

## Running it

```bash
pnpm install
cp .env.example .env        # then set NUXT_SESSION_PASSWORD (32+ chars)
pnpm db:migrate
pnpm db:seed                # type catalog, an admin, and a demo schema
pnpm dev
```

Sign in with `admin@example.com` / `change-me-please` and change it.

`pnpm db:seed --no-demo` seeds only the type catalog and the admin account. Add people
with `pnpm user:create <email> <name> <password> [admin|editor|viewer]`.

The demo schema is deliberately imperfect — it contains a circular dependency, a type
mismatch, an orphan record, and unused fields — so every report has a positive case on
a fresh install. That is the only way to tell a working report from one that silently
finds nothing.

### Commands

| | |
|---|---|
| `pnpm dev` | Run it |
| `pnpm test` | Unit tests (lineage traversal, search escaping) |
| `pnpm db:generate` | Generate a migration after changing the schema |
| `pnpm db:migrate` / `db:seed` / `db:reset` | Database lifecycle |
| `pnpm user:create` | Add an account |

## Import and export

The catalog round-trips through one JSON format, used by both directions. References
are written as `Record.field` rather than internal IDs, so an export is portable
between installs and readable in review.

The real payoff is that it is **diffable in git**: commit one per release and
`git diff` shows exactly what changed in the source application's schema. Round-trip
fidelity is exact — export, import into an empty database, export again, and the two
files are identical.

Imports are all-or-nothing. The preview runs the real import inside a transaction and
then rolls it back, so what you see reflects actual constraint behaviour rather than a
simulation that can drift from it.

## Design notes

**One edge table for provenance.** `reference` and `derived` have different shapes but
the same graph, so they share `field_dependencies`. Splitting them would double every
traversal and report for no analytical gain. The invariant spanning `fields` and that
table has exactly one writer — `server/services/fieldSource.ts` — because two writers
would drift. A CHECK constraint backs it up for anything that bypasses the service.

**Lineage is in-memory BFS, not a recursive CTE.** The edge set is small, and rendering
lineage needs the *path* to each node. Carrying a path through a recursive CTE means
string concatenation, and substring cycle checks then misfire on any ID containing the
delimiter — a bug that presents as "lineage randomly claims there's a cycle". A JS
array sidesteps the class entirely, and the traversal stays a pure function with unit
tests and no database.

**Cycles are surfaced, not swallowed.** Loops are real (`Total` → `Credit_Limit` →
`Discount_Rate` → `Total`). Traversal marks the closing edge, stops expanding, and
reports the loop. Interactive writes refuse to create one; imports record them and let
the report flag them, because a document is imported whole or not at all. A separate
Tarjan pass finds loops no single starting point would reveal.

**Truncation is explicit.** A trace stopped by the depth or node cap says so. A
silently clipped graph reads as "that's everything", which is worse than no answer.

**Deletes fail loudly.** `field_dependencies.source_field_id` is `restrict`, so
removing a field that feeds others is blocked — with the list of dependents, not an
opaque constraint error. Deleting a record uses `PRAGMA defer_foreign_keys` so
self-contained dependencies resolve naturally while genuine external dependents still
block.

**Search is literal.** SQL `LIKE` gives `_` and `%` wildcard meaning, and technical
names are mostly underscores — `Sales_Order` would otherwise match `SalesXOrder`. Terms
are escaped, with an explicit `ESCAPE` clause.

**GSAP owns the ERD's transforms; Vue never binds them.** Layout coordinates live in a
non-reactive map. If Vue also wrote transforms, a re-render mid-tween would fight the
tween. elkjs computes positions in a worker, SVG draws, GSAP Flip animates between
layouts.

## One deliberate departure

The three source kinds do not cover fields written by an **integration or batch job**.
Coding those as `user_entry` would make lineage report a human origin that does not
exist, hiding a whole upstream system from anyone reading a trace.

Rather than add a fourth kind, `user_entry` fields carry an `isExternallyPopulated`
flag and a note naming the process. They render as a distinct "External" badge, are
excluded from origin marking in lineage, and have their own report. If you would rather
these were a first-class source kind, that is a schema change worth making explicitly.

## Layout

```
app/            pages, components, composables   (Nuxt 4 client)
  components/erd/   the SVG canvas
server/
  api/          route handlers
  db/           Drizzle schema + migrations
  services/     lineage, provenance, reports, deletion, interchange
  lib/          password hashing, literal search   (not auto-imported — see below)
shared/         constants and zod schemas used by BOTH client and server
scripts/        migrate, seed, create-user, constraint smoke test
```

`server/lib/password.ts` sits outside `server/utils/` deliberately: Nitro auto-imports
`server/utils/`, which would collide with nuxt-auth-utils' own `hashPassword`. Whichever
won that race would decide the hash format, and a flip would invalidate every stored
password.

## Not built yet

CSV and XLSX import (JSON import/export works today), an editing UI for records and
fields (the API supports full CRUD; the UI is read-only), and saved views.

On spreadsheets: the npm `xlsx` package is frozen at 0.18.5 with two unpatched
high-severity advisories, since SheetJS moved distribution off npm. When that lands it
should use `exceljs` plus `papaparse` rather than the stale registry package.
