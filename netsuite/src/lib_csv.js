/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * CSV writing, and the header contract with the catalog's importer.
 *
 * Every header is qualified — `Record API Name`, not `Name`. The importer's
 * `field_api_name` column claims the bare alias `name`, so an unqualified `Name` binds
 * to the *field* rather than the record. That is correct behaviour on its side (in a
 * flat sheet the record columns repeat and the field columns vary), and it is exactly
 * why this side never emits a bare one.
 *
 * The header set is pinned by a test that runs the catalog's own `autoMapHeaders` over
 * it and asserts nothing is left unmapped, so a rename here cannot quietly mis-bind a
 * column on import.
 */
define([], function () {
  var HEADERS = [
    'Record API Name',
    'Record Label',
    'Record ID',
    'Record Origin',
    'Record Description',
    'Field API Name',
    'Field Label',
    'Field ID',
    'Type',
    'Field Origin',
    'Reference Target',
    'Required',
    'Unique',
    'Primary Key',
    'Deprecated',
    'Field Description',
    'Length',
    'Precision',
    'Scale',
    'Allowed Values',
  ]

  /**
   * RFC 4180 quoting.
   *
   * A field is quoted when it contains a comma, a quote, or a newline, and inner
   * quotes are doubled. NetSuite labels contain all three often enough that skipping
   * this shifts every column after the offending cell — which presents as an import
   * that "randomly" mangles unrelated fields.
   *
   * A leading BOM is deliberately *not* written here; see writeCsv().
   */
  function escapeCell(value) {
    if (value === null || value === undefined) return ''
    var text = String(value)
    if (text === '') return ''
    if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"'
    return text
  }

  function toRow(values) {
    var cells = []
    for (var i = 0; i < values.length; i++) cells.push(escapeCell(values[i]))
    return cells.join(',')
  }

  /**
   * Booleans are written as `T`/`F` — NetSuite's own spelling, and what its native
   * exports emit. The catalog's importer reads them, along with true/false/yes/no and
   * the rest; normalising here would only hide the vocabulary from the place that has
   * to handle every other exporter anyway.
   */
  function bool(value) {
    return value ? 'T' : 'F'
  }

  /** Semicolons, because commas appear inside option labels constantly. */
  function joinOptions(values) {
    if (!values || !values.length) return ''
    var cleaned = []
    for (var i = 0; i < values.length; i++) {
      var text = String(values[i] === null || values[i] === undefined ? '' : values[i]).trim()
      if (text) cleaned.push(text.replace(/;/g, ','))
    }
    return cleaned.join(';')
  }

  /** One row per field, in HEADERS order. */
  function rowFor(record, field) {
    return toRow([
      record.apiName,
      record.label,
      record.externalId,
      record.origin,
      record.description,
      field.apiName,
      field.label,
      field.externalId,
      field.type,
      field.origin,
      field.referenceTarget,
      bool(field.isRequired),
      bool(field.isUnique),
      bool(field.isPrimaryKey),
      bool(field.isDeprecated),
      field.description,
      field.length,
      field.precision,
      field.scale,
      joinOptions(field.options),
    ])
  }

  /**
   * A whole file.
   *
   * `\r\n` and a UTF-8 BOM, because the overwhelmingly likely next step is that
   * somebody opens this in Excel to eyeball it before importing — and without the BOM
   * Excel reads UTF-8 as its local codepage and mangles every accented label. Neither
   * choice bothers papaparse, which is what actually reads the file.
   */
  function writeCsv(rows) {
    var lines = [toRow(HEADERS)]
    for (var i = 0; i < rows.length; i++) lines.push(rows[i])
    return '﻿' + lines.join('\r\n') + '\r\n'
  }

  return {
    HEADERS: HEADERS,
    escapeCell: escapeCell,
    toRow: toRow,
    bool: bool,
    joinOptions: joinOptions,
    rowFor: rowFor,
    writeCsv: writeCsv,
  }
})
