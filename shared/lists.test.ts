import { describe, expect, it } from 'vitest'
import {
  FIXED_LISTS,
  MANAGED_LISTS,
  findManagedList,
  listItemInputSchema,
  listItemKeySchema,
  listItemPatchSchema,
} from './lists'
import {
  CARDINALITIES,
  DATA_TYPE_CATEGORIES,
  DERIVATION_LANGUAGES,
  ORIGINS,
  SOURCE_KINDS,
  USER_ROLES,
} from './constants'

/**
 * The registry decides what a team may change about the catalog's vocabulary, so its
 * invariants are worth pinning: a seed key is what gets written into every row that
 * chooses it, and a list cannot be both editable and structural.
 */

describe('the two registries', () => {
  it('never claims the same list is both editable and fixed', () => {
    const managed = new Set<string>(MANAGED_LISTS.map((l) => l.key))
    for (const fixed of FIXED_LISTS) {
      expect(managed.has(fixed.key), fixed.key).toBe(false)
    }
  })

  it('gives every fixed list a reason, not just a refusal', () => {
    for (const list of FIXED_LISTS) {
      // A closed list with no explanation is a dead end for whoever went looking.
      expect(list.reason.length, list.key).toBeGreaterThan(40)
      expect(list.members.length, list.key).toBeGreaterThan(0)
    }
  })

  it('covers every closed dropdown the app actually renders', () => {
    const keys = FIXED_LISTS.map((l) => l.key)
    expect(keys).toContain('origin')
    expect(keys).toContain('source_kind')
    expect(keys).toContain('cardinality')
    expect(keys).toContain('user_role')
  })

  it('lists each fixed set in full, so Settings shows what the members are', () => {
    const members = (key: string) =>
      FIXED_LISTS.find((l) => l.key === key)!.members.map((m) => m.key)
    expect(members('origin')).toEqual([...ORIGINS])
    expect(members('source_kind')).toEqual([...SOURCE_KINDS])
    expect(members('cardinality')).toEqual([...CARDINALITIES])
    expect(members('user_role')).toEqual([...USER_ROLES])
  })
})

describe('managed lists', () => {
  it('seeds a key that is legal to store', () => {
    // A seed that failed its own key rule would be unaddable through the UI and
    // unmatchable by anything reading the column.
    for (const list of MANAGED_LISTS) {
      for (const seed of list.seeds) {
        expect(listItemKeySchema.safeParse(seed.key).success, `${list.key}/${seed.key}`).toBe(
          true,
        )
      }
    }
  })

  it('has no duplicate keys within a list', () => {
    for (const list of MANAGED_LISTS) {
      const keys = list.seeds.map((s) => s.key)
      expect(new Set(keys).size, list.key).toBe(keys.length)
    }
  })

  it('gives every list a title, a description and where it is chosen', () => {
    for (const list of MANAGED_LISTS) {
      expect(list.title.length, list.key).toBeGreaterThan(0)
      expect(list.description.length, list.key).toBeGreaterThan(20)
      expect(list.usedFor.length, list.key).toBeGreaterThan(0)
    }
  })

  it('carries forward exactly the values the constants used to hold', () => {
    // Adopting the table must not quietly drop a value that existing rows contain.
    const seeds = (key: string) => findManagedList(key)!.seeds.map((s) => s.key)
    expect(seeds('derivation_language')).toEqual([...DERIVATION_LANGUAGES])
    expect(seeds('data_type_category')).toEqual([...DATA_TYPE_CATEGORIES])
    expect(seeds('delete_behavior')).toEqual(['cascade', 'restrict', 'set_null', 'none'])
  })

  it('finds a list by key and nothing by a made-up one', () => {
    expect(findManagedList('derivation_language')?.title).toBe('Derivation languages')
    expect(findManagedList('cardinality')).toBeUndefined()
  })
})

describe('list item input', () => {
  it('accepts a plausible new member', () => {
    expect(
      listItemInputSchema.safeParse({ key: 'suitescript', label: 'SuiteScript' }).success,
    ).toBe(true)
  })

  it('refuses a key that would not survive being stored and matched', () => {
    for (const bad of ['Not A Key', 'has-hyphen', 'UPPER', 'with space', '']) {
      expect(listItemKeySchema.safeParse(bad).success, bad).toBe(false)
    }
  })

  it('requires a label, since the key is not what anyone reads', () => {
    expect(listItemInputSchema.safeParse({ key: 'ok', label: '' }).success).toBe(false)
  })

  it('will not let a patch change the key', () => {
    // The key is the value already written on every row that chose this member;
    // renaming it would leave them pointing at nothing.
    const parsed = listItemPatchSchema.parse({ key: 'renamed', label: 'Fine' } as never)
    expect(parsed).not.toHaveProperty('key')
    expect(parsed).toEqual({ label: 'Fine' })
  })

  it('allows hiding through a patch', () => {
    expect(listItemPatchSchema.parse({ isActive: false })).toEqual({ isActive: false })
  })
})
