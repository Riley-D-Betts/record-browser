import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fakeFile, fakeLog, fakeQuery, fakeRecord, fakeRuntime, loadAmd } from './amd'
import { createDb, dataTypes, fields, records, relationships } from '../../server/db'
import { ensureBuiltinLists } from '../../server/services/lists'
import { applyCsvImport, planCsvImport } from '../../server/services/csvImport'
import { autoMapHeaders } from '../../shared/csvColumns'
import { BUILTIN_DATA_TYPES } from '../../shared/constants'

/**
 * The end the exporter actually exists for: run the Map/Reduce against a fake account,
 * take the CSV it writes, and import it into a real catalog database.
 *
 * Everything between is the deployed code — the same files that upload to NetSuite,
 * loaded through an AMD shim rather than reimplemented. What cannot be checked here is
 * whether NetSuite returns the shapes these fakes assume; that is stated in the README
 * rather than papered over.
 */

// --- a small account -------------------------------------------------------

const ACCOUNT = {
  customer: [
    { id: 'internalid', label: 'Internal ID', type: 'integer' },
    { id: 'entityid', label: 'Customer ID', type: 'text', isMandatory: true },
    { id: 'companyname', label: 'Company Name', type: 'text' },
    { id: 'email', label: 'Email', type: 'email' },
    { id: 'isinactive', label: 'Inactive', type: 'checkbox' },
    { id: 'datecreated', label: 'Date Created', type: 'datetimetz' },
  ],
  salesorder: [
    { id: 'internalid', label: 'Internal ID', type: 'integer' },
    { id: 'tranid', label: 'Document Number', type: 'text', isMandatory: true },
    { id: 'entity', label: 'Customer', type: 'select' },
    { id: 'total', label: 'Amount', type: 'currency' },
    { id: 'memo', label: 'Memo, with a comma', type: 'textarea' },
  ],
  // Present in record.Type but not instantiable — the common case this must survive.
  bintransfer: [],
}

const CUSTOM_FIELDS = {
  entityCustomField: [
    {
      internalid: 501,
      scriptid: 'custentity_loyalty_tier',
      label: 'Loyalty Tier',
      fieldtype: 'SELECT',
      description: 'Which tier this customer sits in',
      ismandatory: 'F',
      selectrecordtype: 'customlist_tiers',
      appliestocustomer: 'T',
    },
  ],
  transactionBodyCustomField: [
    {
      internalid: 502,
      scriptid: 'custbody_delivery_window',
      label: 'Delivery Window',
      fieldtype: 'TEXT',
      description: '',
      ismandatory: 'T',
      selectrecordtype: '',
      appliestosalesorder: 'T',
    },
  ],
  customRecordCustomField: [
    {
      internalid: 503,
      scriptid: 'custrecord_project_customer',
      label: 'Customer',
      fieldtype: 'SELECT',
      description: 'Who the project is for',
      ismandatory: 'T',
      selectrecordtype: 'customer',
      rectype: 'customrecord_project',
    },
  ],
  itemCustomField: [],
  transactionColumnCustomField: [],
  crmCustomField: [],
  otherCustomField: [],
  CustomRecordType: [
    { internalid: 9, scriptid: 'customrecord_project', name: 'Project', description: 'A job' },
  ],
  CustomList: [{ id: 7, scriptid: 'customlist_tiers', name: 'Tiers' }],
  CustomListValue: [
    { list: 7, name: 'Gold', isinactive: 'F' },
    { list: 7, name: 'Silver, tarnished', isinactive: 'F' },
  ],
}

/** Drives the Map/Reduce lifecycle the way NetSuite does. */
function runExport(scope = 'all') {
  const files = fakeFile()
  const mr = loadAmd('src/mr_schema_export.js', {
    'N/record': fakeRecord(ACCOUNT, ['bintransfer']),
    'N/runtime': fakeRuntime({ custscript_trb_scope: scope, custscript_trb_folder: -15 }),
    'N/file': files,
    'N/log': fakeLog,
    'N/query': fakeQuery(CUSTOM_FIELDS),
  })

  const mapped: Array<{ key: string; value: string }> = []
  for (const item of mr.getInputData()) {
    mr.map({ value: JSON.stringify(item), write: (o: any) => mapped.push(o) })
  }

  const reduced: Array<{ key: string; value: string }> = []
  for (const entry of mapped) {
    mr.reduce({
      key: entry.key,
      values: [entry.value],
      write: (o: any) => reduced.push(o),
    })
  }

  mr.summarize({
    output: {
      iterator: () => ({
        each: (fn: (k: string, v: string) => boolean) => {
          for (const entry of reduced) if (!fn(entry.key, entry.value)) break
        },
      }),
    },
    inputSummary: { error: null },
  })

  return { files: files.saved, mr }
}

let csvText: string

beforeAll(() => {
  csvText = runExport().files[0]!.contents
})

describe('what the export produces', () => {
  it('writes one file for an account this size', () => {
    expect(runExport().files).toHaveLength(1)
  })

  it('parses cleanly, comma-bearing labels and all', () => {
    const parsed = Papa.parse(csvText.replace(/^﻿/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
    })
    expect(parsed.errors).toEqual([])
    const memo = (parsed.data as any[]).find((r) => r['Field API Name'] === 'memo')
    expect(memo['Field Label']).toBe('Memo, with a comma')
  })

  it('survives a record type that cannot be instantiated', () => {
    // `record.create` throws for system types, unlicensed features and subrecord-only
    // types. That is routine, not exceptional; a run that died on the first one would
    // never finish on any real account.
    expect(csvText).not.toMatch(/bintransfer/)
    expect(csvText).toMatch(/salesorder/)
  })

  it('splits large accounts on record boundaries, never mid-record', () => {
    const mr = loadAmd('src/mr_schema_export.js', {
      'N/record': fakeRecord(ACCOUNT, []),
      'N/runtime': fakeRuntime(),
      'N/file': fakeFile(),
      'N/log': fakeLog,
      'N/query': fakeQuery(CUSTOM_FIELDS),
    })
    const groups = [new Array(8).fill('a'), new Array(8).fill('b'), new Array(8).fill('c')]
    const parts = mr._internal.splitOnRecordBoundaries(groups, 10)
    // A record's fields landing in two files would import as two half-records with no
    // error, so the cap gives way rather than the boundary.
    expect(parts.map((p: string[]) => p.length)).toEqual([8, 8, 8])
  })

  it('keeps an oversized record type whole rather than honouring the cap', () => {
    const mr = loadAmd('src/mr_schema_export.js', {
      'N/record': fakeRecord(ACCOUNT, []),
      'N/runtime': fakeRuntime(),
      'N/file': fakeFile(),
      'N/log': fakeLog,
      'N/query': fakeQuery(CUSTOM_FIELDS),
    })
    const parts = mr._internal.splitOnRecordBoundaries([new Array(25).fill('x')], 10)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toHaveLength(25)
  })
})

describe('what it says about each field', () => {
  const rows = () =>
    Papa.parse<Record<string, string>>(csvText.replace(/^﻿/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
    }).data

  const find = (record: string, field: string) =>
    rows().find((r) => r['Record API Name'] === record && r['Field API Name'] === field)!

  it('splits native from custom by NetSuite’s own naming', () => {
    expect(find('customer', 'entityid')['Field Origin']).toBe('native')
    expect(find('customer', 'custentity_loyalty_tier')['Field Origin']).toBe('custom')
    expect(find('customer', 'entityid')['Record Origin']).toBe('native')
    expect(find('customrecord_project', 'custrecord_project_customer')['Record Origin']).toBe(
      'custom',
    )
  })

  it('names the record a select points at, so the relationship imports', () => {
    expect(find('customrecord_project', 'custrecord_project_customer')['Reference Target']).toBe(
      'customer',
    )
    expect(find('customrecord_project', 'custrecord_project_customer')['Type']).toBe('reference')
  })

  it('does not turn a custom list into a relationship', () => {
    // A list is not a record; naming it as a target would invent a parent that does
    // not exist and the import would report a dangling reference.
    const tier = find('customer', 'custentity_loyalty_tier')
    expect(tier['Reference Target']).toBe('')
    expect(tier['Type']).toBe('enum')
  })

  it('carries a custom list’s values as the allowed values', () => {
    expect(find('customer', 'custentity_loyalty_tier')['Allowed Values']).toBe(
      'Gold;Silver, tarnished',
    )
  })

  it('takes the description from custom metadata, which is the only place it exists', () => {
    // N/record's Field object has no `description` at all.
    expect(find('customer', 'custentity_loyalty_tier')['Field Description']).toBe(
      'Which tier this customer sits in',
    )
    expect(find('customer', 'entityid')['Field Description']).toBe('')
  })

  it('marks internalid as the primary key and nothing else', () => {
    expect(find('customer', 'internalid')['Primary Key']).toBe('T')
    expect(find('customer', 'entityid')['Primary Key']).toBe('F')
  })

  it('carries required through, from either source', () => {
    expect(find('customer', 'entityid')['Required']).toBe('T')
    expect(find('salesorder', 'custbody_delivery_window')['Required']).toBe('T')
    expect(find('customer', 'companyname')['Required']).toBe('F')
  })

  it('lists a custom field once, not twice', () => {
    const tiers = rows().filter((r) => r['Field API Name'] === 'custentity_loyalty_tier')
    expect(tiers).toHaveLength(1)
  })

  it('emits a type the catalog has, for every field', () => {
    const known = new Set(BUILTIN_DATA_TYPES.map((t) => t.key))
    for (const row of rows()) {
      if (!row['Type']) continue
      expect(known.has(row['Type']!), `${row['Field API Name']}: ${row['Type']}`).toBe(true)
    }
  })
})

describe('importing it into a real catalog', () => {
  const DB_PATH = '.data/netsuite-roundtrip.db'

  it('imports end to end and lands the records, fields and relationships', () => {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(resolve(`${DB_PATH}${suffix}`), { force: true })
    }
    const db = createDb(DB_PATH)
    migrate(db, { migrationsFolder: resolve('server/db/migrations') })
    ensureBuiltinLists(db)
    for (const type of BUILTIN_DATA_TYPES) {
      db.insert(dataTypes).values({ key: type.key, label: type.label }).run()
    }

    const parsed = Papa.parse<Record<string, string>>(csvText.replace(/^﻿/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
    })

    // The exporter's headers, matched by the importer's own auto-mapper — no
    // hand-written mapping anywhere, so this fails if either side drifts.
    const headerToKey = autoMapHeaders(parsed.meta.fields!)
    const mapping: Record<string, string> = {}
    for (const [header, key] of Object.entries(headerToKey)) if (key) mapping[key] = header

    const batchId = crypto.randomUUID()
    const planned = planCsvImport(db, { mapping, rows: parsed.data, strategy: 'fill-blanks', emptyCellsClear: false, approvedRenames: [] }, batchId)

    expect(planned.preview.errors).toEqual([])

    const applied = applyCsvImport(db, planned, null, batchId)
    expect(applied.recordsCreated).toBeGreaterThan(0)
    expect(applied.fieldsCreated).toBeGreaterThan(0)

    const customer = db.select().from(records).where(eq(records.apiName, 'customer')).all()[0]!
    expect(customer.origin).toBe('native')

    const project = db
      .select()
      .from(records)
      .where(eq(records.apiName, 'customrecord_project'))
      .all()[0]!
    expect(project.origin).toBe('custom')

    // The reference target became a real relationship, pointing the right way.
    const rels = db.select().from(relationships).all()
    const projectToCustomer = rels.find((r) => r.childRecordId === project.id)!
    expect(projectToCustomer).toBeDefined()
    expect(projectToCustomer.parentRecordId).toBe(customer.id)
    expect(projectToCustomer.cardinality).toBe('many_to_one')

    // Booleans survived as booleans, not as the letters T and F.
    const entityId = db
      .select()
      .from(fields)
      .where(eq(fields.apiName, 'entityid'))
      .all()[0]!
    expect(entityId.isRequired).toBe(true)
    expect(entityId.origin).toBe('native')

    // And re-importing the same file changes nothing.
    const second = planCsvImport(db, { mapping, rows: parsed.data, strategy: 'fill-blanks', emptyCellsClear: false, approvedRenames: [] }, crypto.randomUUID())
    expect(second.preview.counts.records.create).toBe(0)
    expect(second.preview.counts.fields.create).toBe(0)
    expect(second.preview.counts.relationships.create).toBe(0)
  })
})
