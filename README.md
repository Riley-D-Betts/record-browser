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

**Editing**, gated on role. Records, fields, provenance and relationships are all
editable in the UI; viewers get the same views without the controls. A delete that
would break something else refuses and names what depends on it.

**Settings**, where the dropdowns themselves are editable. Field types, modules,
derivation languages, delete behaviours and type categories are all lists a team owns
— your source system's vocabulary is not ours to fix in advance. Adding a field type
is more than adding a word: ticking its detail boxes makes the field form offer a
length, a precision/scale pair, or an options list, so a type you add is as usable as
one that shipped.

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
| `pnpm test` | Unit tests (lineage traversal, import planning, search escaping, form validation, list registry) |
| `pnpm typecheck` | Type-check every context (app, server, shared) |
| `pnpm db:generate` | Generate a migration after changing the schema |
| `pnpm db:migrate` / `db:seed` / `db:reset` | Database lifecycle |
| `pnpm user:create` | Add an account |

## Import and export

### Spreadsheets

Import a CSV exported from the source system — either one row per field with the record
repeated, or a sheet of records and a sheet of fields imported one after the other.
Columns are matched to the catalog automatically and you can correct any of them.

You choose what happens to rows that already exist, per import:

| | |
|---|---|
| **Only add new rows** | Existing records and fields are left completely alone. |
| **Fill blanks** (default) | Writes a value only where the catalog has none. Disagreements are listed rather than applied. |
| **The file wins** | Every value in the file replaces what the catalog holds. |

Nothing is written until you have seen exactly what would change: the preview names the
columns that would be touched and how many rows each affects, so *"description: 412,
label: 3"* tells you at a glance whether the import is doing what you meant.

### JSON

The catalog also round-trips through one JSON format, used by both directions.
References are written as `Record.field` rather than internal IDs, so an export is
portable between installs and readable in review.

The real payoff is that it is **diffable in git**: commit one per release and
`git diff` shows exactly what changed in the source application's schema. Round-trip
fidelity is exact — export, import into an empty database, export again, and the two
files are identical.

Imports are all-or-nothing. The JSON path previews by running the real import inside a
transaction and rolling it back. It only ever **inserts** — it will not update a record
that already exists, and says how many it skipped so that is visible rather than
silent. Use the CSV import when you want existing rows updated.

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

**Forms cannot express an impossible source.** Provenance is edited through a
discriminated union, so switching kind swaps the whole editor rather than leaving a
reference with two upstreams or a derived field with no expression. Validation errors
come back as `{path, message}` and land next to the input that caused them — h3's
default is a bare "Validation Error" string with the detail buried, which tells the
person filling in the form nothing.

**Modal forms reset on open, not on prop identity.** Watching the entity prop as well
would reset a half-filled form whenever anything else in the app refetched. That is not
hypothetical: it happened, via a `refreshNuxtData()` with no arguments refreshing every
`useFetch` in the app.

**A column a file does not have can never change anything.** The CSV planner takes its
candidate columns from the header row once per file, so a sparse spreadsheet is
structurally incapable of wiping the columns it omits — they are never candidates,
rather than candidates that happen to be guarded.

**`false` is a value, not a blank.** Fill-blanks writes only where the catalog has
nothing, and a boolean always has something. If `false` counted as blank, any file
carrying those columns would flip every one of them — an overwrite wearing a
fill-blanks badge. The visible consequence, stated in the UI rather than buried:
fill-blanks cannot change a yes/no column on a row that already exists.

**Clearing is separate from strategy.** In a CSV, "clear this" and "I don't have that
data" are the same bytes, so "the file wins" does not empty a value from an empty cell.
That needs its own opt-in.

**A rename is reported, never applied silently.** When a file's source ID matches a row
whose technical name differs, the source system renamed something — which is precisely
the kind of thing a catalog exists to notice. It is surfaced as a per-row opt-in and
reported even when declined.

**A PATCH changes only what it names.** The patch schemas were
`inputSchema.partial()`, which makes a key optional but keeps its default — so zod
filled the default in for absent keys and the handler wrote it over the stored value.
`PATCH { label }` on a field therefore reset its origin, all four flags and its sort
order, and reset provenance to `user_entry`, which takes the field's dependency rows
with it. The forms all send complete bodies, so nothing surfaced it. `patchSchemaOf`
strips the defaults, and the tests name each column that used to be clobbered.

**Editable lists are one table, and only for the lists that are lists.** Derivation
languages, delete behaviours and type categories are labels the source system chose,
so they live in `list_items` and are edited in Settings. Native/custom, source kinds,
cardinality and roles are not lists — they are the model wearing a dropdown, and code
branches on each member by name. Settings shows those too, with the reason each is
closed, because "not editable" with no explanation just sends someone looking.

**Retiring a list value hides it, never rewrites history.** Rows store a member's key,
so deleting one in use would leave values no list explains. Deletion is refused with a
count and points at hiding instead; a hidden member cannot be newly chosen but every
row already holding it is untouched, and still renders with its label.

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
  components/erd/    the SVG canvas
  components/form/   record, field, relationship and delete dialogs
  components/settings/  field type, module and list editors
server/
  api/          route handlers
  db/           Drizzle schema + migrations
  services/     lineage, provenance, reports, deletion, interchange, lists
  lib/          password hashing, literal search   (not auto-imported — see below)
shared/         constants, zod schemas and the list registry, used by BOTH sides
scripts/        migrate, seed, create-user, constraint smoke test
```

`server/lib/password.ts` sits outside `server/utils/` deliberately: Nitro auto-imports
`server/utils/`, which would collide with nuxt-auth-utils' own `hashPassword`. Whichever
won that race would decide the hash format, and a flip would invalidate every stored
password.

## Not built yet

**XLSX import** — CSV only for now. npm's `xlsx` is frozen at 0.18.5 with two unpatched
high-severity advisories since SheetJS moved distribution off npm, so if this is wanted
it should use `exceljs`, not the stale registry package.

**Provenance and relationships via CSV.** A spreadsheet describes records and fields
only. Provenance has to be routed through `setFieldSource` to keep its dependency rows
consistent, and `source_kind` carries a CHECK that a blank expression violates at the
database level — so accepting it from a sheet needs more care than a column mapping.

**Saved views**, and a screen for reviewing an import batch after the fact. Every
imported row now writes an audit entry sharing a batch id, so the data is there; nothing
reads it back yet.
