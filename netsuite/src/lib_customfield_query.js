/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * Custom metadata, read through SuiteQL.
 *
 * The obvious route — `search.create({type: search.Type.ENTITY_CUSTOM_FIELD})` — does
 * not work: those enum members do not exist, and code referencing them throws on the
 * first line. The custom-field tables in SuiteQL are documented and do.
 *
 * Everything here is defensive on purpose. Column availability varies by account,
 * feature set and version, and a single unavailable column fails the *whole* query.
 * So each table is queried independently, a failure is recorded rather than thrown,
 * and the run continues with whatever did come back. An export missing descriptions is
 * worth having; an export that died on row one is not.
 */
define(['N/query'], function (query) {
  /**
   * The concrete custom-field tables.
   *
   * There is a `CustomField` view that unions these, but its column set is the
   * intersection of theirs and it omits the `appliesto*` flags entirely — which are
   * the only thing that says *which* record a field belongs to. So they are queried
   * separately, and the `owner` function below is what turns each table's own way of
   * saying "belongs to" into a record type.
   */
  var TABLES = [
    { table: 'entityCustomField', kind: 'entity' },
    { table: 'itemCustomField', kind: 'item' },
    { table: 'transactionBodyCustomField', kind: 'transactionBody' },
    { table: 'transactionColumnCustomField', kind: 'transactionColumn' },
    { table: 'crmCustomField', kind: 'crm' },
    { table: 'otherCustomField', kind: 'other' },
    { table: 'customRecordCustomField', kind: 'customRecord' },
  ]

  /**
   * Columns every custom-field table is expected to carry.
   *
   * `selectrecordtype` is what makes a select field a relationship, so it matters more
   * than the rest — but it is also the one most likely to be absent, hence the retry
   * below with a reduced list.
   */
  var CORE_COLUMNS = [
    'internalid',
    'scriptid',
    'label',
    'fieldtype',
    'description',
    'ismandatory',
    'selectrecordtype',
  ]

  var MINIMAL_COLUMNS = ['internalid', 'scriptid', 'label', 'fieldtype']

  function runSuiteQL(sql) {
    try {
      return { rows: query.runSuiteQL({ query: sql }).asMappedResults(), error: null }
    } catch (e) {
      return { rows: [], error: e && e.message ? e.message : String(e) }
    }
  }

  /**
   * One table, with a reduced retry.
   *
   * SuiteQL fails the entire statement on one unknown column, so "ask for everything
   * and see" would return nothing at all on an account missing a single field. Asking
   * again for the four columns that certainly exist turns a total loss into a partial
   * one.
   */
  function readTable(spec) {
    var full = runSuiteQL('SELECT ' + CORE_COLUMNS.join(', ') + ' FROM ' + spec.table)
    if (!full.error) return { rows: full.rows, kind: spec.kind, degraded: false, error: null }

    var minimal = runSuiteQL('SELECT ' + MINIMAL_COLUMNS.join(', ') + ' FROM ' + spec.table)
    return {
      rows: minimal.rows,
      kind: spec.kind,
      degraded: !minimal.error,
      // The first failure is the informative one: it names the column that is missing.
      error: minimal.error ? minimal.error : full.error,
    }
  }

  /**
   * Every custom field in the account, grouped by the record type that owns it.
   *
   * Returns `{ byRecord, diagnostics }`. `diagnostics` carries per-table errors and a
   * sample of raw rows so one run with `&debug=1` is enough to see what this account
   * actually returns — see the note on `fieldtype` below.
   */
  function readCustomFields() {
    var byRecord = {}
    var diagnostics = { tables: [], rawSample: [] }

    for (var i = 0; i < TABLES.length; i++) {
      var result = readTable(TABLES[i])
      diagnostics.tables.push({
        table: TABLES[i].table,
        rows: result.rows.length,
        degraded: result.degraded,
        error: result.error,
      })
      if (result.rows.length && diagnostics.rawSample.length < 10) {
        diagnostics.rawSample.push({ table: TABLES[i].table, row: result.rows[0] })
      }

      for (var r = 0; r < result.rows.length; r++) {
        var row = result.rows[r]
        var owners = ownersOf(row, result.kind)
        for (var o = 0; o < owners.length; o++) {
          if (!byRecord[owners[o]]) byRecord[owners[o]] = []
          byRecord[owners[o]].push(normaliseField(row))
        }
      }
    }

    return { byRecord: byRecord, diagnostics: diagnostics }
  }

  /**
   * Which record types a custom field belongs to.
   *
   * Only `customRecordCustomField` answers this cleanly, via `rectype`. The others
   * spread it across a wide row of `appliesto*` booleans whose exact names vary — and
   * which the reduced-column retry above may not have fetched at all. Rather than hard
   * code names that might be wrong, every key beginning `appliesto` is read off
   * whatever came back and the suffix is used as the record type. If a name is wrong,
   * it produces no owner rather than a wrong one, and `&debug=1` shows the real keys.
   */
  function ownersOf(row, kind) {
    if (kind === 'customRecord') {
      var rectype = row.rectype || row.recordtype || row.recType
      return rectype ? [String(rectype)] : []
    }

    var owners = []
    for (var key in row) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) continue
      if (key.toLowerCase().indexOf('appliesto') !== 0) continue
      if (!isTruthyFlag(row[key])) continue
      var suffix = key.toLowerCase().slice('appliesto'.length)
      if (suffix) owners.push(suffix)
    }
    return owners
  }

  function isTruthyFlag(value) {
    if (value === true) return true
    if (value === 1) return true
    var text = String(value === null || value === undefined ? '' : value).trim().toUpperCase()
    return text === 'T' || text === 'TRUE' || text === 'YES' || text === '1'
  }

  /**
   * One custom field, in the shape the exporter uses.
   *
   * `fieldtype` is the field this module is least sure about: depending on the table
   * and the account it comes back as the uppercase code (`TEXT`) or as the internal id
   * of a list entry (`106`). Both are carried through untouched — `rawFieldType` keeps
   * whatever arrived — and the type catalog maps the code while reporting a numeric id
   * as unmapped. That way a numeric account shows up as a counted, named gap on the
   * first run instead of as silently wrong types.
   */
  function normaliseField(row) {
    return {
      internalId: row.internalid !== undefined ? String(row.internalid) : '',
      scriptId: row.scriptid ? String(row.scriptid) : '',
      label: row.label ? String(row.label) : '',
      rawFieldType: row.fieldtype !== undefined && row.fieldtype !== null ? row.fieldtype : '',
      description: row.description ? String(row.description) : '',
      isMandatory: isTruthyFlag(row.ismandatory),
      selectRecordType:
        row.selectrecordtype !== undefined && row.selectrecordtype !== null
          ? String(row.selectrecordtype)
          : '',
    }
  }

  /** Custom record types: the ones that are records in their own right. */
  function readCustomRecordTypes() {
    var result = runSuiteQL(
      'SELECT internalid, scriptid, name, description FROM CustomRecordType',
    )
    var rows = []
    for (var i = 0; i < result.rows.length; i++) {
      var row = result.rows[i]
      if (!row.scriptid) continue
      rows.push({
        typeId: String(row.scriptid).toLowerCase(),
        internalId: row.internalid !== undefined ? String(row.internalid) : '',
        label: row.name ? String(row.name) : String(row.scriptid),
        description: row.description ? String(row.description) : '',
      })
    }
    return { rows: rows, error: result.error }
  }

  /**
   * Custom list values, so a picklist exports the choices it actually offers.
   *
   * Keyed by the list's script id *and* its internal id, because `selectrecordtype` on
   * a field points at one or the other depending on where the metadata came from.
   */
  function readCustomListValues() {
    var lists = runSuiteQL('SELECT id, scriptid, name FROM CustomList')
    if (lists.error) return { byList: {}, error: lists.error }

    var values = runSuiteQL('SELECT list, name, isinactive FROM CustomListValue')
    if (values.error) return { byList: {}, error: values.error }

    var byInternalId = {}
    for (var v = 0; v < values.rows.length; v++) {
      var value = values.rows[v]
      if (isTruthyFlag(value.isinactive)) continue
      var listId = String(value.list)
      if (!byInternalId[listId]) byInternalId[listId] = []
      byInternalId[listId].push(String(value.name))
    }

    var byList = {}
    for (var l = 0; l < lists.rows.length; l++) {
      var list = lists.rows[l]
      var members = byInternalId[String(list.id)] || []
      byList[String(list.id)] = members
      if (list.scriptid) byList[String(list.scriptid).toLowerCase()] = members
    }

    return { byList: byList, error: null }
  }

  return {
    TABLES: TABLES,
    readCustomFields: readCustomFields,
    readCustomRecordTypes: readCustomRecordTypes,
    readCustomListValues: readCustomListValues,
    ownersOf: ownersOf,
    normaliseField: normaliseField,
    isTruthyFlag: isTruthyFlag,
  }
})
