import { describe, expect, it } from 'vitest'
import { fakeQuery, loadAmd } from './amd'

/**
 * These fixtures are the real `customfield` shape.
 *
 * The previous ones were `entityCustomField` rows carrying `label`, `selectrecordtype`
 * and `appliestocustomer` — a schema that exists on no NetSuite account. The suite was
 * green *because* it encoded the mistake, which is how the bug survived two rounds. A
 * fixture is a claim about the world, and a wrong one is worse than no test.
 *
 * The real table has: `internalid`, `scriptid` (UPPERCASE), `name` (not `label`),
 * `description`, `fieldtype` (placement — BODY/ENTITY), `fieldvaluetype` (the actual
 * data type), `fieldvaluetyperecord` (select target, an integer id), `ismandatory`,
 * `owner`, `recordtype`. No `appliesto*` columns at all.
 */

const load = (tables: Record<string, Array<Record<string, unknown>>>) =>
  loadAmd('src/lib_customfield_query.js', { 'N/query': fakeQuery(tables) })

/** One row as `customfield` really returns it, uppercase script id and all. */
const realRow = (o: Record<string, unknown> = {}) => ({
  internalid: 501,
  scriptid: 'CUSTENTITY_LOYALTY_TIER',
  name: 'Loyalty Tier',
  description: 'Which tier this customer sits in',
  fieldtype: 'ENTITY',
  fieldvaluetype: 'SELECT',
  fieldvaluetyperecord: 297,
  ismandatory: 'F',
  owner: 12,
  recordtype: 4,
  ...o,
})

describe('the table it reads', () => {
  it('uses customfield, and never the seven per-type names', () => {
    // entitycustomfield and its siblings are SDF-XML / SuiteTalk-SOAP customization
    // names. Oracle's Records Browser marks all seven inAnalytics:"F", and a real
    // account rejected every one with "Invalid search type". No spelling works.
    const lib = load({ customfield: [realRow()] })
    expect(lib.readCustomFields().schema.table).toBe('customfield')
    expect(lib.CANDIDATES).toEqual(['customfield', 'CustomField'])
    expect(JSON.stringify(lib.CANDIDATES)).not.toMatch(/entitycustomfield/i)
  })

  it('reports a missing table as absent, not as something else', () => {
    const lib = loadAmd('src/lib_customfield_query.js', {
      'N/query': {
        runSuiteQL() {
          throw new Error('Invalid search type: customfield')
        },
      },
    })
    const schema = lib.readCustomFields().schema
    expect(schema.state).toBe('failed')
    expect(schema.errorClass).toBe('no-such-table')
  })
})

describe('telling failures apart', () => {
  it('knows "unknown identifier" means the table EXISTS', () => {
    // The real account's CustomList error was this. Reporting it as "no such table"
    // sends the next fix in exactly the wrong direction.
    const lib = load({ customfield: [] })
    expect(lib.classify('Unknown identifier \'"ID"\'. Available identifiers are: {customlist=CustomList}'))
      .toBe('table-exists-bad-column')
    expect(lib.classify('Invalid search type: entityCustomField')).toBe('no-such-table')
    expect(lib.classify('You do not have permission to access this record')).toBe('denied')
    expect(lib.classify('something nobody predicted')).toBe('unclassified')
    expect(lib.classify(null)).toBe('ok')
  })

  it('never reports a permission problem as absence', () => {
    const lib = loadAmd('src/lib_customfield_query.js', {
      'N/query': {
        runSuiteQL() {
          throw new Error('Insufficient permission to run this query')
        },
      },
    })
    expect(lib.readCustomFields().schema.errorClass).toBe('denied')
  })

  it('distinguishes an empty table from a missing one', () => {
    // An account with no custom fields and a query that matched nothing look the same
    // in the output unless the export says which it observed.
    const lib = load({ customfield: [] })
    const schema = lib.readCustomFields().schema
    expect(schema.state).toBe('empty')
    expect(schema.table).toBe('customfield')
    expect(schema.error).toBeNull()
  })
})

describe('choosing which column does which job', () => {
  it('prefers fieldvaluetype over fieldtype for the data type', () => {
    // The single most dangerous line in the module. `fieldtype` is the PLACEMENT
    // (BODY/COLUMN/ENTITY); reading it as the type gives every custom field a value
    // that maps to nothing.
    const lib = load({ customfield: [realRow()] })
    const schema = lib.readCustomFields().schema
    expect(schema.roles.dataType).toBe('fieldvaluetype')
  })

  it('falls back to fieldtype only when fieldvaluetype is genuinely absent', () => {
    const lib = load({
      customfield: [{ internalid: 1, scriptid: 'CUSTENTITY_X', name: 'X', fieldtype: 'TEXT' }],
    })
    expect(lib.readCustomFields().schema.roles.dataType).toBe('fieldtype')
  })

  it('never lets one column satisfy two roles', () => {
    // Without exclusivity, selectTarget falls through to `recordtype` — the OWNER's
    // internal id — and every field on record type 297 gets handed the allowed values
    // of whichever custom list happens to be id 297. Wrong data, entirely plausible.
    const lib = load({
      customfield: [
        { internalid: 1, scriptid: 'CUSTENTITY_X', name: 'X', fieldvaluetype: 'TEXT', recordtype: 4 },
      ],
    })
    const roles = lib.readCustomFields().schema.roles
    expect(roles.ownerRecord).toBe('recordtype')
    expect(roles.selectTarget).toBeUndefined()
  })

  it('reads the label from `name`, which is what the table calls it', () => {
    const lib = load({ customfield: [realRow()] })
    expect(lib.readCustomFields().schema.roles.label).toBe('name')
  })

  it('records every role it could not fill, rather than emitting a placeholder', () => {
    const lib = load({
      customfield: [{ scriptid: 'CUSTENTITY_X', fieldvaluetype: 'TEXT' }],
    })
    const result = lib.readCustomFields()
    const unresolved = result.schema.unresolved.map((u: any) => u.role)
    expect(unresolved).toContain('description')
    expect(unresolved).toContain('selectTarget')
    expect(result.byScriptId.custentity_x.description).toBe('')
  })

  it('completes on an account with entirely unfamiliar columns, inventing nothing', () => {
    const lib = load({
      customfield: [{ weird_a: 1, weird_b: 'x', weird_c: true }],
    })
    const result = lib.readCustomFields()
    expect(result.schema.state).toBe('ok')
    expect(Object.keys(result.byScriptId)).toEqual([])
    expect(result.schema.unresolved.length).toBeGreaterThan(5)
    expect(result.schema.columns).toEqual(['weird_a', 'weird_b', 'weird_c'])
  })
})

describe('the uppercase script id trap', () => {
  it('lowercases the key so the join can hit', () => {
    // `customfield` stores scriptid UPPERCASE; getFields() returns it lowercase.
    // Joining raw gives a 0% hit rate on every account — a total failure that looks
    // exactly like "this account has no custom fields".
    const lib = load({ customfield: [realRow()] })
    const byScriptId = lib.readCustomFields().byScriptId
    expect(Object.keys(byScriptId)).toEqual(['custentity_loyalty_tier'])
  })

  it('lowercases result keys too, since NetSuite does not promise their casing', () => {
    const lib = load({
      customfield: [{ INTERNALID: 9, SCRIPTID: 'CUSTENTITY_Z', NAME: 'Z', FIELDVALUETYPE: 'TEXT' }],
    })
    const field = lib.readCustomFields().byScriptId.custentity_z
    expect(field.internalId).toBe('9')
    expect(field.label).toBe('Z')
    expect(field.rawFieldType).toBe('TEXT')
  })
})

describe('what it reads off a row', () => {
  it('carries the select target as the raw integer, resolving nothing itself', () => {
    // `fieldvaluetyperecord` is an internal id. Turning 297 into a name is the
    // caller's job, and an unresolvable one must produce nothing rather than `_297`.
    const lib = load({ customfield: [realRow()] })
    expect(lib.readCustomFields().byScriptId.custentity_loyalty_tier.selectTargetId).toBe('297')
  })

  it('counts the values of the type column, so the export can sanity-check it', () => {
    const lib = load({
      customfield: [
        realRow({ scriptid: 'A', fieldvaluetype: 'SELECT' }),
        realRow({ scriptid: 'B', fieldvaluetype: 'TEXT' }),
        realRow({ scriptid: 'C', fieldvaluetype: 'TEXT' }),
      ],
    })
    expect(lib.readCustomFields().schema.typeValueCounts).toEqual({ SELECT: 1, TEXT: 2 })
  })

  it('reads NetSuite’s many spellings of true', () => {
    const lib = load({ customfield: [] })
    for (const yes of [true, 1, 'T', 'true', 'TRUE', 'yes', '1']) {
      expect(lib.isTruthyFlag(yes), String(yes)).toBe(true)
    }
    for (const no of [false, 0, 'F', 'false', 'no', '', null, undefined]) {
      expect(lib.isTruthyFlag(no), String(no)).toBe(false)
    }
  })
})

describe('custom record types', () => {
  it('maps internal id to script id, which select targets need', () => {
    const lib = load({
      CustomRecordType: [
        { internalid: 297, scriptid: 'CUSTOMRECORD_Project', name: 'Project', description: 'A job' },
      ],
    })
    const result = lib.readCustomRecordTypes()
    expect(result.rows[0].typeId).toBe('customrecord_project')
    expect(result.byInternalId['297']).toBe('customrecord_project')
  })

  it('returns an empty list rather than throwing when unavailable', () => {
    const lib = loadAmd('src/lib_customfield_query.js', {
      'N/query': {
        runSuiteQL() {
          throw new Error('Invalid search type: customrecordtype')
        },
      },
    })
    const result = lib.readCustomRecordTypes()
    expect(result.rows).toEqual([])
    expect(result.errorClass).toBe('no-such-table')
  })
})

describe('custom list values', () => {
  /**
   * There is no `CustomListValue` table. Each list's values live in a table named
   * after the list's own script id.
   */
  it('reads each list from its own table, named after its script id', () => {
    const lib = load({
      CustomList: [{ internalid: 7, scriptid: 'CUSTOMLIST_TIERS', name: 'Tiers' }],
      customlist_tiers: [
        { id: 1, name: 'Gold', isinactive: 'F' },
        { id: 2, name: 'Silver, tarnished', isinactive: 'F' },
        { id: 3, name: 'Retired', isinactive: 'T' },
      ],
    })
    const result = lib.readCustomListValues(['customlist_tiers'])
    expect(result.byList.customlist_tiers).toEqual(['Gold', 'Silver, tarnished'])
  })

  it('only reads lists something actually points at', () => {
    const lib = load({
      CustomList: [
        { internalid: 7, scriptid: 'CUSTOMLIST_TIERS', name: 'Tiers' },
        { internalid: 8, scriptid: 'CUSTOMLIST_UNUSED', name: 'Unused' },
      ],
      customlist_tiers: [{ id: 1, name: 'Gold', isinactive: 'F' }],
      customlist_unused: [{ id: 1, name: 'Never asked for', isinactive: 'F' }],
    })
    const result = lib.readCustomListValues(['customlist_tiers'])
    expect(Object.keys(result.byList)).toEqual(['customlist_tiers'])
    expect(result.listsRead).toBe(1)
  })

  it('keys values by script id only, never by internal id', () => {
    // Keying by internal id is what let an unrelated list's values attach to fields
    // whose select target merely shared a number.
    const lib = load({
      CustomList: [{ internalid: 297, scriptid: 'CUSTOMLIST_TIERS', name: 'Tiers' }],
      customlist_tiers: [{ id: 1, name: 'Gold', isinactive: 'F' }],
    })
    const result = lib.readCustomListValues(['customlist_tiers'])
    expect(result.byList['297']).toBeUndefined()
  })

  it('refuses a list id that is not a plain custom list id', () => {
    // The one place a table name is interpolated from account data.
    const lib = load({
      CustomList: [{ internalid: 1, scriptid: 'customlist_x; DROP TABLE', name: 'Nope' }],
    })
    const result = lib.readCustomListValues(['customlist_x; drop table'])
    expect(result.byList['customlist_x; drop table']).toBeUndefined()
    expect(result.perList[0].ok).toBe(false)
    expect(result.perList[0].error).toMatch(/Refused/)
  })

  it('records a per-list failure as data rather than losing every other list', () => {
    const lib = load({
      CustomList: [
        { internalid: 7, scriptid: 'CUSTOMLIST_GOOD', name: 'Good' },
        { internalid: 8, scriptid: 'CUSTOMLIST_GONE', name: 'Gone' },
      ],
      customlist_good: [{ id: 1, name: 'Yes', isinactive: 'F' }],
    })
    const result = lib.readCustomListValues(['customlist_good', 'customlist_gone'])
    expect(result.byList.customlist_good).toEqual(['Yes'])
    expect(result.perList.find((p: any) => p.list === 'customlist_gone').ok).toBe(false)
  })
})
