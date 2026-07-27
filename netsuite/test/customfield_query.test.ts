import { describe, expect, it } from 'vitest'
import { fakeQuery, loadAmd } from './amd'

/**
 * Everything in the reader is defensive because column availability varies by account,
 * feature set and version — and SuiteQL fails the *whole statement* on one unknown
 * column. These tests are the ones that prove a partial answer beats no answer.
 */

const load = (tables: Record<string, Array<Record<string, unknown>>>) =>
  loadAmd('src/lib_customfield_query.js', { 'N/query': fakeQuery(tables) })

const EMPTY = {
  entityCustomField: [],
  itemCustomField: [],
  transactionBodyCustomField: [],
  transactionColumnCustomField: [],
  crmCustomField: [],
  otherCustomField: [],
  customRecordCustomField: [],
}

const fullRow = (o: Record<string, unknown> = {}) => ({
  internalid: 1,
  scriptid: 'custentity_loyalty_tier',
  label: 'Loyalty Tier',
  fieldtype: 'SELECT',
  description: 'Which tier this customer sits in',
  ismandatory: 'F',
  selectrecordtype: 'customlist_tiers',
  appliestocustomer: 'T',
  appliestovendor: 'F',
  ...o,
})

describe('reading a table', () => {
  it('reads the full column set when the account has it', () => {
    const lib = load({ ...EMPTY, entityCustomField: [fullRow()] })
    const result = lib.readCustomFields()
    expect(result.byRecord.customer).toHaveLength(1)
    expect(result.byRecord.customer[0].description).toBe('Which tier this customer sits in')
  })

  it('loses nothing when a column we expected is absent', () => {
    // This is why it asks for `SELECT *` rather than a column list. A real run died on
    // `SELECT id … FROM CustomList` with "Unknown identifier 'ID'" — SuiteQL fails the
    // whole statement on one unknown column, so a single guessed name cost every row.
    const lib = load({
      ...EMPTY,
      entityCustomField: [
        // No `selectrecordtype`, no `description`, no `ismandatory`.
        { internalid: 1, scriptid: 'custentity_x', label: 'X', fieldtype: 'TEXT', appliestocustomer: 'T' },
      ],
    })
    const result = lib.readCustomFields()
    expect(result.byRecord.customer).toHaveLength(1)
    expect(result.byRecord.customer[0].scriptId).toBe('custentity_x')
    expect(result.byRecord.customer[0].selectRecordType).toBe('')
  })

  it('reads a column under whatever name this account gives it', () => {
    // `label` vs `name`, `ismandatory` vs `mandatory` — which spelling a table uses is
    // precisely what has been wrong twice, so nothing reads a single hard-coded name.
    const lib = load({
      ...EMPTY,
      entityCustomField: [
        { id: 4, scriptid: 'custentity_y', name: 'Y label', type: 'TEXT', mandatory: 'T', appliestocustomer: 'T' },
      ],
    })
    const field = lib.readCustomFields().byRecord.customer[0]
    expect(field.internalId).toBe('4')
    expect(field.label).toBe('Y label')
    expect(field.rawFieldType).toBe('TEXT')
    expect(field.isMandatory).toBe(true)
  })

  it('records a table it could not read at all, and carries on with the rest', () => {
    const lib = load({ ...EMPTY, itemCustomField: [fullRow({ scriptid: 'custitem_x' })] })
    const result = lib.readCustomFields()
    expect(result.diagnostics.tables).toHaveLength(7)
    expect(result.diagnostics.tables.every((t: any) => t.error === null)).toBe(true)
  })

  it('records every name it tried and what each one said', () => {
    // The output that aims the next fix. Guessing a third spelling is not a strategy.
    const lib = loadAmd('src/lib_customfield_query.js', {
      'N/query': {
        runSuiteQL({ query }: { query: string }) {
          throw new Error(`Invalid search type: ${/FROM\\s+(\\w+)/i.exec(query)?.[1]}`)
        },
      },
    })
    const result = lib.readCustomFields()
    const entity = result.diagnostics.tables.find((t: any) => t.kind === 'entity')
    expect(entity.attempts.length).toBeGreaterThan(1)
    expect(entity.attempts.every((a: any) => a.ok === false)).toBe(true)
    expect(entity.attempts[0].error).toMatch(/Invalid search type/)
  })

  it('prefers a unified table when the account has one, and skips the seven probes', () => {
    const lib = loadAmd('src/lib_customfield_query.js', {
      'N/query': fakeQuery({
        customfield: [
          { internalid: 1, scriptid: 'custentity_z', label: 'Z', fieldtype: 'TEXT', rectype: 'Customer' },
        ],
      }),
    })
    const result = lib.readCustomFields()
    expect(result.diagnostics.unified.resolved).toBe('customfield')
    expect(result.byRecord.customer).toHaveLength(1)
    expect(result.diagnostics.tables).toHaveLength(1)
  })

  it('reports the missing column by name, which is the actionable part', () => {
    const lib = loadAmd('src/lib_customfield_query.js', {
      'N/query': {
        runSuiteQL() {
          throw new Error('Invalid or unsupported search field: selectrecordtype')
        },
      },
    })
    const result = lib.readCustomFields()
    expect(result.diagnostics.tables[0].error).toMatch(/selectrecordtype/)
  })
})

describe('working out which record owns a field', () => {
  it('reads a custom record field from its rectype', () => {
    const lib = load(EMPTY)
    expect(lib.ownersOf({ rectype: 'customrecord_project' }, 'customRecord')).toEqual([
      'customrecord_project',
    ])
  })

  it('discovers appliesto columns rather than hard-coding their names', () => {
    // The exact names vary and could not be confirmed without a real account. Reading
    // whatever came back means a name we did not predict still works, and one that
    // does not exist produces no owner rather than a wrong one.
    const lib = load(EMPTY)
    expect(
      lib.ownersOf(
        { appliestocustomer: 'T', appliestovendor: 'F', appliestosomethingnew: 'T' },
        'entity',
      ),
    ).toEqual(['customer', 'somethingnew'])
  })

  it('claims no owner when no flag is set, rather than guessing one', () => {
    const lib = load(EMPTY)
    expect(lib.ownersOf({ appliestocustomer: 'F' }, 'entity')).toEqual([])
    expect(lib.ownersOf({ internalid: 1 }, 'entity')).toEqual([])
  })

  it('attaches one field to every record it applies to', () => {
    const lib = load({
      ...EMPTY,
      entityCustomField: [fullRow({ appliestocustomer: 'T', appliestovendor: 'T' })],
    })
    const result = lib.readCustomFields()
    expect(Object.keys(result.byRecord).sort()).toEqual(['customer', 'vendor'])
  })
})

describe('NetSuite’s many spellings of true', () => {
  it('reads them all, since the tables are not consistent', () => {
    const lib = load(EMPTY)
    for (const yes of [true, 1, 'T', 'true', 'TRUE', 'yes', '1']) {
      expect(lib.isTruthyFlag(yes), String(yes)).toBe(true)
    }
    for (const no of [false, 0, 'F', 'false', 'no', '', null, undefined]) {
      expect(lib.isTruthyFlag(no), String(no)).toBe(false)
    }
  })
})

describe('the field type this account actually returns', () => {
  it('carries the raw value through untouched, whatever form it takes', () => {
    // Whether this is 'SELECT' or '106' could not be settled without a real account,
    // so nothing here interprets it — the type catalog maps a code and reports a
    // number, and &debug=1 shows which this account gives.
    const lib = load({ ...EMPTY, entityCustomField: [fullRow({ fieldtype: 106 })] })
    const result = lib.readCustomFields()
    expect(result.byRecord.customer[0].rawFieldType).toBe(106)
  })

  it('keeps a sample of raw rows so one debug run answers the question', () => {
    const lib = load({ ...EMPTY, entityCustomField: [fullRow()] })
    const result = lib.readCustomFields()
    // The name that actually resolved, not the one we asked for first.
    expect(result.diagnostics.rawSample[0].table).toBe('entitycustomfield')
    expect(result.diagnostics.rawSample[0].row).toHaveProperty('appliestocustomer')
  })
})

describe('custom lists', () => {
  it('keys values by both script id and internal id', () => {
    // `selectrecordtype` points at one or the other depending where it came from.
    const lib = loadAmd('src/lib_customfield_query.js', {
      'N/query': fakeQuery({
        CustomList: [{ id: 7, scriptid: 'customlist_tiers', name: 'Tiers' }],
        CustomListValue: [
          { list: 7, name: 'Gold', isinactive: 'F' },
          { list: 7, name: 'Silver', isinactive: 'F' },
          { list: 7, name: 'Retired', isinactive: 'T' },
        ],
      }),
    })
    const result = lib.readCustomListValues()
    expect(result.byList['7']).toEqual(['Gold', 'Silver'])
    expect(result.byList.customlist_tiers).toEqual(['Gold', 'Silver'])
  })

  it('leaves inactive values out — they are not choices any more', () => {
    const lib = loadAmd('src/lib_customfield_query.js', {
      'N/query': fakeQuery({
        CustomList: [{ id: 7, scriptid: 'customlist_x', name: 'X' }],
        CustomListValue: [{ list: 7, name: 'Gone', isinactive: 'T' }],
      }),
    })
    expect(lib.readCustomListValues().byList['7']).toEqual([])
  })
})

describe('custom record types', () => {
  it('lowercases the type id, since everything else keys on it', () => {
    const lib = loadAmd('src/lib_customfield_query.js', {
      'N/query': fakeQuery({
        CustomRecordType: [
          { internalid: 3, scriptid: 'CUSTOMRECORD_Project', name: 'Project', description: 'A job' },
        ],
      }),
    })
    const result = lib.readCustomRecordTypes()
    expect(result.rows[0].typeId).toBe('customrecord_project')
    expect(result.rows[0].label).toBe('Project')
  })

  it('returns an empty list rather than throwing when the table is unavailable', () => {
    const lib = loadAmd('src/lib_customfield_query.js', {
      'N/query': {
        runSuiteQL() {
          throw new Error('no such table')
        },
      },
    })
    const result = lib.readCustomRecordTypes()
    expect(result.rows).toEqual([])
    expect(result.error).toMatch(/no such table/)
  })
})
