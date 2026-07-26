/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * Maps NetSuite's field types onto the catalog's.
 *
 * NetSuite has *two* vocabularies for the same idea and they are not interchangeable:
 *
 *   - `Field.type` from N/record is lowercase: `text`, `checkbox`, `select`
 *   - custom field metadata (SuiteQL, SDF) is uppercase: `TEXT`, `CHECKBOX`, `SELECT`
 *
 * Some also carry a trailing digit (`currency2`, `float2`) for the second column of a
 * paired field. Normalising to uppercase-without-digits collapses all of that into one
 * lookup, so there is a single table to keep correct rather than two that can disagree.
 *
 * An unmapped type is reported rather than guessed. Guessing wrong writes a type into
 * the catalog that nobody chose; emitting nothing at least shows up as a gap. The
 * export counts what it could not map so one run tells you what to add here.
 */
define([], function () {
  /**
   * NetSuite type -> catalog type key.
   *
   * The right-hand side must be a key the catalog actually has (see
   * BUILTIN_DATA_TYPES in shared/constants.ts) or the import silently drops the type.
   * There is a test asserting exactly that.
   */
  var TYPE_MAP = {
    // --- text ---
    TEXT: 'text',
    PHONE: 'text',
    TIMEOFDAY: 'text',
    PASSWORD: 'text',
    KEY: 'text',
    CCNUMBER: 'text',
    IDENTIFIER: 'text',
    LABEL: 'text',
    COLOR: 'text',

    // Long text and rich text both land near `long_text`: the catalog does not model
    // markup, and pretending it does would claim a distinction it cannot express.
    TEXTAREA: 'long_text',
    RICHTEXT: 'long_text',
    LONGTEXT: 'long_text',
    CLOBTEXT: 'long_text',
    INLINEHTML: 'long_text',
    HELP: 'long_text',

    EMAIL: 'email',
    URL: 'url',

    // --- numeric ---
    INTEGER: 'integer',
    FLOAT: 'decimal',
    PERCENT: 'decimal',
    RATE: 'decimal',
    RATEHIGHPRECISION: 'decimal',
    SUMMARY: 'decimal',
    CURRENCY: 'currency',
    CURRENCYHIGHPRECISION: 'currency',

    // --- boolean ---
    CHECKBOX: 'boolean',

    // --- temporal ---
    DATE: 'date',
    DATETIME: 'datetime',
    DATETIMETZ: 'datetime',

    // --- choice ---
    // A select becomes `reference` instead when it names a record — see
    // catalogTypeFor(), which needs the target to decide.
    SELECT: 'enum',
    RADIO: 'enum',
    MULTISELECT: 'multi_enum',

    // --- complex ---
    IMAGE: 'binary',
    DOCUMENT: 'binary',
    FILE: 'binary',
  }

  /** Types that are a link when they point at a record, and a picklist otherwise. */
  var SELECT_TYPES = { SELECT: true, MULTISELECT: true, RADIO: true }

  /**
   * Both vocabularies, and the paired-column suffix, reduced to one spelling.
   * `currency2` and `CURRENCY` must not be two different answers.
   */
  function normaliseTypeName(raw) {
    if (raw === null || raw === undefined) return ''
    return String(raw)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .replace(/[0-9]+$/, '')
  }

  /**
   * The catalog type for a NetSuite field.
   *
   * `referenceTarget` decides between a picklist and a link: a select naming a record
   * type *is* the foreign key, and typing it `enum` would hide every relationship the
   * export is meant to carry.
   */
  function catalogTypeFor(rawType, referenceTarget) {
    var key = normaliseTypeName(rawType)
    if (!key) return { type: '', mapped: false, raw: rawType }

    if (SELECT_TYPES[key] && referenceTarget) {
      return {
        type: key === 'MULTISELECT' ? 'multi_enum' : 'reference',
        mapped: true,
        raw: rawType,
      }
    }

    var mapped = TYPE_MAP[key]
    if (!mapped) return { type: '', mapped: false, raw: rawType }
    return { type: mapped, mapped: true, raw: rawType }
  }

  /** Does this field type carry a link at all, target or not? */
  function isSelectType(rawType) {
    return Boolean(SELECT_TYPES[normaliseTypeName(rawType)])
  }

  /**
   * Native or custom, decided by NetSuite's own naming rather than by a list.
   *
   * Every custom record type is `customrecord*` (or `customlist*`), and every custom
   * field id carries a `cust` prefix — `custentity_`, `custbody_`, `custcol_`,
   * `custitem_`, `custrecord_`, `custevent_`. Enumerating the prefixes would go stale
   * the moment NetSuite adds a segment type; the `cust` + `_` shape does not.
   */
  function originOfRecordType(typeId) {
    var id = String(typeId || '').toLowerCase()
    return id.indexOf('customrecord') === 0 || id.indexOf('customlist') === 0
      ? 'custom'
      : 'native'
  }

  function originOfFieldId(fieldId) {
    var id = String(fieldId || '').toLowerCase()
    return /^cust[a-z]*_/.test(id) ? 'custom' : 'native'
  }

  return {
    TYPE_MAP: TYPE_MAP,
    normaliseTypeName: normaliseTypeName,
    catalogTypeFor: catalogTypeFor,
    isSelectType: isSelectType,
    originOfRecordType: originOfRecordType,
    originOfFieldId: originOfFieldId,
  }
})
