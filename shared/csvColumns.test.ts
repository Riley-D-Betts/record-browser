import { describe, expect, it } from 'vitest'
import {
  COLUMNS,
  autoMapHeaders,
  coerceBoolean,
  coerceOrigin,
  detectShape,
} from './csvColumns'

/**
 * The CSV vocabulary is a contract with every exporter anyone will ever point at this
 * thing. Until now it was only covered indirectly, which is how `T`/`F` — the values
 * NetSuite, Postgres and Salesforce all emit — ended up being rejected outright.
 */

const kindOf = (r: ReturnType<typeof coerceBoolean>) => r.kind
const valueOf = (r: ReturnType<typeof coerceBoolean>) =>
  r.kind === 'value' ? r.value : r.kind

describe('booleans', () => {
  it('accepts the vocabularies real exporters actually emit', () => {
    for (const yes of ['true', 'T', 't', 'yes', 'Y', '1', 'x', '✓', 'checked', 'on', 'enabled']) {
      expect(valueOf(coerceBoolean(yes)), yes).toBe(true)
    }
    for (const no of ['false', 'F', 'f', 'no', 'N', '0', 'off', 'disabled', 'unchecked']) {
      expect(valueOf(coerceBoolean(no)), no).toBe(false)
    }
  })

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(valueOf(coerceBoolean('  TRUE  '))).toBe(true)
    expect(valueOf(coerceBoolean('Yes'))).toBe(true)
  })

  it('reads no-data markers as blank rather than as false', () => {
    // Recording "N/A" as `false` would state something the spreadsheet never said.
    for (const marker of ['N/A', 'n/a', 'null', 'none', 'nil', '-', '—', '(blank)', '?']) {
      expect(kindOf(coerceBoolean(marker)), marker).toBe('blank')
    }
  })

  it('reports genuinely unreadable values without pretending to understand them', () => {
    const r = coerceBoolean('Conditionally required')
    expect(r.kind).toBe('unreadable')
    if (r.kind === 'unreadable') expect(r.message).toContain('Conditionally required')
  })
})

describe('origin', () => {
  it('reads a literal origin column', () => {
    expect(valueOf(coerceOrigin('native'))).toBe('native')
    expect(valueOf(coerceOrigin('Standard'))).toBe('native')
    expect(valueOf(coerceOrigin('custom'))).toBe('custom')
  })

  it('reads a "Custom?" checkbox column, including T/F', () => {
    expect(valueOf(coerceOrigin('T'))).toBe('custom')
    expect(valueOf(coerceOrigin('F'))).toBe('native')
    expect(valueOf(coerceOrigin('true'))).toBe('custom')
  })

  it('treats a no-data marker as blank rather than guessing native', () => {
    expect(kindOf(coerceOrigin('N/A'))).toBe('blank')
    expect(kindOf(coerceOrigin('-'))).toBe('blank')
  })
})

describe('integers', () => {
  const coerceLength = COLUMNS.find((c) => c.key === 'field_length')!.coerce!

  it('accepts what a spreadsheet actually puts in a length column', () => {
    expect(valueOf(coerceLength('255') as never)).toBe(255)
    expect(valueOf(coerceLength('1,000') as never)).toBe(1000)
    expect(valueOf(coerceLength('255 chars') as never)).toBe(255)
  })

  it('reads no-data markers as blank', () => {
    expect(kindOf(coerceLength('N/A') as never)).toBe('blank')
  })

  it('refuses a negative or fractional length', () => {
    expect(kindOf(coerceLength('-5') as never)).toBe('unreadable')
    expect(kindOf(coerceLength('10.5') as never)).toBe('unreadable')
  })
})

describe('allowed values', () => {
  const coerceOptions = COLUMNS.find((c) => c.key === 'field_options')!.coerce!

  it('splits on semicolon, pipe and newline but not comma', () => {
    // Commas appear inside option labels far too often to be a separator.
    expect(valueOf(coerceOptions('a;b|c\nd') as never)).toEqual(['a', 'b', 'c', 'd'])
    expect(valueOf(coerceOptions('Smith, John;Doe, Jane') as never)).toEqual([
      'Smith, John',
      'Doe, Jane',
    ])
  })

  it('is blank when nothing survives the split', () => {
    expect(kindOf(coerceOptions(' ; ; ') as never)).toBe('blank')
  })
})

describe('header auto-mapping', () => {
  /**
   * The exact header set the NetSuite exporter emits. If this ever stops mapping
   * cleanly the export silently mis-binds a column, so it is pinned here rather than
   * left to a manual check.
   */
  const EXPORTER_HEADERS = [
    'Record API Name', 'Record Label', 'Record ID', 'Record Origin', 'Record Description',
    'Field API Name', 'Field Label', 'Field ID', 'Type', 'Field Origin',
    'Reference Target', 'Required', 'Unique', 'Primary Key', 'Deprecated',
    'Field Description', 'Length', 'Precision', 'Scale', 'Allowed Values',
  ]

  it('maps every header the exporter emits, with none left over', () => {
    const mapping = autoMapHeaders(EXPORTER_HEADERS)
    const unmapped = EXPORTER_HEADERS.filter((h) => !mapping[h])
    expect(unmapped).toEqual([])
  })

  it('binds each exporter header to the column it is meant for', () => {
    const m = autoMapHeaders(EXPORTER_HEADERS)
    expect(m['Record API Name']).toBe('record_api_name')
    expect(m['Field API Name']).toBe('field_api_name')
    expect(m['Record ID']).toBe('record_external_id')
    expect(m['Field ID']).toBe('field_external_id')
    expect(m['Reference Target']).toBe('field_reference_target')
    expect(m['Allowed Values']).toBe('field_options')
  })

  it('reads an unqualified Name as the field, which is why the exporter qualifies', () => {
    // In a flat sheet the record columns repeat and the field columns vary, so the
    // unqualified one is nearly always the field. Documented here so the exporter's
    // insistence on qualified headers has a reason attached.
    expect(autoMapHeaders(['Name'])['Name']).toBe('field_api_name')
  })

  it('tolerates the punctuation and casing real exports arrive with', () => {
    const m = autoMapHeaders(['object_name', 'FIELD LABEL', 'Custom?', 'Data-Type'])
    expect(m['object_name']).toBe('record_api_name')
    expect(m['FIELD LABEL']).toBe('field_label')
    expect(m['Custom?']).toBe('field_origin')
    expect(m['Data-Type']).toBe('field_type')
  })

  it('leaves a header it does not recognise unmapped rather than guessing', () => {
    expect(autoMapHeaders(['Some Internal Column'])['Some Internal Column']).toBeNull()
  })

  it('never binds two headers to the same column', () => {
    const m = autoMapHeaders(['Field Name', 'Name', 'API Name'])
    const claimed = Object.values(m).filter(Boolean)
    expect(new Set(claimed).size).toBe(claimed.length)
  })
})

describe('shape detection', () => {
  it('is a field sheet when fields are named', () => {
    expect(detectShape(['record_api_name', 'field_api_name'])).toBe('fields')
  })

  it('is a record sheet otherwise', () => {
    expect(detectShape(['record_api_name', 'record_label'])).toBe('records')
  })
})
