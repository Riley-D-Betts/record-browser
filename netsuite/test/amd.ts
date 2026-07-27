import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Loads a SuiteScript file under Vitest.
 *
 * SuiteScript modules are AMD (`define([deps], factory)`) and their dependencies are
 * NetSuite's `N/*` modules, which do not exist off-platform. Rather than restructure
 * the exporter for testability — which would mean the tested code is not the deployed
 * code — this evaluates the real file with a `define` shim and hands the factory
 * whatever fakes the test supplies.
 *
 * The files upload to NetSuite exactly as they sit in `src/`. No build step, and
 * nothing in them exists only to make a test pass.
 */
export function loadAmd<T = any>(
  relativePath: string,
  modules: Record<string, unknown> = {},
): T {
  const source = readFileSync(resolve(here, '..', relativePath), 'utf8')
  let exported: unknown

  const define = (depsOrFactory: unknown, maybeFactory?: unknown) => {
    const [deps, factory] = Array.isArray(depsOrFactory)
      ? [depsOrFactory as string[], maybeFactory as (...args: unknown[]) => unknown]
      : [[] as string[], depsOrFactory as (...args: unknown[]) => unknown]

    const resolved = deps.map((dep) => {
      // A relative dep is a sibling library; load it the same way, so a test that
      // exercises the Map/Reduce gets the real type catalog rather than a stand-in.
      if (dep.startsWith('./')) return loadAmd(`src/${dep.slice(2)}.js`, modules)
      if (dep in modules) return modules[dep]
      throw new Error(
        `${relativePath} needs "${dep}", which this test did not provide. ` +
          `Add it to the modules argument.`,
      )
    })

    exported = factory(...resolved)
  }

  // eslint-disable-next-line no-new-func -- the point is to run the file as written
  new Function('define', source)(define)
  return exported as T
}

/** A `N/query` whose `runSuiteQL` answers from a table -> rows map. */
export function fakeQuery(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    runSuiteQL({ query }: { query: string }) {
      const match = /FROM\s+(\w+)/i.exec(query)
      const table = match?.[1] ?? ''
      const key = Object.keys(tables).find((t) => t.toLowerCase() === table.toLowerCase())
      if (key === undefined) throw new Error(`Unknown table: ${table}`)

      const rows = tables[key]!
      // A column the table does not have fails the whole statement, exactly as SuiteQL
      // does — that behaviour is the reason the reader retries with fewer columns, so
      // the fake has to reproduce it or the retry is never exercised.
      const requested = /SELECT\s+(.+?)\s+FROM/is.exec(query)?.[1] ?? ''
      const columns = requested.split(',').map((c) => c.trim().toLowerCase())
      if (rows.length > 0) {
        for (const column of columns) {
          if (column !== '*' && !(column in rows[0]!)) {
            throw new Error(`Invalid or unsupported search field: ${column}`)
          }
        }
      }

      return { asMappedResults: () => rows }
    },
  }
}

/** A `N/record` exposing a fixed set of types and their fields. */
export function fakeRecord(
  types: Record<string, Array<{ id: string; label: string; type: string; isMandatory?: boolean }>>,
  unavailable: string[] = [],
) {
  return {
    Type: Object.keys(types).reduce<Record<string, string>>((acc, key) => {
      acc[key.toUpperCase()] = key
      return acc
    }, {}),
    create({ type }: { type: string }) {
      if (unavailable.includes(type)) {
        throw new Error(`That record type is not available: ${type}`)
      }
      const fields = types[type]
      if (!fields) throw new Error(`Unknown type ${type}`)
      return {
        getFields: () => fields.map((f) => f.id),
        getField: ({ fieldId }: { fieldId: string }) =>
          fields.find((f) => f.id === fieldId) ?? null,
      }
    },
  }
}

export const fakeLog = {
  audit: () => {},
  error: () => {},
  debug: () => {},
  emergency: () => {},
}

export const fakeRuntime = (params: Record<string, unknown> = {}) => ({
  getCurrentScript: () => ({
    id: 'customscript_trb_schema_export',
    deploymentId: 'customdeploy_trb_schema_export',
    getParameter: ({ name }: { name: string }) => params[name] ?? '',
  }),
})

/** A `N/file` that keeps what it was asked to save, so tests can read it back. */
export function fakeFile() {
  const saved: Array<{ name: string; contents: string; folder: number }> = []
  return {
    saved,
    Type: { CSV: 'CSV', PLAINTEXT: 'PLAINTEXT' },
    create({ name, contents, folder }: { name: string; contents: string; folder: number }) {
      return {
        save() {
          saved.push({ name, contents, folder })
          return String(saved.length)
        },
      }
    },
  }
}
