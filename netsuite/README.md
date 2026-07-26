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

**`search.Type.ENTITY_CUSTOM_FIELD` does not exist.** Neither does
`TRANSACTION_BODY_CUSTOM_FIELD` or its siblings; code referencing them throws on the
first line. Custom metadata comes from SuiteQL via `N/query`, which is documented.

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

## Run it once with `&debug=1` first

Append `&debug=1` to the Suitelet URL. It dumps the raw SuiteQL rows without mapping
them, which answers the two questions that could not be settled without a real account:

- **Does `fieldtype` come back as `TEXT` or as a number like `106`?** Both are carried
  through untouched. The type catalog maps the code and reports a number as unmapped,
  so a numeric account shows up as a named, counted gap rather than as silently wrong
  types. If yours is numeric, add the ids to `TYPE_MAP` in `lib_type_catalog.js`.
- **What are the `appliesto*` columns actually called?** The reader discovers them
  rather than hard-coding names — it reads every key beginning `appliesto` off whatever
  came back. A name nobody predicted still works; the dump shows you the real ones.

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

What they cannot pin: that NetSuite returns the shapes the fakes assume, real
governance cost, or deployment mechanics. Those need an account, and `&debug=1` exists
so one run settles them.
