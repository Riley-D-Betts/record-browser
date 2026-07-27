/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * Custom field metadata, read through SuiteQL — and discovered rather than assumed.
 *
 * Two rounds of guessing were wrong on a real account, so this module is built the
 * other way round: it asks what exists, records what it was told, and reports which
 * column it chose for each job. The reasoning behind each decision is written down
 * here because the wrong versions of them were all extremely plausible.
 *
 * **The seven per-type tables do not exist.** `entitycustomfield`, `itemcustomfield`,
 * `transactionbodycustomfield`, `transactioncolumncustomfield`, `crmcustomfield`,
 * `othercustomfield` and `customrecordcustomfield` are SDF-XML and SuiteTalk-SOAP
 * customization type names. Oracle's Records Browser marks all seven `inAnalytics:"F"`.
 * They are not SuiteQL tables under any spelling, and a production account confirmed it
 * with "Invalid search type: entityCustomField" for every one.
 *
 * **`customfield` — singular, unified — is the real table**, and it is the only one
 * used here.
 *
 * **It has no `appliesto*` columns, and that turns out not to matter.** The reason the
 * per-type tables were wanted was to answer "which record owns this field?". SuiteQL
 * cannot answer that — but `getFields()` already does, because a custom field is a real
 * field on the record. So this module answers only the narrower question SuiteQL *can*
 * answer: given a field's script id, what are its description, data type and select
 * target? The exporter joins the two on script id. That deletes every guess about
 * ownership.
 */
define(['N/query'], function (query) {
  /** Tried in order. Resolution is case-insensitive, so this is belt and braces. */
  var CANDIDATES = ['customfield', 'CustomField']

  /**
   * Which discovered column does each job.
   *
   * Order matters twice over. Within a role, earlier candidates win. Across roles, a
   * column can satisfy **at most one** — and that exclusivity is load-bearing, not
   * tidiness. Without it `selectTarget` falls through to `recordtype`, which holds the
   * *owner's* internal id, and every field on record type 297 would be handed the
   * allowed values of whichever custom list happens to be internal id 297. Wrong data,
   * entirely plausible, reported by nothing.
   */
  var ROLES = [
    { role: 'scriptId', candidates: ['scriptid'], critical: true },
    { role: 'internalId', candidates: ['internalid', 'id'] },
    { role: 'label', candidates: ['name', 'label'] },
    { role: 'description', candidates: ['description'] },
    /** The record that owns the field. Read for diagnostics; never used to attribute. */
    { role: 'ownerRecord', candidates: ['recordtype', 'rectype'] },
    /**
     * The record a select field points at — an integer internal id, not a script id.
     * `fieldvaluetyperecord` is the real column; `selectrecordtype` is the SDF-XML name
     * and is kept only so an account that does expose it still works.
     */
    { role: 'selectTarget', candidates: ['fieldvaluetyperecord', 'selectrecordtype'] },
    /**
     * The data type — and the single most dangerous line in this file.
     *
     * `customfield` has BOTH `fieldvaluetype` (the actual type: TEXT, SELECT, CHECKBOX)
     * and `fieldtype` (the *placement*: BODY, COLUMN, ENTITY). Picking `fieldtype`
     * yields values that map to nothing, and because the exporter previously let the
     * metadata type override the one from `getFields()`, a field correctly typed
     * `select` would have been overwritten with `ENTITY` and imported with no type at
     * all — worse than not reading the metadata. `fieldvaluetype` first, always, and
     * `describeHealth` cross-checks the value domain in case this is still wrong.
     */
    { role: 'dataType', candidates: ['fieldvaluetype', 'fieldtype'], critical: true },
    { role: 'mandatory', candidates: ['ismandatory', 'mandatory'] },
  ]

  // -------------------------------------------------------------------------
  // Talking to SuiteQL
  // -------------------------------------------------------------------------

  /**
   * What a failure actually means.
   *
   * "Unknown identifier" is a *success* signal about the table — it resolved, and only
   * the column was wrong. The previous version threw that distinction away and reported
   * "this account does not have it", which is a different problem with a different fix.
   * A permission error is a third thing again, and must never be reported as absence.
   */
  function classify(message) {
    if (!message) return 'ok'
    if (/invalid search type|invalid record type|unknown table|does not exist/i.test(message)) {
      return 'no-such-table'
    }
    if (/unknown identifier|invalid identifier|unsupported search field/i.test(message)) {
      return 'table-exists-bad-column'
    }
    if (/permission|insufficient|not authorized|not permitted/i.test(message)) {
      return 'denied'
    }
    return 'unclassified'
  }

  function runSuiteQL(sql) {
    try {
      return { rows: query.runSuiteQL({ query: sql }).asMappedResults(), error: null, errorClass: 'ok' }
    } catch (e) {
      var message = e && e.message ? e.message : String(e)
      return { rows: [], error: message, errorClass: classify(message) }
    }
  }

  /**
   * Oracle's SuiteQL notes warn that result column names "may not always be consistent
   * and can change" and that casing must not be depended on. So every key is lowercased
   * once, here, rather than each read site carrying its own list of casings — which is
   * how `SCRIPTID` came to be handled in one place and not two others.
   */
  function lowerKeys(row) {
    var out = {}
    for (var key in row) {
      if (Object.prototype.hasOwnProperty.call(row, key)) out[String(key).toLowerCase()] = row[key]
    }
    return out
  }

  /**
   * `SELECT *`, never a column list, and deliberately no `FETCH FIRST`.
   *
   * A named column the account lacks fails the *entire* statement — a real run lost
   * every custom list value to `SELECT id … FROM CustomList`. And an unsupported LIMIT
   * clause would fail indistinguishably from a missing table, which would poison the
   * discovery this whole module rests on.
   */
  function selectAll(table) {
    var result = runSuiteQL('SELECT * FROM ' + table)
    var rows = []
    for (var i = 0; i < result.rows.length; i++) rows.push(lowerKeys(result.rows[i]))
    return { rows: rows, error: result.error, errorClass: result.errorClass }
  }

  function probe(candidates) {
    var attempts = []
    for (var i = 0; i < candidates.length; i++) {
      var result = selectAll(candidates[i])
      attempts.push({
        name: candidates[i],
        ok: !result.error,
        rows: result.rows.length,
        error: result.error,
        errorClass: result.errorClass,
      })
      if (!result.error) return { name: candidates[i], rows: result.rows, attempts: attempts }
    }
    return { name: null, rows: [], attempts: attempts }
  }

  function worstError(attempts) {
    for (var i = attempts.length - 1; i >= 0; i--) {
      if (attempts[i].error) return { error: attempts[i].error, errorClass: attempts[i].errorClass }
    }
    return { error: 'No candidate table name resolved', errorClass: 'unclassified' }
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  function columnsOf(rows) {
    var columns = {}
    if (!rows.length) return columns
    for (var key in rows[0]) {
      if (Object.prototype.hasOwnProperty.call(rows[0], key)) columns[key] = true
    }
    return columns
  }

  function resolveRoles(columns) {
    var map = {}
    var claimed = {}
    var unresolved = []

    for (var i = 0; i < ROLES.length; i++) {
      var spec = ROLES[i]
      var hit = null
      for (var c = 0; c < spec.candidates.length; c++) {
        var candidate = spec.candidates[c]
        if (columns[candidate] && !claimed[candidate]) {
          hit = candidate
          break
        }
      }
      if (hit) {
        map[spec.role] = hit
        claimed[hit] = spec.role
      } else {
        unresolved.push({ role: spec.role, critical: Boolean(spec.critical) })
      }
    }

    return { map: map, unresolved: unresolved }
  }

  /**
   * What this account has, decided once.
   *
   * `state` has three values, not two. "The table exists but returned no rows" is
   * neither success nor failure: the columns could not be verified, so nothing can be
   * promised about fidelity — but an account genuinely without custom fields looks
   * exactly the same, and only saying which was observed tells them apart.
   */
  function discoverSchema() {
    var found = probe(CANDIDATES)

    if (!found.name) {
      var failure = worstError(found.attempts)
      return {
        table: null,
        state: 'failed',
        columns: [],
        roles: {},
        unresolved: [],
        rows: [],
        attempts: found.attempts,
        error: failure.error,
        errorClass: failure.errorClass,
      }
    }

    if (!found.rows.length) {
      return {
        table: found.name,
        state: 'empty',
        columns: [],
        roles: {},
        unresolved: [],
        rows: [],
        attempts: found.attempts,
        error: null,
        errorClass: 'ok',
      }
    }

    var columns = columnsOf(found.rows)
    var resolved = resolveRoles(columns)
    var columnList = []
    for (var key in columns) {
      if (Object.prototype.hasOwnProperty.call(columns, key)) columnList.push(key)
    }

    return {
      table: found.name,
      state: 'ok',
      columns: columnList.sort(),
      roles: resolved.map,
      unresolved: resolved.unresolved,
      rows: found.rows,
      attempts: found.attempts,
      error: null,
      errorClass: 'ok',
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  function valueOf(row, roles, role) {
    var column = roles[role]
    if (!column) return ''
    var value = row[column]
    return value === undefined || value === null ? '' : value
  }

  function isTruthyFlag(value) {
    if (value === true) return true
    if (value === 1) return true
    var text = String(value === null || value === undefined ? '' : value).trim().toUpperCase()
    return text === 'T' || text === 'TRUE' || text === 'YES' || text === '1'
  }

  /**
   * Every custom field, keyed by lowercased script id.
   *
   * Lowercased because `customfield` stores `scriptid` in UPPERCASE while `getFields()`
   * returns it lowercase. Joining them raw produces a 0% hit rate on every account —
   * a total failure that looks identical to "this account has no custom fields".
   */
  function readCustomFields() {
    var schema = discoverSchema()
    var byScriptId = {}
    var typeValueCounts = {}

    for (var i = 0; i < schema.rows.length; i++) {
      var row = schema.rows[i]
      var scriptId = String(valueOf(row, schema.roles, 'scriptId')).toLowerCase()
      if (!scriptId) continue

      var rawType = valueOf(row, schema.roles, 'dataType')
      if (rawType !== '') {
        var key = String(rawType)
        typeValueCounts[key] = (typeValueCounts[key] || 0) + 1
      }

      byScriptId[scriptId] = {
        scriptId: scriptId,
        internalId: String(valueOf(row, schema.roles, 'internalId')),
        label: String(valueOf(row, schema.roles, 'label')),
        description: String(valueOf(row, schema.roles, 'description')),
        rawFieldType: rawType,
        isMandatory: isTruthyFlag(valueOf(row, schema.roles, 'mandatory')),
        /** An integer internal id. Resolved to a name by the caller, or dropped. */
        selectTargetId: String(valueOf(row, schema.roles, 'selectTarget')),
        ownerRecordId: String(valueOf(row, schema.roles, 'ownerRecord')),
      }
    }

    return {
      byScriptId: byScriptId,
      schema: {
        table: schema.table,
        state: schema.state,
        columns: schema.columns,
        roles: schema.roles,
        unresolved: schema.unresolved,
        attempts: schema.attempts,
        error: schema.error,
        errorClass: schema.errorClass,
        rowsRead: schema.rows.length,
        /** Feeds the "is that really the type column?" check in the export report. */
        typeValueCounts: typeValueCounts,
      },
    }
  }

  /** Custom record types, and the internal-id -> script-id map select targets need. */
  function readCustomRecordTypes() {
    var found = probe(['CustomRecordType', 'customrecordtype'])
    var rows = []
    var byInternalId = {}

    for (var i = 0; i < found.rows.length; i++) {
      var row = found.rows[i]
      var scriptId = row.scriptid
      if (!scriptId) continue
      var internalId = String(row.internalid === undefined ? (row.id === undefined ? '' : row.id) : row.internalid)
      var entry = {
        typeId: String(scriptId).toLowerCase(),
        internalId: internalId,
        label: String(row.name || row.recordname || scriptId),
        description: String(row.description || ''),
      }
      rows.push(entry)
      if (internalId) byInternalId[internalId] = entry.typeId
    }

    var failure = found.name ? { error: null, errorClass: 'ok' } : worstError(found.attempts)
    return {
      rows: rows,
      byInternalId: byInternalId,
      error: failure.error,
      errorClass: failure.errorClass,
      attempts: found.attempts,
    }
  }

  /**
   * Custom list values.
   *
   * **There is no `CustomListValue` table.** Each list's values live in their own table
   * named after the list's script id — `SELECT * FROM CUSTOMLIST_BED_SIZE`. That means
   * a table name interpolated from account data, so it is whitelisted against a strict
   * pattern before being put anywhere near a query.
   *
   * Only lists something actually points at are read. On an account with hundreds of
   * lists that is the difference between a handful of queries and hundreds, and it
   * means every failure reported is a failure that mattered.
   *
   * Keyed by script id only. Keying by internal id as well is what let an unrelated
   * list's values attach to fields that merely shared a number.
   */
  function readCustomListValues(referencedScriptIds) {
    var lists = probe(['CustomList', 'customlist'])
    if (!lists.name) {
      var failure = worstError(lists.attempts)
      return { byList: {}, error: failure.error, errorClass: failure.errorClass, attempts: lists.attempts, listsRead: 0 }
    }

    var wanted = {}
    for (var w = 0; w < (referencedScriptIds || []).length; w++) {
      wanted[String(referencedScriptIds[w]).toLowerCase()] = true
    }

    var byList = {}
    var perList = []

    for (var i = 0; i < lists.rows.length; i++) {
      var scriptId = lists.rows[i].scriptid
      if (!scriptId) continue
      var key = String(scriptId).toLowerCase()
      if (!wanted[key]) continue

      // The one place a table name comes from data. Anything but a plain custom list
      // id is refused rather than escaped — there is no legitimate case for the rest.
      if (!/^customlist[a-z0-9_]*$/.test(key)) {
        perList.push({ list: key, ok: false, error: 'Refused: not a plain custom list id' })
        continue
      }

      var values = selectAll(key)
      if (values.error) {
        perList.push({ list: key, ok: false, error: values.error, errorClass: values.errorClass })
        continue
      }

      var members = []
      for (var v = 0; v < values.rows.length; v++) {
        var row = values.rows[v]
        if (isTruthyFlag(row.isinactive)) continue
        var name = row.name === undefined ? row.value : row.name
        if (name !== undefined && name !== null && String(name) !== '') members.push(String(name))
      }

      byList[key] = members
      perList.push({ list: key, ok: true, values: members.length })
    }

    return { byList: byList, error: null, errorClass: 'ok', attempts: lists.attempts, listsRead: perList.length, perList: perList }
  }

  return {
    CANDIDATES: CANDIDATES,
    ROLES: ROLES,
    classify: classify,
    lowerKeys: lowerKeys,
    resolveRoles: resolveRoles,
    discoverSchema: discoverSchema,
    readCustomFields: readCustomFields,
    readCustomRecordTypes: readCustomRecordTypes,
    readCustomListValues: readCustomListValues,
    isTruthyFlag: isTruthyFlag,
  }
})
