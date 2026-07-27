import { describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import { fakeFile, fakeLog, fakeQuery, fakeRecord, fakeRuntime, loadAmd } from './amd'

/**
 * The failures that produce a *confident wrong* catalog rather than an obviously empty
 * one. These are the dangerous ones: an empty result gets investigated, a full and
 * plausible one gets imported.
 *
 * Every case here is one this exporter could actually have produced. None of them
 * would have been caught by any check that existed before.
 */

const ACCOUNT = {
  customer: [
    { id: 'internalid', label: 'Internal ID', type: 'integer' },
    { id: 'entityid', label: 'Customer ID', type: 'text', isMandatory: true },
    { id: 'custentity_loyalty_tier', label: 'Loyalty Tier', type: 'select' },
  ],
}

function run(tables: Record<string, Array<Record<string, unknown>>>) {
  const files = fakeFile()
  const logged: any[] = []
  const mr = loadAmd('src/mr_schema_export.js', {
    'N/record': fakeRecord(ACCOUNT, []),
    'N/runtime': fakeRuntime({ custscript_trb_scope: 'standard' }),
    'N/file': files,
    'N/log': { audit: (o: any) => logged.push(o), error: (o: any) => logged.push(o), debug: () => {}, emergency: () => {} },
    'N/query': fakeQuery(tables),
  })

  const mapped: any[] = []
  for (const item of mr.getInputData()) {
    mr.map({ value: JSON.stringify(item), write: (o: any) => mapped.push(o) })
  }
  const reduced: any[] = []
  for (const e of mapped) mr.reduce({ key: e.key, values: [e.value], write: (o: any) => reduced.push(o) })
  mr.summarize({
    output: { iterator: () => ({ each: (fn: any) => { for (const e of reduced) if (!fn(e.key, e.value)) break } }) },
    inputSummary: { error: null },
  })

  const csvFile = files.saved.find((f) => f.name.endsWith('.csv'))!
  return {
    rows: Papa.parse<Record<string, string>>(csvFile.contents.replace(/^﻿/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
    }).data,
    report: files.saved.find((f) => !f.name.endsWith('.csv'))!,
    logged,
  }
}

const find = (rows: Record<string, string>[], field: string) =>
  rows.find((r) => r['Field API Name'] === field)!

describe('the placement column masquerading as the data type', () => {
  /**
   * `customfield` has both `fieldvaluetype` (TEXT, SELECT) and `fieldtype` (BODY,
   * ENTITY, COLUMN). Reading the second as the type gives values that map to nothing —
   * and because metadata used to override the type from `getFields()`, a field
   * correctly typed `select` would be **overwritten** and import untyped. Reading the
   * metadata would have made the export worse than not reading it.
   */
  const PLACEMENT_ONLY = {
    customfield: [
      {
        internalid: 501,
        scriptid: 'CUSTENTITY_LOYALTY_TIER',
        name: 'Loyalty Tier',
        description: 'Which tier',
        fieldtype: 'ENTITY',
      },
    ],
  }

  it('does not let a placement value overwrite a good type from getFields()', () => {
    const { rows } = run(PLACEMENT_ONLY)
    // getFields() said `select`; ENTITY maps to nothing, so it must not win.
    expect(find(rows, 'custentity_loyalty_tier')['Type']).toBe('enum')
  })

  it('still takes the description, which is the thing only metadata has', () => {
    const { rows } = run(PLACEMENT_ONLY)
    expect(find(rows, 'custentity_loyalty_tier')['Field Description']).toBe('Which tier')
  })

  it('says which column it chose and that the values look wrong', () => {
    const { report } = run(PLACEMENT_ONLY)
    expect(report.name).toMatch(/INCOMPLETE/)
    expect(report.contents).toMatch(/very likely the wrong column/)
    expect(report.contents).toMatch(/dataType\s+-> fieldtype/)
    expect(report.contents).toMatch(/ENTITY/)
  })
})

describe('the uppercase script id trap', () => {
  /**
   * `customfield` stores `scriptid` uppercase; `getFields()` returns it lowercase.
   * Joining raw means thousands of metadata rows match nothing — a total failure that
   * looks exactly like an account with no custom fields.
   */
  it('joins anyway, because the key is lowercased on both sides', () => {
    const { rows } = run({
      customfield: [
        {
          internalid: 501,
          scriptid: 'CUSTENTITY_LOYALTY_TIER',
          name: 'Loyalty Tier',
          description: 'Joined',
          fieldvaluetype: 'SELECT',
        },
      ],
    })
    expect(find(rows, 'custentity_loyalty_tier')['Field Description']).toBe('Joined')
  })

  it('complains when metadata rows exist but nothing matched', () => {
    const { report } = run({
      customfield: [
        { internalid: 9, scriptid: 'CUSTENTITY_SOMETHING_ELSE', name: 'X', fieldvaluetype: 'TEXT' },
      ],
    })
    expect(report.contents).toMatch(/not one matched a field found on a record type/)
  })
})

describe('integer select targets', () => {
  /**
   * `fieldvaluetyperecord` is an internal id. `toApiName(297)` yields `_297`, which
   * would be written as a reference target and invent a relationship to a record type
   * that does not exist — the importer would happily create it.
   */
  it('emits nothing for an id it cannot resolve, rather than inventing a record', () => {
    const { rows } = run({
      customfield: [
        {
          internalid: 501,
          scriptid: 'CUSTENTITY_LOYALTY_TIER',
          name: 'Loyalty Tier',
          fieldvaluetype: 'SELECT',
          fieldvaluetyperecord: 297,
        },
      ],
      CustomRecordType: [],
    })
    const row = find(rows, 'custentity_loyalty_tier')
    expect(row['Reference Target']).toBe('')
    expect(row['Reference Target']).not.toMatch(/_297/)
  })

  it('resolves an id it can, and names the record properly', () => {
    const { rows } = run({
      customfield: [
        {
          internalid: 501,
          scriptid: 'CUSTENTITY_LOYALTY_TIER',
          name: 'Loyalty Tier',
          fieldvaluetype: 'SELECT',
          fieldvaluetyperecord: 20,
        },
      ],
      CustomRecordType: [{ internalid: 20, scriptid: 'customrecord_tier', name: 'Tier' }],
    })
    const row = find(rows, 'custentity_loyalty_tier')
    expect(row['Reference Target']).toBe('customrecord_tier')
    expect(row['Type']).toBe('reference')
  })
})

describe('custom list values attaching to the wrong field', () => {
  /**
   * Values used to be keyed by internal id as well as script id. A field whose select
   * target merely shared a number with some unrelated list was handed that list's
   * values — wrong data, entirely plausible, reported by nothing.
   */
  it('does not hand a field the values of a list that merely shares its number', () => {
    const { rows } = run({
      customfield: [
        {
          internalid: 501,
          scriptid: 'CUSTENTITY_LOYALTY_TIER',
          name: 'Loyalty Tier',
          fieldvaluetype: 'SELECT',
          // An owner-record id, not a list id — and it collides with the list below.
          fieldvaluetyperecord: 7,
        },
      ],
      CustomRecordType: [{ internalid: 20, scriptid: 'customrecord_other', name: 'Other' }],
      CustomList: [{ internalid: 7, scriptid: 'CUSTOMLIST_UNRELATED', name: 'Unrelated' }],
      customlist_unrelated: [{ id: 1, name: 'Should not appear', isinactive: 'F' }],
    })
    expect(find(rows, 'custentity_loyalty_tier')['Allowed Values']).toBe('')
  })

  it('attaches values when the target really is that list', () => {
    const { rows } = run({
      customfield: [
        {
          internalid: 501,
          scriptid: 'CUSTENTITY_LOYALTY_TIER',
          name: 'Loyalty Tier',
          fieldvaluetype: 'SELECT',
          fieldvaluetyperecord: 7,
        },
      ],
      CustomRecordType: [{ internalid: 7, scriptid: 'customlist_tiers', name: 'Tiers' }],
      CustomList: [{ internalid: 7, scriptid: 'CUSTOMLIST_TIERS', name: 'Tiers' }],
      customlist_tiers: [
        { id: 1, name: 'Gold', isinactive: 'F' },
        { id: 2, name: 'Silver', isinactive: 'F' },
      ],
    })
    const row = find(rows, 'custentity_loyalty_tier')
    expect(row['Allowed Values']).toBe('Gold;Silver')
    // A list is not a record, so it must not become a relationship.
    expect(row['Reference Target']).toBe('')
    expect(row['Type']).toBe('enum')
  })
})

describe('an account whose schema we do not recognise at all', () => {
  it('completes, fabricates nothing, and reports every unfilled role', () => {
    const { rows, report } = run({
      customfield: [{ some_column: 1, another: 'x' }],
    })
    // Fields still export — they never depended on the metadata.
    expect(rows.length).toBeGreaterThan(0)
    expect(find(rows, 'entityid')['Field API Name']).toBe('entityid')
    // And nothing was invented for them.
    expect(find(rows, 'custentity_loyalty_tier')['Field Description']).toBe('')
    expect(report.contents).toMatch(/could be used for "scriptId"/)
  })
})
