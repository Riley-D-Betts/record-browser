import { describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import { loadAmd } from './amd'
import { autoMapHeaders, detectShape, COLUMNS } from '../../shared/csvColumns'

const csv = loadAmd('src/lib_csv.js')

/**
 * The contract between the two halves.
 *
 * These run the *catalog's own* header matcher over the *exporter's own* header list,
 * so the two cannot drift without a failing test. Checking it by eye is exactly how a
 * column ends up silently bound to the wrong field.
 */

describe('the header contract', () => {
  it('maps every header the exporter emits, with none left over', () => {
    const mapping = autoMapHeaders(csv.HEADERS)
    const unmapped = csv.HEADERS.filter((h: string) => !mapping[h])
    expect(unmapped).toEqual([])
  })

  it('binds each header to the column it is meant for', () => {
    const m = autoMapHeaders(csv.HEADERS)
    expect(m['Record API Name']).toBe('record_api_name')
    expect(m['Record ID']).toBe('record_external_id')
    expect(m['Record Origin']).toBe('record_origin')
    expect(m['Field API Name']).toBe('field_api_name')
    expect(m['Field ID']).toBe('field_external_id')
    expect(m['Field Origin']).toBe('field_origin')
    expect(m['Type']).toBe('field_type')
    expect(m['Reference Target']).toBe('field_reference_target')
    expect(m['Allowed Values']).toBe('field_options')
  })

  it('qualifies every header, because a bare Name binds to the field', () => {
    // `field_api_name` claims the alias `name`, so an unqualified header would attach
    // to the field rather than the record. Correct on the importer's side; the reason
    // this side never emits one.
    expect(autoMapHeaders(['Name'])['Name']).toBe('field_api_name')
    for (const header of csv.HEADERS) {
      expect(/^(Record|Field|Type|Reference|Required|Unique|Primary|Deprecated|Length|Precision|Scale|Allowed)/.test(header), header).toBe(true)
    }
  })

  it('is read as a field sheet, so fields import rather than only records', () => {
    const mapped = Object.values(autoMapHeaders(csv.HEADERS)).filter(Boolean) as string[]
    expect(detectShape(mapped)).toBe('fields')
  })

  it('emits a header for every column it fills, in the same order', () => {
    // rowFor() writes positionally; a header added without a value (or the reverse)
    // shifts every column after it.
    const row = csv.rowFor(
      { apiName: 'a', label: 'b', externalId: 'c', origin: 'native', description: 'd' },
      {
        apiName: 'e', label: 'f', externalId: 'g', type: 'text', origin: 'custom',
        referenceTarget: 'h', isRequired: true, isUnique: false, isPrimaryKey: false,
        isDeprecated: false, description: 'i', length: 1, precision: 2, scale: 3,
        options: ['j'],
      },
    )
    expect(row.split(',')).toHaveLength(csv.HEADERS.length)
  })
})

describe('quoting survives a papaparse round trip', () => {
  const parse = (text: string) =>
    Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
    })

  it('carries a label containing a comma through unharmed', () => {
    // NetSuite labels contain commas constantly; unquoted, they shift every column
    // after the offending cell, which presents as an import mangling unrelated fields.
    const content = csv.writeCsv([
      csv.rowFor(
        { apiName: 'Customer', label: 'Customer', externalId: '', origin: 'native', description: '' },
        { apiName: 'Name', label: 'Last, First', externalId: '', type: 'text', origin: 'native',
          referenceTarget: '', isRequired: true, isUnique: false, isPrimaryKey: false,
          isDeprecated: false, description: '', length: '', precision: '', scale: '', options: [] },
      ),
    ])
    const parsed = parse(content)
    expect(parsed.errors).toEqual([])
    expect(parsed.data[0]!['Field Label']).toBe('Last, First')
  })

  it('carries quotes and newlines through unharmed', () => {
    const content = csv.writeCsv([
      csv.rowFor(
        { apiName: 'R', label: 'R', externalId: '', origin: 'native', description: '' },
        { apiName: 'F', label: 'He said "hi"', externalId: '', type: 'text', origin: 'native',
          referenceTarget: '', isRequired: false, isUnique: false, isPrimaryKey: false,
          isDeprecated: false, description: 'line one\nline two', length: '', precision: '',
          scale: '', options: [] },
      ),
    ])
    const parsed = parse(content)
    expect(parsed.errors).toEqual([])
    expect(parsed.data[0]!['Field Label']).toBe('He said "hi"')
    expect(parsed.data[0]!['Field Description']).toBe('line one\nline two')
  })

  it('writes a BOM, so Excel does not mangle accented labels', () => {
    expect(csv.writeCsv([]).charCodeAt(0)).toBe(0xfeff)
  })
})

describe('the cells themselves', () => {
  it('writes booleans as T/F, which the importer reads', () => {
    // NetSuite's own spelling. The importer handles it — that was the point of
    // widening its vocabulary rather than normalising here.
    expect(csv.bool(true)).toBe('T')
    expect(csv.bool(false)).toBe('F')

    const coerce = COLUMNS.find((c) => c.key === 'field_required')!.coerce!
    expect(coerce('T')).toMatchObject({ kind: 'value', value: true })
    expect(coerce('F')).toMatchObject({ kind: 'value', value: false })
  })

  it('separates allowed values with semicolons, not commas', () => {
    // Commas appear inside option labels far too often to separate on.
    expect(csv.joinOptions(['A', 'B'])).toBe('A;B')
    const coerce = COLUMNS.find((c) => c.key === 'field_options')!.coerce!
    expect(coerce(csv.joinOptions(['Smith, John', 'Doe, Jane']))).toMatchObject({
      kind: 'value',
      value: ['Smith, John', 'Doe, Jane'],
    })
  })

  it('replaces a semicolon inside an option rather than splitting the option in two', () => {
    expect(csv.joinOptions(['a;b'])).toBe('a,b')
  })

  it('writes an absent value as empty, not as the word null', () => {
    expect(csv.escapeCell(null)).toBe('')
    expect(csv.escapeCell(undefined)).toBe('')
  })
})
