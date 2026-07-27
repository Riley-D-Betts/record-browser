import { describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import { fakeFile, fakeLog, fakeRecord, fakeRuntime, loadAmd } from './amd'

/**
 * The failure a real account actually produced.
 *
 * Every custom-field table was rejected outright ("Invalid search type:
 * entityCustomField") and the custom-list query rejected a column name. The export
 * still ran, still wrote a large and entirely plausible CSV — 244 record types, every
 * field on each — with **zero relationships and zero descriptions**, and nothing
 * anywhere said so.
 *
 * That is the worst shape a failure can take: not an empty result that is obviously
 * wrong, but a full one that is quietly incomplete. Somebody imports it and concludes
 * their schema has no relationships.
 *
 * These tests pin the two things that must hold on such an account: the fields still
 * come through (they are read from `getFields()`, not from SuiteQL), and the missing
 * half is reported loudly enough that nobody imports it by accident.
 */

const ACCOUNT = {
  customer: [
    { id: 'internalid', label: 'Internal ID', type: 'integer' },
    { id: 'entityid', label: 'Customer ID', type: 'text', isMandatory: true },
    // A custom field: present on the record itself, so `getFields()` sees it even when
    // every metadata query fails.
    { id: 'custentity_loyalty_tier', label: 'Loyalty Tier', type: 'select' },
  ],
  salesorder: [
    { id: 'tranid', label: 'Document Number', type: 'text', isMandatory: true },
    { id: 'entity', label: 'Customer', type: 'select' },
  ],
}

/** Every SuiteQL statement fails the way the real account failed. */
const deadQuery = {
  runSuiteQL({ query }: { query: string }) {
    const table = /FROM\s+(\w+)/i.exec(query)?.[1] ?? '?'
    if (/CustomRecordType/i.test(query)) {
      // The one that worked. 244 rows on the real account; one is enough here.
      return {
        asMappedResults: () => [
          { internalid: 9, scriptid: 'customrecord_project', name: 'Project', description: '' },
        ],
      }
    }
    if (/CustomList/i.test(query)) {
      throw new Error(
        `Search error occurred: Unknown identifier '"ID"'. Available identifiers are: {customlist=CustomList}`,
      )
    }
    throw new Error(`Invalid search type: ${table}`)
  },
}

function runDegraded() {
  const files = fakeFile()
  const logged: Array<{ level: string; title: string; details: string }> = []
  const log = {
    audit: (o: any) => logged.push({ level: 'audit', ...o }),
    error: (o: any) => logged.push({ level: 'error', ...o }),
    debug: () => {},
    emergency: () => {},
  }

  const mr = loadAmd('src/mr_schema_export.js', {
    'N/record': fakeRecord(ACCOUNT, []),
    'N/runtime': fakeRuntime({ custscript_trb_scope: 'all' }),
    'N/file': files,
    'N/log': log,
    'N/query': deadQuery,
  })

  const mapped: Array<{ key: string; value: string }> = []
  for (const item of mr.getInputData()) {
    mr.map({ value: JSON.stringify(item), write: (o: any) => mapped.push(o) })
  }
  const reduced: Array<{ key: string; value: string }> = []
  for (const entry of mapped) {
    mr.reduce({ key: entry.key, values: [entry.value], write: (o: any) => reduced.push(o) })
  }
  mr.summarize({
    output: {
      iterator: () => ({
        each: (fn: (k: string, v: string) => boolean) => {
          for (const e of reduced) if (!fn(e.key, e.value)) break
        },
      }),
    },
    inputSummary: { error: null },
  })

  return {
    files: files.saved.filter((f) => f.name.endsWith('.csv')),
    reports: files.saved.filter((f) => !f.name.endsWith('.csv')),
    logged,
  }
}

describe('an account where every custom-field query fails', () => {
  it('still exports the fields — they come from getFields(), not from SuiteQL', () => {
    const { files } = runDegraded()
    const rows = Papa.parse<Record<string, string>>(files[0]!.contents.replace(/^﻿/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
    }).data

    expect(rows.length).toBeGreaterThan(0)
    // Including the custom one, which is a real field on the record.
    expect(rows.some((r) => r['Field API Name'] === 'custentity_loyalty_tier')).toBe(true)
    expect(rows.some((r) => r['Field API Name'] === 'entityid')).toBe(true)
  })

  it('still splits native from custom, which needs no metadata at all', () => {
    const { files } = runDegraded()
    const rows = Papa.parse<Record<string, string>>(files[0]!.contents.replace(/^﻿/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
    }).data
    const tier = rows.find((r) => r['Field API Name'] === 'custentity_loyalty_tier')!
    expect(tier['Field Origin']).toBe('custom')
  })

  it('says loudly that it could not read custom metadata', () => {
    // The whole point. Without this the run looks like a success.
    const { logged } = runDegraded()
    const errors = logged.filter((l) => l.level === 'error')
    expect(errors.length).toBeGreaterThan(0)
    const text = JSON.stringify(errors)
    expect(text).toMatch(/custom field metadata|Invalid search type/i)
  })

  it('reports that no reference target was found, so no relationship will import', () => {
    // A CSV with every record and no relationships reads as "this schema has no
    // relationships", which is a false statement about the account rather than a gap.
    const { logged } = runDegraded()
    const text = JSON.stringify(logged)
    expect(text).toMatch(/reference target/i)
  })

  it('names the queries that failed, so the next run can be aimed', () => {
    const { logged } = runDegraded()
    const text = JSON.stringify(logged)
    expect(text).toMatch(/entitycustomfield/i)
  })

  it('writes the caveat beside the CSV, under a filename nobody can miss', () => {
    // Nobody downloading a CSV from the File Cabinet reads the script log first, so
    // the warning has to sit where the artifact is.
    const { reports } = runDegraded()
    expect(reports).toHaveLength(1)
    expect(reports[0]!.name).toBe('record-browser-export-INCOMPLETE-README.txt')

    const text = reports[0]!.contents
    expect(text).toMatch(/EXPORT INCOMPLETE/)
    expect(text).toMatch(/entitycustomfield/i)
    expect(text).toMatch(/Reference targets \(these become relationships\): 0/)
    expect(text).toMatch(/debug=1/)
  })

  it('does not claim the schema has no relationships when it simply could not look', () => {
    const { reports } = runDegraded()
    expect(reports[0]!.contents).toMatch(
      /far more likely to be a failed metadata read than a schema with no foreign keys/,
    )
  })
})
