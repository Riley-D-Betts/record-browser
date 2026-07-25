import { describe, expect, it } from 'vitest'
import { findAllCycles, traverse } from './lineage'
import type { DependencyEdge } from './lineage'

/**
 * Edges read "consumer <- producer": `edge('total', 'subtotal')` means Total is
 * populated from Subtotal, so Subtotal is upstream of Total.
 */
let seq = 0
const edge = (fieldId: string, sourceFieldId: string): DependencyEdge => ({
  id: `e${seq++}`,
  fieldId,
  sourceFieldId,
  kind: 'derived',
})

const ids = (result: { nodes: Array<{ fieldId: string }> }) =>
  result.nodes.map((n) => n.fieldId).sort()

describe('traverse', () => {
  it('walks a linear chain upstream and stops at the origin', () => {
    // c <- b <- a
    const edges = [edge('c', 'b'), edge('b', 'a')]
    const result = traverse(edges, 'c', 'up')

    expect(ids(result)).toEqual(['a', 'b', 'c'])
    expect(result.nodes.find((n) => n.fieldId === 'a')?.depth).toBe(-2)
    expect(result.nodes.find((n) => n.fieldId === 'a')?.isTerminal).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.cycles).toEqual([])
  })

  it('walks downstream to answer "what breaks if I change this"', () => {
    const edges = [edge('c', 'b'), edge('b', 'a')]
    const result = traverse(edges, 'a', 'down')

    expect(ids(result)).toEqual(['a', 'b', 'c'])
    expect(result.nodes.find((n) => n.fieldId === 'c')?.depth).toBe(2)
  })

  it('does not leak downstream nodes into an upstream-only walk', () => {
    // The direction bug that matters: b has both a parent and a child.
    const edges = [edge('b', 'a'), edge('c', 'b')]
    expect(ids(traverse(edges, 'b', 'up'))).toEqual(['a', 'b'])
    expect(ids(traverse(edges, 'b', 'down'))).toEqual(['b', 'c'])
    expect(ids(traverse(edges, 'b', 'both'))).toEqual(['a', 'b', 'c'])
  })

  it('records edges as upstream -> downstream whichever way it walked', () => {
    const edges = [edge('b', 'a')]
    for (const direction of ['up', 'down', 'both'] as const) {
      const root = direction === 'down' ? 'a' : 'b'
      const [only] = traverse(edges, root, direction).edges
      expect(only).toMatchObject({ from: 'a', to: 'b' })
    }
  })

  it('keeps the shortest path when a node is reachable two ways', () => {
    // d <- b <- a  and  d <- a  (diamond)
    const edges = [edge('d', 'b'), edge('b', 'a'), edge('d', 'a')]
    const result = traverse(edges, 'd', 'up')

    expect(result.nodes.find((n) => n.fieldId === 'a')?.depth).toBe(-1)
    expect(result.nodes.find((n) => n.fieldId === 'a')?.path).toEqual(['d', 'a'])
    expect(result.edges).toHaveLength(3)
  })

  it('terminates on a self-loop and reports it', () => {
    const result = traverse([edge('a', 'a')], 'a', 'both')

    expect(result.cycles).toHaveLength(1)
    expect(result.edges.every((e) => e.isCycle)).toBe(true)
  })

  it('terminates on a mutual cycle and reports it once', () => {
    // a <- b and b <- a
    const result = traverse([edge('a', 'b'), edge('b', 'a')], 'a', 'both')

    expect(result.cycles).toHaveLength(1)
    expect(result.cycles[0]).toHaveLength(3) // closes back on itself
  })

  it('terminates on a long cycle without exhausting the depth budget', () => {
    // a <- b <- c <- a
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    const result = traverse(edges, 'a', 'up', 50)

    expect(ids(result)).toEqual(['a', 'b', 'c'])
    expect(result.cycles).toHaveLength(1)
  })

  it('reports the same cycle once regardless of entry point', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    const fromA = traverse(edges, 'a', 'up').cycles
    const fromB = traverse(edges, 'b', 'up').cycles

    expect(fromA).toHaveLength(1)
    expect(fromB).toHaveLength(1)
  })

  it('flags truncation at the depth cap instead of implying completeness', () => {
    // A chain of 10 links walked only 3 deep.
    const edges = Array.from({ length: 10 }, (_, i) => edge(`n${i}`, `n${i + 1}`))
    const result = traverse(edges, 'n0', 'up', 3)

    expect(result.truncated).toBe(true)
    expect(result.maxDepthReached).toBe(3)
    expect(ids(result)).toEqual(['n0', 'n1', 'n2', 'n3'])
  })

  it('does not flag truncation when the graph simply ends', () => {
    const edges = [edge('b', 'a')]
    expect(traverse(edges, 'b', 'up', 10).truncated).toBe(false)
  })

  it('flags truncation at the node cap', () => {
    // One field feeding 50 others, with room for only 10.
    const edges = Array.from({ length: 50 }, (_, i) => edge(`child${i}`, 'root'))
    const result = traverse(edges, 'root', 'down', 10, 10)

    expect(result.truncated).toBe(true)
    expect(result.nodes.length).toBeLessThanOrEqual(11)
  })

  it('returns just the root for an isolated field', () => {
    const result = traverse([edge('c', 'b')], 'lonely', 'both')
    expect(ids(result)).toEqual(['lonely'])
    expect(result.nodes[0]?.isTerminal).toBe(true)
  })

  it('marks only genuine origins as terminal', () => {
    const edges = [edge('c', 'b'), edge('b', 'a')]
    const result = traverse(edges, 'c', 'up')

    expect(result.nodes.find((n) => n.fieldId === 'a')?.isTerminal).toBe(true)
    expect(result.nodes.find((n) => n.fieldId === 'b')?.isTerminal).toBe(false)
  })

  it('tolerates IDs containing regex and delimiter characters', () => {
    // The bug class avoided by not doing substring path matching in SQL.
    const weird = 'a_b%c/d.e'
    const result = traverse([edge('x', weird)], 'x', 'up')
    expect(ids(result)).toEqual([weird, 'x'].sort())
    expect(result.cycles).toEqual([])
  })
})

describe('findAllCycles', () => {
  it('finds a cycle unreachable from any particular starting field', () => {
    // An isolated loop plus an unrelated chain.
    const edges = [edge('p', 'q'), edge('q', 'p'), edge('y', 'x')]
    const cycles = findAllCycles(edges)

    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.sort()).toEqual(['p', 'q'])
  })

  it('finds multiple independent cycles', () => {
    const edges = [
      edge('a', 'b'),
      edge('b', 'a'),
      edge('c', 'd'),
      edge('d', 'e'),
      edge('e', 'c'),
    ]
    expect(findAllCycles(edges)).toHaveLength(2)
  })

  it('reports a self-loop', () => {
    expect(findAllCycles([edge('a', 'a')])).toEqual([['a']])
  })

  it('returns nothing for an acyclic graph', () => {
    const edges = [edge('c', 'b'), edge('b', 'a'), edge('d', 'a')]
    expect(findAllCycles(edges)).toEqual([])
  })

  it('handles a long chain without overflowing the stack', () => {
    const edges = Array.from({ length: 20_000 }, (_, i) => edge(`n${i}`, `n${i + 1}`))
    expect(() => findAllCycles(edges)).not.toThrow()
    expect(findAllCycles(edges)).toEqual([])
  })
})

describe('cycle reporting', () => {
  it('reports one loop once when walking both directions', () => {
    // The seeded topology: a <- b <- c <- a. A `both` walk meets it from each side.
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    const result = traverse(edges, 'a', 'both')

    expect(result.cycles).toHaveLength(1)
  })

  it('flags the edges of a loop whichever direction found it', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]

    for (const direction of ['up', 'down', 'both'] as const) {
      const result = traverse(edges, 'a', direction)
      const flagged = result.edges.filter((e) => e.isCycle)
      expect(flagged, `direction=${direction}`).toHaveLength(3)
    }
  })

  it('does not flag edges outside the loop', () => {
    // A loop plus an innocent field hanging off it.
    const edges = [edge('a', 'b'), edge('b', 'a'), edge('outside', 'a')]
    const result = traverse(edges, 'a', 'both')

    expect(result.edges.filter((e) => e.isCycle)).toHaveLength(2)
    expect(result.edges.find((e) => e.to === 'outside')?.isCycle).toBe(false)
  })
})
