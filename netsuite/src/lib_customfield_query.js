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
    { kind: 'entity', candidates: ['entitycustomfield', 'EntityCustomField'] },
    { kind: 'item', candidates: ['itemcustomfield', 'ItemCustomField'] },
    {
      kind: 'transactionBody',
      candidates: ['transactionbodycustomfield', 'TransactionBodyCustomField'],
    },
    {
      kind: 'transactionColumn',
      // `transactioncolumnfield` is NetSuite's own name for this one in several places
      // — it is the one table in the set whose name does not follow the pattern.
      candidates: [
        'transactioncolumncustomfield',
        'transactioncolumnfield',
        'TransactionColumnCustomField',
      ],
    },
    { kind: 'crm', candidates: ['crmcustomfield', 'CrmCustomField'] },
    { kind: 'other', candidates: ['othercustomfield', 'OtherCustomField'] },
    {
      kind: 'customRecord',
      candidates: ['customrecordcustomfield', 'customrecordfield', 'CustomRecordCustomField'],
    },
  ]

  /**
   * Tried before the per-type tables: if one unified table exists, it answers
   * everything at once and the seven separate probes never run.
   */
  var UNIFIED_CANDIDATES = ['customfield', 'CustomField']

  /**
   * Columns every custom-field table is expected to carry.
   *
   * `selectrecordtype` is what makes a select field a relationship, so it matters more
   * than the rest — but it is also the one most likely to be absent, hence the retry
   * below with a reduced list.
   */
  function runSuiteQL(sql) {
    try {
      return { rows: query.runSuiteQL({ query: sql }).asMappedResults(), error: null }
    } catch (e) {
      return { rows: [], error: e && e.message ? e.message : String(e) }
    }
  }

  /**
   * `SELECT *`, never a column list.
   *
   * A named column that the account does not have fails the *entire* statement — a
   * real run died on `SELECT id … FROM CustomList` with "Unknown identifier 'ID'",
   * losing every custom list value over one guessed name. Asking for everything and
   * reading what comes back cannot fail that way, and these are metadata tables of
   * hundreds of rows, not millions, so the cost of the extra columns is nothing.
   *
   * `normaliseField` below then takes what it recognises and ignores the rest, which
   * is the shape that survives an account whose schema differs from the one we expect.
   */
  function selectAll(table) {
    return runSuiteQL('SELECT * FROM ' + table)
  }

  /**
   * Find which of several candidate names this account actually has.
   *
   * A real run rejected all seven per-type custom field tables with "Invalid search
   * type: entityCustomField", while `CustomRecordType` worked — in PascalCase — so
   * resolution is not case-sensitive and those names simply are not tables here.
   * Guessing a different spelling a third time is not a strategy; asking is.
   *
   * Every attempt is recorded, including the failures, because the error text is the
   * only thing that says *why* — and `&debug=1` exists to put it in front of someone.
   */
  function probe(candidates) {
    var attempts = []
    for (var i = 0; i < candidates.length; i++) {
      var result = selectAll(candidates[i])
      attempts.push({
        name: candidates[i],
        ok: !result.error,
        rows: result.rows.length,
        error: result.error,
      })
      if (!result.error) {
        return { name: candidates[i], rows: result.rows, attempts: attempts }
      }
    }
    return { name: null, rows: [], attempts: attempts }
  }

  function readTable(spec) {
    var found = probe(spec.candidates)
    return {
      rows: found.rows,
      kind: spec.kind,
      resolvedName: found.name,
      attempts: found.attempts,
      // The last attempt's error is the informative one when nothing resolved.
      error: found.name ? null : lastError(found.attempts),
    }
  }

  function lastError(attempts) {
    for (var i = attempts.length - 1; i >= 0; i--) {
      if (attempts[i].error) return attempts[i].error
    }
    return 'No candidate table name resolved'
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
    var diagnostics = { tables: [], rawSample: [], unified: null }

    // One unified table, if this account has one, saves seven probes.
    var unified = probe(UNIFIED_CANDIDATES)
    diagnostics.unified = { resolved: unified.name, attempts: unified.attempts }
    if (unified.name && unified.rows.length) {
      diagnostics.rawSample.push({ table: unified.name, row: unified.rows[0] })
      for (var u = 0; u < unified.rows.length; u++) {
        var unifiedOwners = ownersOf(unified.rows[u], 'unified')
        for (var uo = 0; uo < unifiedOwners.length; uo++) {
          if (!byRecord[unifiedOwners[uo]]) byRecord[unifiedOwners[uo]] = []
          byRecord[unifiedOwners[uo]].push(normaliseField(unified.rows[u]))
        }
      }
      diagnostics.tables.push({
        table: unified.name,
        rows: unified.rows.length,
        attempts: unified.attempts,
        error: null,
      })
      return { byRecord: byRecord, diagnostics: diagnostics }
    }

    for (var i = 0; i < TABLES.length; i++) {
      var result = readTable(TABLES[i])
      diagnostics.tables.push({
        table: result.resolvedName || TABLES[i].candidates[0],
        kind: TABLES[i].kind,
        rows: result.rows.length,
        // Every name tried, with the error each gave. This is what makes a third wrong
        // guess unnecessary: the next fix is aimed by data, not by another hunch.
        attempts: result.attempts,
        error: result.error,
      })
      if (result.rows.length && diagnostics.rawSample.length < 10) {
        diagnostics.rawSample.push({ table: result.resolvedName, row: result.rows[0] })
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
    if (kind === 'customRecord' || kind === 'unified') {
      var rectype = pick(row, ['rectype', 'recordtype', 'recType', 'owner', 'customrecordtype'])
      if (rectype) return [String(rectype).toLowerCase()]
      // A unified table row that names no record type still has appliesto flags to
      // fall back on, so this deliberately does not return early.
      if (kind === 'customRecord') return []
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
    var fieldType = pick(row, ['fieldtype', 'fieldType', 'type', 'customfieldtype'])
    return {
      internalId: String(pick(row, ['internalid', 'id', 'recordid'])),
      scriptId: String(pick(row, ['scriptid', 'scriptId'])),
      label: String(pick(row, ['label', 'name', 'fieldlabel'])),
      rawFieldType: fieldType === '' ? '' : fieldType,
      description: String(pick(row, ['description', 'help', 'helptext'])),
      isMandatory: isTruthyFlag(pick(row, ['ismandatory', 'mandatory', 'isrequired'])),
      selectRecordType: String(
        pick(row, ['selectrecordtype', 'selectRecordType', 'recordtype', 'sourcelist']),
      ),
    }
  }

  /**
   * A value under any of several possible column names.
   *
   * Which name a table uses is exactly the thing that has been wrong twice, so nothing
   * reads a column by a single hard-coded name any more.
   */
  function pick(row, names) {
    for (var i = 0; i < names.length; i++) {
      var value = row[names[i]]
      if (value !== undefined && value !== null && value !== '') return value
    }
    return ''
  }

  /** Custom record types: the ones that are records in their own right. */
  function readCustomRecordTypes() {
    var found = probe(['CustomRecordType', 'customrecordtype'])
    var rows = []

    for (var i = 0; i < found.rows.length; i++) {
      var row = found.rows[i]
      var scriptId = pick(row, ['scriptid', 'scriptId', 'SCRIPTID'])
      if (!scriptId) continue
      rows.push({
        typeId: String(scriptId).toLowerCase(),
        internalId: String(pick(row, ['internalid', 'id', 'recordid'])),
        label: String(pick(row, ['name', 'recordname', 'label']) || scriptId),
        description: String(pick(row, ['description'])),
      })
    }

    return { rows: rows, error: found.name ? null : lastError(found.attempts), attempts: found.attempts }
  }

  /**
   * Custom list values, so a picklist exports the choices it actually offers.
   *
   * Keyed by the list's script id *and* its internal id, because `selectrecordtype` on
   * a field points at one or the other depending on where the metadata came from.
   */
  function readCustomListValues() {
    var lists = probe(['CustomList', 'customlist'])
    if (!lists.name) {
      return { byList: {}, error: lastError(lists.attempts), attempts: lists.attempts }
    }

    var values = probe(['CustomListValue', 'customlistvalue', 'customlist_value'])
    if (!values.name) {
      return { byList: {}, error: lastError(values.attempts), attempts: values.attempts }
    }

    var byInternalId = {}
    for (var v = 0; v < values.rows.length; v++) {
      var value = values.rows[v]
      if (isTruthyFlag(pick(value, ['isinactive', 'inactive']))) continue
      var listId = String(pick(value, ['list', 'listid', 'customlist', 'parent']))
      var name = String(pick(value, ['name', 'value', 'label']))
      if (!listId || !name) continue
      if (!byInternalId[listId]) byInternalId[listId] = []
      byInternalId[listId].push(name)
    }

    // Keyed by both, because `selectrecordtype` on a field points at one or the other
    // depending on where the metadata came from.
    var byList = {}
    for (var l = 0; l < lists.rows.length; l++) {
      var list = lists.rows[l]
      var internalId = String(pick(list, ['internalid', 'id', 'recordid']))
      var scriptId = pick(list, ['scriptid', 'scriptId'])
      var members = byInternalId[internalId] || []
      if (internalId) byList[internalId] = members
      if (scriptId) byList[String(scriptId).toLowerCase()] = members
    }

    return { byList: byList, error: null, attempts: lists.attempts.concat(values.attempts) }
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
