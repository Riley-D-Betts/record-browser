/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope Public
 *
 * Enumerates this account's record types and their fields, and writes CSV the
 * Technical Records Browser imports directly.
 *
 * Why Map/Reduce and not a Suitelet. A Suitelet gets 1,000 usage units. Instantiating
 * one record type to read its fields costs roughly 5, and there are around 200 standard
 * types — about 1,250 units before any custom records. Map/Reduce gets 10,000 per job
 * and, more usefully, resets governance per `map` call, so one awkward record type
 * cannot starve the rest. The Suitelet that pairs with this (sl_schema_export.js) only
 * starts the job and serves the result.
 *
 * The one fidelity limit worth knowing up front: `getFields()` on a record built with
 * `record.create` returns fewer fields than one built with `record.load`, because
 * sourcing-dependent fields are not materialised until there is data to source from.
 * Loading an arbitrary real record of every type is not something an export should do,
 * so standard-record coverage is a very good approximation rather than a guarantee.
 * Custom fields do not have this problem — they come from SuiteQL, which sees all of
 * them.
 */
define([
  'N/record',
  'N/runtime',
  'N/file',
  'N/log',
  './lib_type_catalog',
  './lib_customfield_query',
  './lib_csv',
], function (record, runtime, file, log, typeCatalog, customFields, csv) {
  /** Matches the importer's own ceiling, so every part is independently importable. */
  var MAX_ROWS_PER_FILE = 15000

  function scriptParam(name, fallback) {
    try {
      var value = runtime.getCurrentScript().getParameter({ name: name })
      return value === null || value === undefined || value === '' ? fallback : value
    } catch (e) {
      return fallback
    }
  }

  // -------------------------------------------------------------------------
  // getInputData — decide what to walk
  // -------------------------------------------------------------------------

  /**
   * The work list: one entry per record type.
   *
   * Custom record types come from SuiteQL because `record.Type` does not contain them.
   * Standard types come from `record.Type` itself, which is the only enumeration of
   * them that stays current with the account's version.
   */
  function getInputData() {
    var scope = String(scriptParam('custscript_trb_scope', 'all'))
    var work = []

    if (scope === 'all' || scope === 'standard') {
      for (var key in record.Type) {
        if (!Object.prototype.hasOwnProperty.call(record.Type, key)) continue
        work.push({ typeId: String(record.Type[key]), label: humanise(key), custom: false })
      }
    }

    if (scope === 'all' || scope === 'custom') {
      var customTypes = customFields.readCustomRecordTypes()
      for (var i = 0; i < customTypes.rows.length; i++) {
        var t = customTypes.rows[i]
        work.push({
          typeId: t.typeId,
          label: t.label,
          externalId: t.internalId,
          description: t.description,
          custom: true,
        })
      }
    }

    return work
  }

  /** `SALES_ORDER` -> `Sales Order`. Only a fallback; custom types bring real names. */
  function humanise(enumKey) {
    return String(enumKey)
      .toLowerCase()
      .split('_')
      .map(function (word) {
        return word ? word.charAt(0).toUpperCase() + word.slice(1) : word
      })
      .join(' ')
  }

  // -------------------------------------------------------------------------
  // map — one record type per call
  // -------------------------------------------------------------------------

  /**
   * `record.create` throws for a great many types — system types with no user-facing
   * form, types behind a feature the account has not enabled, subrecord-only types.
   * That is expected, not exceptional, so each is wrapped and the failure is emitted as
   * a skip. A run that died on the first unavailable type would never finish anywhere.
   */
  function map(context) {
    var work = JSON.parse(context.value)

    var describedRecord = {
      apiName: toApiName(work.typeId),
      label: work.label || work.typeId,
      externalId: work.externalId || work.typeId,
      origin: typeCatalog.originOfRecordType(work.typeId),
      description: work.description || '',
    }

    var fields = []
    var skipped = null

    try {
      fields = readStandardFields(work.typeId)
    } catch (e) {
      skipped = e && e.message ? e.message : String(e)
    }

    context.write({
      key: work.typeId,
      value: JSON.stringify({
        record: describedRecord,
        fields: fields,
        skipped: skipped,
        custom: work.custom,
      }),
    })
  }

  /**
   * Fields on an instantiated record.
   *
   * `getFields()` returns field *id strings*, not objects — a detail worth stating
   * because treating them as objects fails silently, producing a field list of
   * `undefined` labels rather than an error. `getField({fieldId})` then gives the
   * object, which carries `id`, `label`, `type` and `isMandatory` and — notably — no
   * `description`. Descriptions therefore only ever come from custom-field metadata.
   */
  function readStandardFields(typeId) {
    var instance = record.create({ type: typeId, isDynamic: false })
    var ids = instance.getFields() || []
    var out = []

    for (var i = 0; i < ids.length; i++) {
      var fieldId = ids[i]
      var field = null
      try {
        field = instance.getField({ fieldId: fieldId })
      } catch (e) {
        field = null
      }
      if (!field) continue

      out.push({
        apiName: toApiName(fieldId),
        externalId: fieldId,
        label: field.label || fieldId,
        rawType: field.type || '',
        origin: typeCatalog.originOfFieldId(fieldId),
        isRequired: Boolean(field.isMandatory),
        // NetSuite exposes neither uniqueness nor a primary-key notion on a Field, and
        // inventing them from the id would be a guess. `internalid` is the one honest
        // exception: it is the primary key of every record type in the product.
        isUnique: fieldId === 'internalid',
        isPrimaryKey: fieldId === 'internalid',
        isDeprecated: false,
        description: '',
        options: [],
      })
    }

    return out
  }

  /**
   * NetSuite ids are already legal technical names save for one case: a custom record
   * type id can contain a dot in some accounts, which the catalog's grammar allows, and
   * nothing else needs touching. Anything that would still be illegal has its offending
   * characters replaced rather than being dropped, so the row still imports.
   */
  function toApiName(id) {
    var text = String(id || '').trim()
    if (!text) return ''
    var cleaned = text.replace(/[^A-Za-z0-9_.]/g, '_')
    return /^[A-Za-z_]/.test(cleaned) ? cleaned : '_' + cleaned
  }

  // -------------------------------------------------------------------------
  // reduce — fold custom metadata onto each record type
  // -------------------------------------------------------------------------

  /**
   * Custom fields are read once here rather than per `map` call.
   *
   * Reading them inside `map` would repeat seven SuiteQL statements for every one of
   * ~200 record types. Read once and cached per execution context, it is seven
   * statements total.
   */
  var customCache = null

  function customMetadata() {
    if (!customCache) {
      var fields = customFields.readCustomFields()
      var lists = customFields.readCustomListValues()
      customCache = {
        byRecord: fields.byRecord,
        diagnostics: fields.diagnostics,
        listValues: lists.byList || {},
        listError: lists.error,
      }
    }
    return customCache
  }

  function reduce(context) {
    var payload = JSON.parse(context.values[0])
    var meta = customMetadata()
    var unmapped = {}

    /**
     * A type that could not be instantiated is not a type we know nothing about —
     * SuiteQL has already told us its custom fields, and those are usually the ones
     * somebody wants catalogued. Discarding them because `record.create` refused would
     * throw away metadata we are holding. The skip is still reported either way.
     */
    var merged = mergeCustomFields(
      payload.fields || [],
      meta.byRecord[String(context.key).toLowerCase()],
    )

    if (payload.skipped && merged.length === 0) {
      context.write({
        key: context.key,
        value: JSON.stringify({ skipped: payload.skipped, record: payload.record, rows: [] }),
      })
      return
    }

    var rows = []

    for (var i = 0; i < merged.length; i++) {
      var field = merged[i]
      var target = referenceTargetOf(field)
      var resolved = typeCatalog.catalogTypeFor(field.rawType, target)

      if (!resolved.mapped && field.rawType) {
        unmapped[String(field.rawType)] = (unmapped[String(field.rawType)] || 0) + 1
      }

      rows.push(
        csv.rowFor(payload.record, {
          apiName: field.apiName,
          label: field.label,
          externalId: field.externalId,
          type: resolved.type,
          origin: field.origin,
          referenceTarget: target ? toApiName(target) : '',
          isRequired: field.isRequired,
          isUnique: field.isUnique,
          isPrimaryKey: field.isPrimaryKey,
          isDeprecated: field.isDeprecated,
          description: field.description,
          length: '',
          precision: '',
          scale: '',
          options: optionsFor(field, meta),
        }),
      )
    }

    context.write({
      key: context.key,
      value: JSON.stringify({
        rows: rows,
        unmapped: unmapped,
        skipped: null,
        // Counted so `summarize` can tell "this schema genuinely has no relationships"
        // apart from "we could not read the metadata that names them" — which look
        // identical in the CSV and mean completely different things.
        referenceTargets: countReferenceTargets(merged),
      }),
    })
  }

  function countReferenceTargets(mergedFields) {
    var found = 0
    for (var i = 0; i < mergedFields.length; i++) {
      if (referenceTargetOf(mergedFields[i])) found++
    }
    return found
  }

  /**
   * Custom fields override the instantiated ones of the same id.
   *
   * Both sources can describe the same field — a custom field appears in `getFields()`
   * too — but only SuiteQL carries the description and the select target. Overriding
   * rather than appending is what stops every custom field arriving twice.
   */
  function mergeCustomFields(standardFields, customList) {
    var byApiName = {}
    var order = []

    for (var i = 0; i < standardFields.length; i++) {
      var field = standardFields[i]
      byApiName[field.apiName] = field
      order.push(field.apiName)
    }

    var extras = customList || []
    for (var c = 0; c < extras.length; c++) {
      var custom = extras[c]
      if (!custom.scriptId) continue
      var apiName = toApiName(custom.scriptId)
      var existing = byApiName[apiName]

      var merged = {
        apiName: apiName,
        externalId: custom.internalId || custom.scriptId,
        label: custom.label || (existing && existing.label) || custom.scriptId,
        rawType: custom.rawFieldType || (existing && existing.rawType) || '',
        origin: 'custom',
        isRequired: custom.isMandatory || (existing ? existing.isRequired : false),
        isUnique: existing ? existing.isUnique : false,
        isPrimaryKey: existing ? existing.isPrimaryKey : false,
        isDeprecated: false,
        description: custom.description || '',
        selectRecordType: custom.selectRecordType || '',
        options: [],
      }

      byApiName[apiName] = merged
      if (!existing) order.push(apiName)
    }

    var out = []
    for (var o = 0; o < order.length; o++) out.push(byApiName[order[o]])
    return out
  }

  /**
   * What a select field points at, when it points at a record rather than a list.
   *
   * `selectrecordtype` holds either — a custom list is not a record and must not become
   * a relationship, or the import would invent a parent that does not exist. Custom
   * lists are recognised by their `customlist` prefix and excluded.
   */
  function referenceTargetOf(field) {
    var target = field.selectRecordType || ''
    if (!target) return ''
    if (String(target).toLowerCase().indexOf('customlist') === 0) return ''
    if (/^\d+$/.test(String(target))) return ''
    return String(target)
  }

  /** Allowed values, when the select points at a custom list we could read. */
  function optionsFor(field, meta) {
    var target = field.selectRecordType || ''
    if (!target) return []
    var key = String(target).toLowerCase()
    return meta.listValues[key] || meta.listValues[String(target)] || []
  }

  // -------------------------------------------------------------------------
  // summarize — write the files
  // -------------------------------------------------------------------------

  /**
   * Files are split on record-type boundaries, never mid-record.
   *
   * A record whose fields straddled two files would import as two records — or worse,
   * as one record missing half its fields, with no error. Splitting only between types
   * makes every part independently importable, which is the property that matters when
   * somebody imports part 3 of 4 by accident.
   */
  function summarize(context) {
    var folderId = scriptParam('custscript_trb_folder', -15) // -15 = SuiteScripts
    var groups = []
    var unmapped = {}
    var skippedTypes = []
    var referenceTargets = 0
    var fieldCount = 0

    context.output.iterator().each(function (key, value) {
      var payload = JSON.parse(value)
      if (payload.skipped) {
        skippedTypes.push({ typeId: key, reason: payload.skipped })
        return true
      }
      if (payload.rows && payload.rows.length) {
        groups.push(payload.rows)
        fieldCount += payload.rows.length
      }
      referenceTargets += payload.referenceTargets || 0
      for (var raw in payload.unmapped || {}) {
        if (!Object.prototype.hasOwnProperty.call(payload.unmapped, raw)) continue
        unmapped[raw] = (unmapped[raw] || 0) + payload.unmapped[raw]
      }
      return true
    })

    var parts = splitOnRecordBoundaries(groups, MAX_ROWS_PER_FILE)
    var written = []

    for (var i = 0; i < parts.length; i++) {
      var name =
        parts.length === 1
          ? 'record-browser-export.csv'
          : 'record-browser-export-' + (i + 1) + '-of-' + parts.length + '.csv'

      var handle = file.create({
        name: name,
        fileType: file.Type.CSV,
        contents: csv.writeCsv(parts[i]),
        folder: folderId,
      })
      written.push({ name: name, id: handle.save(), rows: parts[i].length })
    }

    var health = describeHealth(fieldCount, referenceTargets, groups.length)
    writeReport(folderId, written, health, unmapped, skippedTypes)
    logSummary(written, unmapped, skippedTypes, health, context)
  }

  /**
   * What this export is actually missing, in words.
   *
   * A run against a real account rejected every custom-field table ("Invalid search
   * type: entityCustomField") and still wrote a large, wholly plausible CSV: every
   * record type, every field, and silently **no relationships and no descriptions at
   * all**. Nothing said so. Someone importing that would reasonably conclude their
   * schema has no relationships, which is a false statement about their account rather
   * than a gap in ours.
   *
   * So the export now decides, and says, whether it is complete — and an empty
   * reference-target count is treated as a symptom rather than as an answer.
   */
  function describeHealth(fieldCount, referenceTargets, recordCount) {
    var meta = customMetadata()
    var failed = []
    var ok = []

    for (var i = 0; i < meta.diagnostics.tables.length; i++) {
      var table = meta.diagnostics.tables[i]
      if (table.error) failed.push({ table: table.table, error: table.error })
      else ok.push(table.table)
    }

    var problems = []
    if (failed.length && failed.length === meta.diagnostics.tables.length) {
      problems.push(
        'No custom field metadata could be read at all. Custom fields themselves are ' +
          'still in this export — they come from getFields() on the record — but their ' +
          'descriptions are missing, and so is every reference target.',
      )
    } else if (failed.length) {
      problems.push(
        failed.length +
          ' of ' +
          meta.diagnostics.tables.length +
          ' custom field metadata queries failed, so this export is missing descriptions ' +
          'and reference targets for the record types they cover.',
      )
    }

    if (referenceTargets === 0 && fieldCount > 0) {
      problems.push(
        'Not one reference target was found across ' +
          fieldCount +
          ' fields. The catalog derives every relationship from that column, so this CSV ' +
          'will import with NO relationships. On an account of this size that is far more ' +
          'likely to be a failed metadata read than a schema with no foreign keys.',
      )
    }

    if (meta.listError) {
      problems.push('Custom list values could not be read: ' + meta.listError)
    }

    return {
      complete: problems.length === 0,
      problems: problems,
      recordTypes: recordCount,
      fields: fieldCount,
      referenceTargets: referenceTargets,
      metadataTablesRead: ok,
      metadataTablesFailed: failed,
    }
  }

  /**
   * A companion file beside the CSV.
   *
   * The script log is the right place for detail, but nobody downloading a CSV from
   * the File Cabinet reads the script log first. A sibling file with an unmissable name
   * puts the caveat where the artifact is.
   */
  function writeReport(folderId, written, health, unmapped, skippedTypes) {
    var lines = []
    lines.push(health.complete ? 'EXPORT COMPLETE' : 'EXPORT INCOMPLETE — READ THIS FIRST')
    lines.push('')
    lines.push('Record types: ' + health.recordTypes)
    lines.push('Fields:       ' + health.fields)
    lines.push('Reference targets (these become relationships): ' + health.referenceTargets)
    lines.push('')

    for (var p = 0; p < health.problems.length; p++) {
      lines.push('PROBLEM: ' + health.problems[p])
      lines.push('')
    }

    if (health.metadataTablesFailed.length) {
      lines.push('Metadata queries that failed:')
      for (var f = 0; f < health.metadataTablesFailed.length; f++) {
        lines.push(
          '  ' +
            health.metadataTablesFailed[f].table +
            ' -> ' +
            health.metadataTablesFailed[f].error,
        )
      }
      lines.push('')
      lines.push('Run the Suitelet with &debug=1 to see what this account does support.')
      lines.push('')
    }

    var unmappedNames = []
    for (var raw in unmapped) {
      if (Object.prototype.hasOwnProperty.call(unmapped, raw)) {
        unmappedNames.push('  ' + raw + ' (' + unmapped[raw] + ' fields)')
      }
    }
    if (unmappedNames.length) {
      lines.push('Field types with no mapping — these imported with no type:')
      lines.push(unmappedNames.join('\n'))
      lines.push('')
    }

    if (skippedTypes.length) {
      lines.push(skippedTypes.length + ' record types could not be read:')
      for (var s = 0; s < Math.min(skippedTypes.length, 40); s++) {
        lines.push('  ' + skippedTypes[s].typeId + ' -> ' + skippedTypes[s].reason)
      }
      if (skippedTypes.length > 40) lines.push('  … and ' + (skippedTypes.length - 40) + ' more')
      lines.push('')
    }

    lines.push('Files written:')
    for (var w = 0; w < written.length; w++) {
      lines.push('  ' + written[w].name + ' (' + written[w].rows + ' rows)')
    }

    try {
      file
        .create({
          name: health.complete
            ? 'record-browser-export-REPORT.txt'
            : 'record-browser-export-INCOMPLETE-README.txt',
          fileType: file.Type.PLAINTEXT,
          contents: lines.join('\n'),
          folder: folderId,
        })
        .save()
    } catch (e) {
      // The report is a courtesy; failing to write it must not lose the export itself.
      log.error({ title: 'Could not write the export report', details: String(e) })
    }
  }

  /**
   * Greedy packing that will overflow rather than split a record type.
   *
   * A single record type with more rows than the limit still gets its own file — over
   * the cap, and stated in the log. Better one oversized-but-correct file than a
   * record silently cut in half to respect a number.
   */
  function splitOnRecordBoundaries(groups, maxRows) {
    var parts = []
    var current = []

    for (var i = 0; i < groups.length; i++) {
      var group = groups[i]
      if (current.length && current.length + group.length > maxRows) {
        parts.push(current)
        current = []
      }
      for (var r = 0; r < group.length; r++) current.push(group[r])
    }

    if (current.length) parts.push(current)
    return parts.length ? parts : [[]]
  }

  function logSummary(written, unmapped, skippedTypes, health, context) {
    log.audit({
      title: health.complete ? 'Schema export complete' : 'Schema export finished, but incomplete',
      details: JSON.stringify({
        files: written,
        skippedTypes: skippedTypes.length,
        recordTypes: health.recordTypes,
        fields: health.fields,
        referenceTargets: health.referenceTargets,
      }),
    })

    // Logged at error level on purpose. This is the difference between a CSV that
    // describes the account and one that quietly describes half of it.
    if (!health.complete) {
      log.error({
        title: 'This export is incomplete — see the README file written beside the CSV',
        details: JSON.stringify({
          problems: health.problems,
          metadataTablesFailed: health.metadataTablesFailed,
        }),
      })
    }

    // Unmapped types are the actionable output: each one is a field that imported with
    // no type at all. Named with a count so the first run tells you what to add to
    // lib_type_catalog.js.
    var unmappedList = []
    for (var raw in unmapped) {
      if (Object.prototype.hasOwnProperty.call(unmapped, raw)) {
        unmappedList.push({ type: raw, fields: unmapped[raw] })
      }
    }
    if (unmappedList.length) {
      log.error({
        title: 'Field types with no mapping — these fields imported without a type',
        details: JSON.stringify(unmappedList),
      })
    }

    if (context.inputSummary && context.inputSummary.error) {
      log.error({ title: 'Input stage error', details: context.inputSummary.error })
    }
  }

  return {
    getInputData: getInputData,
    map: map,
    reduce: reduce,
    summarize: summarize,
    // Exported for tests; not part of the Map/Reduce contract.
    _internal: {
      toApiName: toApiName,
      humanise: humanise,
      mergeCustomFields: mergeCustomFields,
      referenceTargetOf: referenceTargetOf,
      splitOnRecordBoundaries: splitOnRecordBoundaries,
    },
  }
})
