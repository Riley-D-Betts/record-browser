import { describe, expect, it } from 'vitest'
import { fieldSourceSchema, recordInputSchema } from './schemas'

/**
 * These guard the messages a person actually reads in a form.
 *
 * Zod's defaults ("Invalid input: expected string, received undefined") are accurate
 * and useless. A missing key fails the type check before any `.min()` refinement, so
 * the custom message has to be on the type as well — easy to lose in a refactor,
 * hence the tests.
 */

const messagesFor = (schema: any, input: unknown): string[] => {
  const result = schema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i: any) => i.message)
}

describe('field source', () => {
  it('accepts a plain user-entry field', () => {
    expect(fieldSourceSchema.safeParse({ sourceKind: 'user_entry' }).success).toBe(true)
  })

  it('carries the external-population flag through', () => {
    const parsed = fieldSourceSchema.parse({
      sourceKind: 'user_entry',
      isExternallyPopulated: true,
      sourceNotes: 'Nightly ERP sync',
    })
    expect(parsed).toMatchObject({ isExternallyPopulated: true })
  })

  it('explains a derived field with no expression in plain words', () => {
    expect(messagesFor(fieldSourceSchema, { sourceKind: 'derived' })).toEqual([
      'A derived field needs an expression describing how it is computed',
    ])
  })

  it('gives the same message for an empty expression as a missing one', () => {
    expect(
      messagesFor(fieldSourceSchema, { sourceKind: 'derived', sourceExpression: '' }),
    ).toEqual(['A derived field needs an expression describing how it is computed'])
  })

  it('explains a reference with no upstream field', () => {
    expect(messagesFor(fieldSourceSchema, { sourceKind: 'reference' })).toEqual([
      'Choose the field this one is populated from',
    ])
  })

  it('defaults a derived field to no dependencies rather than failing', () => {
    const parsed = fieldSourceSchema.parse({
      sourceKind: 'derived',
      sourceExpression: 'A + B',
    })
    expect(parsed).toMatchObject({ dependsOn: [] })
  })

  it('rejects a source kind that is not one of the three', () => {
    expect(fieldSourceSchema.safeParse({ sourceKind: 'external' }).success).toBe(false)
  })
})

describe('record input', () => {
  it('rejects a technical name with spaces, which would break in code', () => {
    const messages = messagesFor(recordInputSchema, {
      apiName: 'has spaces',
      label: 'Fine',
    })
    expect(messages.join()).toMatch(/letters, digits, underscores/)
  })

  it('names both problems at once rather than stopping at the first', () => {
    expect(messagesFor(recordInputSchema, { apiName: '1bad', label: '' })).toHaveLength(2)
  })

  it('accepts dots, since qualified names are common', () => {
    expect(
      recordInputSchema.safeParse({ apiName: 'sales.Order', label: 'Order' }).success,
    ).toBe(true)
  })

  it('explains a missing label in plain words', () => {
    expect(messagesFor(recordInputSchema, { apiName: 'Order' })).toEqual([
      'Display label is required',
    ])
  })
})
