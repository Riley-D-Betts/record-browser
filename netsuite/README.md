# NetSuite schema exporter

Produces a CSV the Technical Records Browser imports directly: every record type in the
account, the fields on each, their types, and which records point at which.

Plain SuiteScript 2.1. No build step — the files in `src/` upload as they are.

## Why it is shaped like this

**A Suitelet cannot do the work.** It gets 1,000 usage units. Instantiating one record
type to read its fields costs roughly 5, and there are around 200 standard types —
about 1,250 units before a single custom record. Map/Reduce gets 10,000 per job and
resets governance per `map` call, so one awkward record type cannot starve the rest.
The Suitelet only starts the job and serves the result.

**The per-type custom-field tables do not exist in SuiteQL.** `entitycustomfield`,
`itemcustomfield`, `transactionbodycustomfield` and their siblings are SDF-XML and
SuiteTalk-SOAP customization type names — Oracle's Records Browser marks all seven
`inAnalytics:"F"`, and a production account rejected every one. Neither do the matching
`search.Type.*` enum members. The real table is **`customfield`**, singular and unified,
and it is the only one this queries.

**SuiteQL is not used to work out which record owns a field.** It cannot: `customfield`
has no `appliesto*` columns. It does not need to either — `getFields()` already answers
that, because a custom field is a real field on the record. SuiteQL is asked only what
it can answer: given a script id, the field's description, data type and select target.
The two are joined on **lowercased** script id, because `customfield` stores it
uppercase while `getFields()` returns it lowercase, and joining raw yields a 0% hit
rate that looks exactly like an account with no custom fields.

**Type mapping is a table, not a guess.** NetSuite spells one idea two ways —
`Field.type` is lowercase (`text`, `select`), custom-field metadata is uppercase
(`TEXT`, `SELECT`) — and some carry a trailing digit for paired columns (`currency2`).
`lib_type_catalog.js` normalises all of it into one lookup. A type it does not
recognise is **reported, never guessed**: a wrong guess writes a type nobody chose,
whereas an unmapped one shows up as a counted gap in the script log.

## Files

| | |
|---|---|
| `src/mr_schema_export.js` | Map/Reduce. Does the enumeration and writes the CSV. |
| `src/sl_schema_export.js` | Suitelet. Start, progress, download, optional push, `&debug=1`. |
| `src/lib_type_catalog.js` | The two-vocabulary type table, and native/custom. |
| `src/lib_customfield_query.js` | SuiteQL reads for custom fields, record types and lists. |
| `src/lib_csv.js` | Quoting, and the header contract with the importer. |

## Deploying

1. **Upload** the five files in `src/` to the File Cabinet, in one folder. They
   `define` each other by relative path, so they must stay together.

2. **Map/Reduce script record** — Customization → Scripting → Scripts → New, from
   `mr_schema_export.js`.
   - Script ID: `customscript_trb_schema_export`
   - Parameters (Preferences tab → Parameters):

     | ID | Type | Purpose |
     |---|---|---|
     | `custscript_trb_scope` | Free-Form Text | `all`, `standard` or `custom` |
     | `custscript_trb_folder` | Integer | File Cabinet folder id. Defaults to `-15` (SuiteScripts) |

   - Deployment ID: `customdeploy_trb_schema_export`, status **Scheduled** (it is
     submitted on demand, not on a schedule).

3. **Suitelet script record** from `sl_schema_export.js`.
   - Script ID: `customscript_trb_schema_export_sl`
   - Deployment: **Released**, and set Audience to the roles that should be able to run
     it. Optional parameters:

     | ID | Type | Purpose |
     |---|---|---|
     | `custscript_trb_endpoint` | Free-Form Text | Catalog CSV import URL, for the push button |
     | `custscript_trb_token` | Password | Sent as `Authorization: Bearer …` |

   Leave both unset to download the file and upload it by hand, which needs no network
   path out of NetSuite at all.

4. **Run it.** Open the Suitelet, pick a scope, press Start. It polls until the job
   finishes, then the files are in the configured folder as
   `record-browser-export*.csv`.

### Permissions

The role running the Suitelet needs:

- **SuiteScript** and **SuiteAnalytics Workbook** (SuiteQL is gated on the latter)
- **Documents and Files** — Edit, to write into the File Cabinet
- View access to the record types you want enumerated. A type the role cannot see is
  reported as skipped rather than silently omitted.

## What a real account said

The first production run is worth reading before you deploy this, because it changed
the design:

```
entityCustomField            -> "Invalid search type: entityCustomField"
itemCustomField              -> "Invalid search type: itemCustomField"
transactionBodyCustomField   -> (same)
transactionColumnCustomField -> (same)
crmCustomField               -> (same)
otherCustomField             -> (same)
customRecordCustomField      -> (same)

CustomList        -> "Unknown identifier '"ID"'. Available identifiers are: {customlist=CustomList}"
CustomRecordType  -> worked, 244 rows
```

Four things follow from that, and all four are now built in.

**Those seven tables do not exist, under any casing.** `CustomRecordType` resolved in
PascalCase, so lookup is not case-sensitive — re-spelling would have been a third wrong
guess. They were replaced with the one table that is real, `customfield`, and table
names are now *probed* with every attempt recorded alongside the error it gave.

**"Unknown identifier" was a signal we threw away.** It means the table *resolved* and
only the column was wrong — a completely different problem from "no such table", with a
different fix. Errors are now classified into `no-such-table`, `table-exists-bad-column`,
`denied` and `unclassified`, and a permissions failure is never reported as absence.

**One guessed column name lost every row.** `SELECT id … FROM CustomList` failed
entirely because `id` was not a column — SuiteQL fails the whole statement on one
unknown identifier. Every query is now `SELECT *`, and each value is read under any of
several possible column names. A column we did not expect costs nothing; a column that
is missing costs only that column.

**The export looked fine.** It wrote a large, wholly plausible CSV — every record type,
every field — with zero relationships and zero descriptions, and said nothing. That is
the worst possible shape for a failure: not obviously empty, just quietly incomplete.
Someone importing it would conclude their schema has no relationships.

So the export now judges itself. It counts reference targets, and writes a companion
file beside the CSV — `record-browser-export-INCOMPLETE-README.txt` when something is
missing — naming what failed and what the CSV therefore does not contain. Finding zero
reference targets across thousands of fields is treated as a symptom, not an answer.

### The mistake that would have been worse than the bug

`customfield` carries **both** `fieldvaluetype` (the data type: `TEXT`, `SELECT`) and
`fieldtype` (the *placement*: `BODY`, `COLUMN`, `ENTITY`). Reading the second as the
type yields values that map to nothing — and since metadata used to override the type
from `getFields()`, a field correctly typed `select` would have been overwritten and
imported with no type at all. Simply switching to the right table, without noticing
this, would have made the export **worse than the version that read nothing**.

Three things now prevent it. `fieldvaluetype` is preferred. A metadata type that maps
to nothing never overrides one that does. And the export checks the values it actually
saw against the placement vocabulary, so picking the wrong column produces a specific,
named complaint rather than a catalog full of untyped fields.

The report prints the resolution map for exactly this reason:

```
Columns used:
  scriptId       -> scriptid
  dataType       -> fieldvaluetype
  selectTarget   -> fieldvaluetyperecord
  description    -> description
  label          -> name
```

If that says `dataType -> fieldtype`, you know immediately why the types are wrong.

### What survives a total metadata failure

Worth knowing, because it is more than you would expect:

| | |
|---|---|
| Record types | ✅ from `record.Type` and `CustomRecordType` |
| Fields, including custom ones | ✅ `getFields()` returns them — they are real fields on the record |
| Field types | ✅ from `Field.type` |
| Native vs custom | ✅ from NetSuite's own id naming, no metadata needed |
| Required | ✅ from `Field.isMandatory` |
| **Reference targets → relationships** | ❌ **needs the metadata** |
| Descriptions on custom fields | ❌ needs the metadata |
| Allowed values from custom lists | ❌ needs the metadata |

## Run it once with `&debug=1` first

Append `&debug=1` to the Suitelet URL. It dumps every candidate table name it tried,
the error each gave, and the **actual column names** of any row that came back — since
`SELECT *` means whatever this account has is what shows up. It leads with a plain
verdict on whether custom field metadata is readable at all.

That output is what to act on. If a table name works that is not in the list, add it to
`TABLES` in `lib_customfield_query.js`; if a column comes back under a name the reader
does not know, add it to the relevant `pick(...)` list. Both are one-line changes, and
the dump tells you exactly which.

Read `columnsUsed` and `dataTypeValues` first. Between them they settle what remains
genuinely unknown:

- **Does the type column hold codes (`SELECT`) or display labels (`List/Record`)?** Both
  are mapped, so either degrades to correct rather than blank. `dataTypeValues` shows a
  histogram of what your account really contains.
- **Did the right column get picked?** If `dataTypeValues` is full of `BODY`, `ENTITY`
  and `COLUMN`, the placement column won and the report will already be complaining.
- **`appliesto*` is not used at all** any more. Ownership comes from `getFields()`,
  which cannot be wrong about which fields are on a record.

The dump also runs one guarded `record.load({type:'entitycustomfield'})` probe and
reports the result. Oracle's `objectIDMap` marks those types `inScript:"F"`, so it is
expected to fail — nothing depends on it, but if it works on your account it would
yield the `appliesto*` flags directly and is worth knowing.

The script log after a real run is the other half of this. It lists every field type it
could not map, with a count, so one run tells you exactly what to add.

## What this cannot promise

**Standard-record field coverage is very good, not complete.** `getFields()` on a
record built with `record.create` returns fewer fields than one built with
`record.load`, because sourcing-dependent fields are not materialised until there is
data to source from. Loading an arbitrary real record of every type is not something an
export should do. Custom fields are unaffected — they come from SuiteQL, which sees all
of them.

**Uniqueness and primary keys are barely available.** NetSuite exposes neither on a
`Field`. `internalid` is marked as the primary key because it is one for every record
type in the product; nothing else is guessed.

**Descriptions only exist for custom fields.** A `Field` object has no `description`
property at all, so standard fields export with an empty one.

**Provenance is not exported.** NetSuite formula fields would map well onto the
catalog's `derived` kind, but CSV import excludes `source_kind` by design — it has to
be routed through `setFieldSource` to keep dependency rows consistent. Set it in the
catalog after importing.

## Tests

```bash
pnpm test              # includes these
npx vitest run netsuite/
```

`test/amd.ts` runs the deployed files through a `define` shim with fake `N/*` modules,
so the code under test is the code that uploads — nothing here exists only to be
testable.

A note on fixtures, because it matters more than usual here: the previous ones
described `entityCustomField` rows carrying `label`, `selectrecordtype` and
`appliestocustomer` — a schema that exists on no NetSuite account. The suite was green
*because* it encoded the mistake, which is how it survived two rounds. The fixtures are
now the real `customfield` shape, uppercase script ids and all.

What they actually pin:

- Every entry in `TYPE_MAP` lands on a key the catalog really has, checked against
  `BUILTIN_DATA_TYPES` itself.
- The emitted headers auto-map with **none unmapped**, run through the catalog's own
  `autoMapHeaders`. A rename on either side fails the test rather than silently binding
  a column to the wrong field.
- Quoting survives a papaparse round trip — commas, quotes and newlines in labels.
- The SuiteQL reader's reduced-column retry, so an account missing one column loses one
  column rather than a whole table.
- **The full round trip**: run the Map/Reduce against a fake account, take the CSV,
  import it into a real SQLite catalog, and assert the records, fields and derived
  relationships landed — then re-import and assert nothing changed.
- **Every silent-wrong-catalog hazard**, in `silent_wrong.test.ts`: a placement value
  never overwrites a good type; an uppercase script id still joins, and a zero hit rate
  complains; an unresolvable integer select target emits nothing rather than inventing
  `_297` as a parent record; a custom list's values never attach to a field that merely
  shares its number; and an account with entirely unfamiliar columns completes,
  fabricates nothing, and names every role it could not fill.

What they cannot pin: that NetSuite returns the shapes the fakes assume, real
governance cost, or deployment mechanics. Those need an account, and `&debug=1` exists
so one run settles them.
