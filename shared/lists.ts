import { z } from 'zod'
import {
  CARDINALITIES,
  CARDINALITY_LABELS,
  DATA_TYPE_CATEGORIES,
  DELETE_BEHAVIORS,
  DERIVATION_LANGUAGES,
  DERIVATION_LANGUAGE_LABELS,
  ORIGINS,
  ORIGIN_LABELS,
  SOURCE_KINDS,
  SOURCE_KIND_DESCRIPTIONS,
  SOURCE_KIND_LABELS,
  USER_ROLES,
} from './constants'

/**
 * Which of the app's dropdowns are lists a team can edit, and which are structure.
 *
 * The catalog describes somebody else's system, and that system's vocabulary is not
 * ours to fix in advance. A list whose members are only ever labels — how a formula is
 * written, what a foreign key does on delete — has no business being a constant in the
 * source. Those live in `list_items` and are edited in Settings.
 *
 * The rest are not lists at all, they are the shape of the model wearing a dropdown.
 * They are declared here too, with the reason, so Settings can *show* them as closed
 * rather than leaving someone to wonder why theirs is the one that cannot be edited.
 */

// ---------------------------------------------------------------------------
// Editable
// ---------------------------------------------------------------------------

export interface ManagedList {
  key: string
  title: string
  /** What a value from this list means. */
  description: string
  /** Where it is chosen, so Settings can point at the form it feeds. */
  usedFor: string
  /** Seeded on first run; a team may hide any of them and add its own. */
  seeds: ReadonlyArray<{ key: string; label: string; description?: string }>
}

export const MANAGED_LISTS = [
  {
    key: 'derivation_language',
    title: 'Derivation languages',
    description:
      'How a computed field is written. Recorded as metadata — the expression is never parsed, so anything your system actually uses belongs here.',
    usedFor: 'The source editor, when a field is derived',
    seeds: DERIVATION_LANGUAGES.map((k) => ({
      key: k,
      label: DERIVATION_LANGUAGE_LABELS[k],
    })),
  },
  {
    key: 'delete_behavior',
    title: 'Delete behaviours',
    description:
      "What the source system does to the child when the parent is deleted. Descriptive only: this catalog records the behaviour, it does not perform it.",
    usedFor: 'The relationship form',
    seeds: [
      { key: 'cascade', label: 'Cascade', description: 'Children are deleted too.' },
      {
        key: 'restrict',
        label: 'Restrict',
        description: 'The delete is refused while children exist.',
      },
      {
        key: 'set_null',
        label: 'Set null',
        description: 'The link is cleared and the child survives.',
      },
      { key: 'none', label: 'Not recorded', description: 'Nothing is known yet.' },
    ],
  },
  {
    key: 'data_type_category',
    title: 'Field type categories',
    description:
      'How field types are grouped. Grouping only — nothing changes about a type based on the category it sits in.',
    usedFor: 'The field type editor below',
    seeds: DATA_TYPE_CATEGORIES.map((k) => ({
      key: k,
      label: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '),
    })),
  },
] as const satisfies readonly ManagedList[]

export type ManagedListKey = (typeof MANAGED_LISTS)[number]['key']

export const MANAGED_LIST_KEYS = MANAGED_LISTS.map((l) => l.key) as ManagedListKey[]

export function findManagedList(key: string): ManagedList | undefined {
  return MANAGED_LISTS.find((l) => l.key === key)
}

// ---------------------------------------------------------------------------
// Closed, and why
// ---------------------------------------------------------------------------

export interface FixedList {
  key: string
  title: string
  /** Stated in the UI. "Not editable" without a reason is just a dead end. */
  reason: string
  members: ReadonlyArray<{ key: string; label: string }>
}

export const FIXED_LISTS: readonly FixedList[] = [
  {
    key: 'origin',
    title: 'Native / custom',
    reason:
      'The split the catalog turns on. Reports filter on it, the ERD colours by it, and the CSV importer folds every spelling a source system uses — T/F, Standard, Custom? — down to these two. A third member would arrive with no defined meaning in any of them.',
    members: ORIGINS.map((k) => ({ key: k, label: ORIGIN_LABELS[k] })),
  },
  {
    key: 'source_kind',
    title: 'Field source kinds',
    reason:
      'Each kind is a different shape, not a different label: user entry has no upstream, a reference has exactly one, derived carries an expression. A database CHECK constraint and the form that edits provenance both enforce that. A fourth kind would need code that knows what shape it has.',
    members: SOURCE_KINDS.map((k) => ({
      key: k,
      label: `${SOURCE_KIND_LABELS[k]} — ${SOURCE_KIND_DESCRIPTIONS[k]}`,
    })),
  },
  {
    key: 'cardinality',
    title: 'Cardinality',
    reason:
      'Every combination of one and many, on both ends. There is no fifth, and the ERD draws a different connector for each.',
    members: CARDINALITIES.map((k) => ({ key: k, label: CARDINALITY_LABELS[k] })),
  },
  {
    key: 'user_role',
    title: 'Roles',
    reason:
      'Roles carry permissions the server checks by name. A role it does not recognise would be granted nothing, which reads as a broken account rather than a new role.',
    members: USER_ROLES.map((k) => ({
      key: k,
      label: k.charAt(0).toUpperCase() + k.slice(1),
    })),
  },
]

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The key is the value written into every row that chooses this item, so it follows
 * the same grammar as a type key and — unlike the label — cannot be edited afterwards.
 * Renaming it would leave every existing row pointing at a member that no longer
 * exists; hiding the old one and adding a new one says the same thing without lying
 * about history.
 */
export const listItemKeySchema = z
  .string()
  .min(1, 'A key is required')
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'Lowercase letters, digits and underscores only')

export const listItemInputSchema = z.object({
  key: listItemKeySchema,
  label: z.string().min(1, 'A label is required').max(128),
  description: z.string().max(1000).nullish(),
  sortOrder: z.number().int().default(0),
})
export type ListItemInput = z.infer<typeof listItemInputSchema>

/** The key is deliberately absent: it is fixed at creation. */
export const listItemPatchSchema = z.object({
  label: z.string().min(1, 'A label is required').max(128).optional(),
  description: z.string().max(1000).nullish(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

/**
 * A value chosen *from* a list, as it arrives on a record. Shape only — that the value
 * is actually a member is checked against the database, which is the only place that
 * knows what the list currently holds.
 */
export const listValueSchema = z.string().min(1).max(64)
