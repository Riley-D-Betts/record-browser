import { describe, expect, it } from 'vitest'
import { loadAmd } from './amd'
import { BUILTIN_DATA_TYPES } from '../../shared/constants'

const catalog = loadAmd('src/lib_type_catalog.js')

/**
 * The mapping is the exporter's only real judgement call, and it fails quietly: a type
 * this table does not recognise imports the field with *no type at all*, with nothing
 * but a log line to say so. These tests are what make that a caught mistake.
 */

describe('the two vocabularies', () => {
  it('reads N/record lowercase and custom-field uppercase as the same type', () => {
    // The whole reason this table exists: NetSuite spells one idea two ways.
    for (const pair of [
      ['text', 'TEXT'],
      ['checkbox', 'CHECKBOX'],
      ['select', 'SELECT'],
      ['datetimetz', 'DATETIMETZ'],
      ['textarea', 'TEXTAREA'],
    ]) {
      expect(catalog.catalogTypeFor(pair[0], '').type, pair.join('/')).toBe(
        catalog.catalogTypeFor(pair[1], '').type,
      )
    }
  })

  it('reads a paired column the same as its unpaired form', () => {
    // `currency2` is the second column of a paired field, not a different type.
    expect(catalog.catalogTypeFor('currency2', '').type).toBe('currency')
    expect(catalog.catalogTypeFor('float2', '').type).toBe('decimal')
  })

  it('normalises punctuation and whitespace out of a type name', () => {
    expect(catalog.normaliseTypeName('  Date/Time  ')).toBe('DATETIME')
  })
})

describe('every mapping lands on a real catalog type', () => {
  const known = new Set(BUILTIN_DATA_TYPES.map((t) => t.key))

  it('never maps to a key the catalog does not have', () => {
    // A typo here is invisible in NetSuite and only shows up as a field with no type
    // after an import, which is why this is asserted rather than reviewed.
    for (const [netsuiteType, catalogKey] of Object.entries(catalog.TYPE_MAP)) {
      expect(known.has(catalogKey as string), `${netsuiteType} -> ${catalogKey}`).toBe(true)
    }
  })

  it('maps the types a NetSuite account is certain to contain', () => {
    for (const type of [
      'text', 'textarea', 'checkbox', 'select', 'multiselect', 'date', 'datetimetz',
      'currency', 'float', 'integer', 'percent', 'email', 'url', 'phone', 'image',
    ]) {
      expect(catalog.catalogTypeFor(type, '').mapped, type).toBe(true)
    }
  })
})

describe('selects', () => {
  it('is a reference when it names a record, not a picklist', () => {
    // Typing this `enum` would hide every relationship the export exists to carry.
    expect(catalog.catalogTypeFor('select', 'customer').type).toBe('reference')
  })

  it('is a picklist when it names nothing', () => {
    expect(catalog.catalogTypeFor('select', '').type).toBe('enum')
  })

  it('is multi_enum when it is a multiselect, target or not', () => {
    expect(catalog.catalogTypeFor('multiselect', '').type).toBe('multi_enum')
    expect(catalog.catalogTypeFor('multiselect', 'customer').type).toBe('multi_enum')
  })
})

describe('reporting what it cannot map', () => {
  it('reports an unknown type rather than guessing one', () => {
    const result = catalog.catalogTypeFor('somethingnew', '')
    expect(result.mapped).toBe(false)
    expect(result.type).toBe('')
    expect(result.raw).toBe('somethingnew')
  })

  it('reports a numeric type code as unmapped, carrying the raw value', () => {
    // Some accounts return the internal id of a list entry instead of the code. That
    // is a known unknown: better reported with the number visible than mapped to
    // whatever type happens to sit at that index.
    const result = catalog.catalogTypeFor('106', '')
    expect(result.mapped).toBe(false)
    expect(result.raw).toBe('106')
  })

  it('treats an absent type as absent, not as an error', () => {
    expect(catalog.catalogTypeFor(null, '').mapped).toBe(false)
    expect(catalog.catalogTypeFor('', '').mapped).toBe(false)
  })
})

describe('native or custom', () => {
  it('reads NetSuite’s own naming rather than a hard-coded list', () => {
    expect(catalog.originOfRecordType('customrecord_project')).toBe('custom')
    expect(catalog.originOfRecordType('customlist_status')).toBe('custom')
    expect(catalog.originOfRecordType('salesorder')).toBe('native')
    expect(catalog.originOfRecordType('customer')).toBe('native')
  })

  it('recognises every cust* field prefix, including ones not invented yet', () => {
    for (const id of [
      'custentity_x', 'custbody_x', 'custcol_x', 'custitem_x', 'custrecord_x',
      'custevent_x', 'custsomethingnew_x',
    ]) {
      expect(catalog.originOfFieldId(id), id).toBe('custom')
    }
  })

  it('does not mistake a standard field that merely starts with cust', () => {
    // `custrecord_` is custom; `customform` and `custentity` without the underscore
    // are standard fields, and calling them custom would misreport the split the
    // catalog turns on.
    expect(catalog.originOfFieldId('customform')).toBe('native')
    expect(catalog.originOfFieldId('custentity')).toBe('native')
    expect(catalog.originOfFieldId('entityid')).toBe('native')
  })
})
