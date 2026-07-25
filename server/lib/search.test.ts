import { describe, expect, it } from 'vitest'
import { escapeLikeTerm } from './search'

describe('escapeLikeTerm', () => {
  it('escapes the underscore wildcard that technical names are full of', () => {
    // Without this, searching Sales_Order also matches SalesXOrder.
    expect(escapeLikeTerm('Sales_Order')).toBe('Sales\\_Order')
  })

  it('escapes the percent wildcard', () => {
    expect(escapeLikeTerm('100%')).toBe('100\\%')
  })

  it('escapes backslashes before the wildcards it adds', () => {
    expect(escapeLikeTerm('a\\b')).toBe('a\\\\b')
    expect(escapeLikeTerm('a\\_b')).toBe('a\\\\\\_b')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeLikeTerm('Account Name')).toBe('Account Name')
  })
})
