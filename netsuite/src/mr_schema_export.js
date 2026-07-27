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

    /**
     * Deduplicated by type id, and not as a nicety.
     *
     * The importer treats one field described twice as a hard error and refuses the
     * *entire* file — so a single type appearing in both lists would cost the whole
     * export. `record.Type` is not supposed to contain custom records, but "supposed
     * to" is what put two wrong API surfaces in this file already.
     */
    var seen = {}
    function add(item) {
      var key = String(item.typeId).toLowerCase()
      if (!key || seen[key]) return
      seen[key] = true
      work.push(item)
    }

    // Custom types first: they carry a real label and description, which the
    // humanised enum key does not.
    if (scope === 'all' || scope === 'custom') {
      var customTypes = customFields.readCustomRecordTypes()
      for (var i = 0; i < customTypes.rows.length; i++) {
        var t = customTypes.rows[i]
        add({
          typeId: t.typeId,
          label: t.label,
          externalId: t.internalId,
          description: t.description,
          custom: true,
        })
      }
    }

    if (scope === 'all' || scope === 'standard') {
      for (var key in record.Type) {
        if (!Object.prototype.hasOwnProperty.call(record.Type, key)) continue
        add({ typeId: String(record.Type[key]), label: humanise(key), custom: false })
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
   * Metadata is read once, in `getInputData`, and carried on the work items.
   *
   * `runSuiteQL` costs 10 units. `getInputData` gets 10,000; `reduce` gets 5,000 per
   * invocation and the module cache does not survive between them, so reading here
   * would repeat the whole set for every record type. Once, at the front, is the only
   * version that fits — especially now that custom list values need one query per list.
   */
  var metadataCache = null

  function customMetadata() {
    if (!metadataCache) metadataCache = readAllMetadata()
    return metadataCache
  }

  function readAllMetadata() {
    var fields = customFields.readCustomFields()
    var recordTypes = customFields.readCustomRecordTypes()

    /**
     * Select targets arrive as integer internal ids. They are resolved against the
     * custom record types read above; an id that resolves to nothing emits **nothing**
     * rather than a fabricated name, because `toApiName(297)` would produce `_297` and
     * invent a relationship to a record type that does not exist.
     */
    var referencedLists = []
    var byScriptId = fields.byScriptId
    for (var scriptId in byScriptId) {
      if (!Object.prototype.hasOwnProperty.call(byScriptId, scriptId)) continue
      var field = byScriptId[scriptId]
      var targetId = field.selectTargetId
      if (!targetId) continue

      var resolvedType = recordTypes.byInternalId[String(targetId)]
      if (resolvedType) {
        field.selectRecordType = resolvedType
        if (String(resolvedType).toLowerCase().indexOf('customlist') === 0) {
          referencedLists.push(resolvedType)
        }
      } else if (/^customlist[a-z0-9_]*$/i.test(String(targetId))) {
        // Already a script id on accounts that give one.
        field.selectRecordType = String(targetId).toLowerCase()
        referencedLists.push(field.selectRecordType)
      } else if (/^\d+$|^-\d+$/.test(String(targetId))) {
        // A number we could not resolve — most often a standard record type, whose ids
        // are negative and are not in CustomRecordType. Recorded, never guessed at.
        field.selectRecordType = ''
        field.unresolvedTargetId = String(targetId)
      } else {
        field.selectRecordType = String(targetId).toLowerCase()
      }
    }

    var lists = customFields.readCustomListValues(referencedLists)

    return {
      byScriptId: byScriptId,
      schema: fields.schema,
      recordTypeError: recordTypes.error,
      listValues: lists.byList || {},
      listError: lists.error,
      listDiagnostics: { listsRead: lists.listsRead, perList: lists.perList },
    }
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
    var merged = mergeCustomFields(payload.fields || [], meta.byScriptId)

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
        // The join hit rate is the health metric that catches the uppercase-scriptid
        // trap: thousands of metadata rows, none of them matching anything.
        joinHits: merged.joinHits || 0,
        customFieldsSeen: countCustomFields(merged),
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

  function countCustomFields(mergedFields) {
    var found = 0
    for (var i = 0; i < mergedFields.length; i++) {
      if (mergedFields[i].origin === 'custom') found++
    }
    return found
  }

  /**
   * A metadata type only wins if it maps to something.
   *
   * `getFields()` types a custom select field correctly as `select`. If the metadata
   * column turns out to be `fieldtype` — which holds *placement* (`BODY`, `ENTITY`),
   * not a data type — letting it win would replace a correct type with one that maps to
   * nothing, and the field would import untyped. That is worse than not reading the
   * metadata at all, so a metadata value that maps to nothing is simply not used.
   */
  function preferMapped(customRaw, existingRaw) {
    if (customRaw && typeCatalog.catalogTypeFor(customRaw, '').mapped) return customRaw
    return existingRaw || customRaw || ''
  }

  /**
   * Adds what SuiteQL knows onto the fields `getFields()` already found.
   *
   * The join is on **lowercased script id**, and the lowercasing is not cosmetic:
   * `customfield` stores `scriptid` in UPPERCASE while `getFields()` returns it
   * lowercase, so joining raw produces a 0% hit rate on every account — a total failure
   * indistinguishable from "this account has no custom fields".
   *
   * Ownership comes from `getFields()`, never from the metadata. `customfield` has no
   * `appliesto*` columns and cannot answer it; the record already knows which fields
   * are on it, so there is nothing to work out.
   */
  function mergeCustomFields(standardFields, byScriptId) {
    var lookup = byScriptId || {}
    var out = []
    var hits = 0

    for (var i = 0; i < standardFields.length; i++) {
      var field = standardFields[i]
      var custom = lookup[String(field.externalId || field.apiName).toLowerCase()]

      if (!custom) {
        out.push(field)
        continue
      }

      hits++
      out.push({
        apiName: field.apiName,
        // The metadata's internal id is the stabler identifier when we have it.
        externalId: custom.internalId || field.externalId,
        label: field.label || custom.label,
        rawType: preferMapped(custom.rawFieldType, field.rawType),
        origin: 'custom',
        isRequired: field.isRequired || custom.isMandatory,
        isUnique: field.isUnique,
        isPrimaryKey: field.isPrimaryKey,
        isDeprecated: false,
        // The only two things SuiteQL is actually needed for.
        description: custom.description || '',
        selectRecordType: custom.selectRecordType || '',
      })
    }

    out.joinHits = hits
    return out
  }

  /**
   * What a select field points at, when it points at a record rather than a list.
   *
   * Three things are excluded, each for its own reason: a custom list is not a record
   * and must not become a relationship; a bare number is an unresolved internal id and
   * `toApiName(297)` would invent `_297` as a parent record that does not exist; and an
   * empty value means we never knew.
   */
  function referenceTargetOf(field) {
    var target = field.selectRecordType || ''
    if (!target) return ''
    if (String(target).toLowerCase().indexOf('customlist') === 0) return ''
    if (/^-?\d+$/.test(String(target))) return ''
    return String(target)
  }

  /**
   * Allowed values, when the select points at a custom list we could read.
   *
   * Looked up by script id only. Keying list values by internal id as well meant a
   * field whose target id happened to equal some unrelated list's id was handed that
   * list's values — wrong data, perfectly plausible, reported by nothing.
   */
  function optionsFor(field, meta) {
    var target = field.selectRecordType || ''
    if (!target) return []
    if (/^-?\d+$/.test(String(target))) return []
    return meta.listValues[String(target).toLowerCase()] || []
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
    var joinHits = 0
    var customFieldsSeen = 0

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
      joinHits += payload.joinHits || 0
      customFieldsSeen += payload.customFieldsSeen || 0
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

    var health = describeHealth({
      fields: fieldCount,
      referenceTargets: referenceTargets,
      recordTypes: groups.length,
      joinHits: joinHits,
      customFieldsSeen: customFieldsSeen,
    })
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
  function describeHealth(counts) {
    var meta = customMetadata()
    var schema = meta.schema
    var problems = []

    // --- could we read the metadata at all? Three states, not two. ---------
    if (schema.state === 'failed') {
      problems.push(
        'Custom field metadata could not be read (' +
          schema.errorClass +
          '): ' +
          schema.error +
          '. Custom fields themselves are still in this export — they come from ' +
          'getFields() on the record — but no field has a description and no reference ' +
          'target was derived from one.',
      )
    } else if (schema.state === 'empty') {
      // Neither success nor failure. An account with no custom fields and a query that
      // matched nothing look identical, so say which was observed rather than choosing.
      problems.push(
        'The ' +
          schema.table +
          ' table exists but returned no rows, so its columns could not be verified. ' +
          'Either this account has no custom fields, or the query matched nothing. ' +
          'This export contains no custom field descriptions or reference targets either way.',
      )
    }

    // --- did the two halves actually connect? -----------------------------
    if (schema.state === 'ok' && schema.rowsRead > 0) {
      var rate = counts.customFieldsSeen > 0 ? counts.joinHits / counts.customFieldsSeen : 0
      if (counts.joinHits === 0) {
        problems.push(
          schema.table +
            ' returned ' +
            schema.rowsRead +
            ' rows but not one matched a field found on a record type. The join is on ' +
            'script id — if this account stores it in a different case or shape than ' +
            'getFields() returns, every row misses and the result looks exactly like an ' +
            'account with no custom fields.',
        )
      } else if (counts.customFieldsSeen > 0 && rate < 0.5) {
        problems.push(
          'Only ' +
            counts.joinHits +
            ' of ' +
            counts.customFieldsSeen +
            ' custom fields matched a metadata row (' +
            Math.round(rate * 100) +
            '%). The rest have no description and no reference target.',
        )
      }
    }

    // --- is the column we chose for the type really the type? --------------
    //
    // `customfield` carries both `fieldvaluetype` (the type) and `fieldtype` (the
    // placement: BODY, ENTITY, COLUMN). Picking the wrong one is the single mistake
    // that would produce a confident, wholly wrong catalog rather than an empty one,
    // and nothing else here would notice — so it is checked against the values seen.
    var typeValues = schema.typeValueCounts || {}
    var distinct = 0
    var unmappedDistinct = 0
    var placementLooking = 0
    var samples = []

    for (var value in typeValues) {
      if (!Object.prototype.hasOwnProperty.call(typeValues, value)) continue
      distinct++
      if (!typeCatalog.catalogTypeFor(value, '').mapped) {
        unmappedDistinct++
        if (samples.length < 6) samples.push(value)
      }
      if (typeCatalog.isPlacementValue(value)) placementLooking++
    }

    if (distinct > 0 && (placementLooking > 0 || unmappedDistinct / distinct > 0.5)) {
      problems.push(
        'The column chosen for field data type (' +
          (schema.roles.dataType || 'none') +
          ') produced ' +
          distinct +
          ' distinct values, ' +
          unmappedDistinct +
          ' of which map to nothing: ' +
          samples.join(', ') +
          '. That is very likely the wrong column — customfield has both fieldvaluetype ' +
          '(the data type) and fieldtype (the placement: BODY, COLUMN, ENTITY). Check the ' +
          'resolution map below.',
      )
    }

    // --- roles we could not fill -------------------------------------------
    for (var u = 0; u < (schema.unresolved || []).length; u++) {
      var role = schema.unresolved[u]
      if (role.role === 'description' || role.role === 'selectTarget' || role.critical) {
        problems.push(
          'No column on ' +
            schema.table +
            ' could be used for "' +
            role.role +
            '", so that value is absent from every custom field rather than guessed.',
        )
      }
    }

    // --- the symptom that started all this ---------------------------------
    if (counts.referenceTargets === 0 && counts.fields > 0) {
      problems.push(
        'Not one reference target was found across ' +
          counts.fields +
          ' fields. The catalog derives every relationship from that column, so this CSV ' +
          'will import with NO relationships. On an account of this size that is far more ' +
          'likely to be a failed metadata read than a schema with no foreign keys.',
      )
    }

    if (meta.listError) {
      problems.push('Custom list values could not be read: ' + meta.listError)
    }
    if (meta.recordTypeError) {
      problems.push('Custom record types could not be read: ' + meta.recordTypeError)
    }

    return {
      complete: problems.length === 0,
      problems: problems,
      recordTypes: counts.recordTypes,
      fields: counts.fields,
      referenceTargets: counts.referenceTargets,
      customFieldsSeen: counts.customFieldsSeen,
      joinHits: counts.joinHits,
      schema: schema,
    }
  }

  /**
   * A companion file beside the CSV.
   *
   * The script log is the right place for detail, but nobody downloading a CSV from
   * the File Cabinet reads the script log first. A sibling file with an unmissable name
   * puts the caveat where the artifact is.
   */
  function pad(text, width) {
    var out = String(text)
    while (out.length < width) out += ' '
    return out
  }

  function writeReport(folderId, written, health, unmapped, skippedTypes) {
    var lines = []
    lines.push(health.complete ? 'EXPORT COMPLETE' : 'EXPORT INCOMPLETE — READ THIS FIRST')
    lines.push('')
    lines.push('Record types: ' + health.recordTypes)
    lines.push('Fields:       ' + health.fields)
    lines.push('Reference targets (these become relationships): ' + health.referenceTargets)
    lines.push(
      'Custom fields matched to metadata: ' +
        health.joinHits +
        ' of ' +
        health.customFieldsSeen,
    )
    lines.push('')

    for (var p = 0; p < health.problems.length; p++) {
      lines.push('PROBLEM: ' + health.problems[p])
      lines.push('')
    }

    // The resolution map. If somebody reads `dataType -> fieldtype` here they know
    // instantly why every custom field imported untyped; nothing else in the output
    // says which column was chosen for which job.
    var schema = health.schema || {}
    lines.push('Metadata source: ' + (schema.table || 'none') + ' [' + (schema.state || 'failed') + ']')
    if (schema.state === 'ok') {
      lines.push('Columns used:')
      for (var role in schema.roles) {
        if (Object.prototype.hasOwnProperty.call(schema.roles, role)) {
          lines.push('  ' + pad(role, 14) + ' -> ' + schema.roles[role])
        }
      }
      for (var ur = 0; ur < (schema.unresolved || []).length; ur++) {
        lines.push('  ' + pad(schema.unresolved[ur].role, 14) + ' -> (nothing matched)')
      }
      lines.push('')
      lines.push('Columns this account exposes: ' + (schema.columns || []).join(', '))
      lines.push('')
    }

    if (schema.error) {
      lines.push('Metadata query failed [' + schema.errorClass + ']: ' + schema.error)
      lines.push('Names tried:')
      for (var a = 0; a < (schema.attempts || []).length; a++) {
        lines.push('  ' + schema.attempts[a].name + ' -> ' + (schema.attempts[a].error || 'ok'))
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
          metadataSource: health.schema ? health.schema.table : null,
          metadataState: health.schema ? health.schema.state : null,
          columnsUsed: health.schema ? health.schema.roles : null,
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
