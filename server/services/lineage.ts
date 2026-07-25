import { DEFAULT_LINEAGE_DEPTH } from '../../shared/constants'
import type { DependencyKind } from '../../shared/constants'

/**
 * Lineage traversal.
 *
 * Deliberately a pure function over a plain edge list rather than a recursive CTE:
 *
 *  - A schema catalog's edge set is small (thousands of rows). One indexed SELECT plus
 *    a BFS is faster than the round trip saved.
 *  - Rendering lineage needs the *path* to each node. Carrying a path through a
 *    recursive CTE means string concatenation, and substring-based cycle checks then
 *    misfire on any ID containing the delimiter — a bug that presents as "lineage
 *    randomly claims there's a cycle". A JS array sidesteps the whole class.
 *  - Both directions come from one function by swapping which column keys the index,
 *    so upstream and downstream cannot drift apart.
 *  - It is testable with fixtures and no database.
 */

export interface DependencyEdge {
  id: string
  /** Downstream consumer — the field whose value depends on something else. */
  fieldId: string
  /** Upstream producer. */
  sourceFieldId: string
  kind: DependencyKind
}

export type Direction = 'up' | 'down' | 'both'

export interface LineageNode {
  fieldId: string
  /**
   * Hop distance from the root, signed: negative upstream, positive downstream.
   * The root is 0. When a node is reachable both ways, the smaller magnitude wins.
   */
  depth: number
  /** Field IDs from the root to this node, inclusive of both ends. */
  path: string[]
  /** No further edges in the direction of travel. */
  isTerminal: boolean
}

export interface LineageEdge {
  id: string
  /** Always upstream -> downstream, regardless of traversal direction. */
  from: string
  to: string
  kind: DependencyKind
  /**
   * This edge closes a loop. It is reported once and never expanded, so the UI can
   * draw the cycle without the traversal running forever.
   */
  isCycle: boolean
}

export interface LineageResult {
  rootFieldId: string
  direction: Direction
  requestedDepth: number
  nodes: LineageNode[]
  edges: LineageEdge[]
  /** Each detected loop, as the sequence of field IDs that closes it. */
  cycles: string[][]
  /**
   * True when the walk stopped at the depth or node cap rather than running out of
   * graph. Without this a clipped result reads as "that's everything", which is worse
   * than refusing to answer.
   */
  truncated: boolean
  maxDepthReached: number
}

/** Guard against a pathological graph exhausting memory. */
const DEFAULT_NODE_LIMIT = 2000

interface Index {
  /** fieldId -> edges where it is the consumer (walk these to go upstream). */
  byConsumer: Map<string, DependencyEdge[]>
  /** sourceFieldId -> edges where it is the producer (walk these to go downstream). */
  byProducer: Map<string, DependencyEdge[]>
}

function buildIndex(edges: DependencyEdge[]): Index {
  const byConsumer = new Map<string, DependencyEdge[]>()
  const byProducer = new Map<string, DependencyEdge[]>()
  for (const edge of edges) {
    let consumers = byConsumer.get(edge.fieldId)
    if (!consumers) byConsumer.set(edge.fieldId, (consumers = []))
    consumers.push(edge)

    let producers = byProducer.get(edge.sourceFieldId)
    if (!producers) byProducer.set(edge.sourceFieldId, (producers = []))
    producers.push(edge)
  }
  return { byConsumer, byProducer }
}

interface WalkOutput {
  nodes: Map<string, LineageNode>
  edges: Map<string, LineageEdge>
  cycles: string[][]
  truncated: boolean
  maxDepthReached: number
}

/**
 * Breadth-first walk in one direction.
 *
 * BFS rather than DFS so that when a node is reachable by several routes, the path
 * recorded is the shortest one — which is the one a human wants to read.
 */
function walk(
  index: Index,
  rootFieldId: string,
  goUpstream: boolean,
  maxDepth: number,
  nodeLimit: number,
  out: WalkOutput,
): void {
  const seen = new Set<string>([rootFieldId])
  let frontier: Array<{ fieldId: string; path: string[] }> = [
    { fieldId: rootFieldId, path: [rootFieldId] },
  ]

  for (let hop = 1; hop <= maxDepth; hop++) {
    const next: Array<{ fieldId: string; path: string[] }> = []

    for (const current of frontier) {
      const outgoing = goUpstream
        ? (index.byConsumer.get(current.fieldId) ?? [])
        : (index.byProducer.get(current.fieldId) ?? [])

      if (outgoing.length > 0) {
        const node = out.nodes.get(current.fieldId)
        if (node) node.isTerminal = false
      }

      for (const edge of outgoing) {
        const neighbour = goUpstream ? edge.sourceFieldId : edge.fieldId

        // A neighbour already on this path closes a loop. Record the edge once so it
        // can be drawn, capture the cycle, and stop — expanding it would not terminate.
        const loopStart = current.path.indexOf(neighbour)
        if (loopStart !== -1) {
          recordEdge(out, edge, true)
          out.cycles.push([...current.path.slice(loopStart), neighbour])
          continue
        }

        recordEdge(out, edge, false)

        if (seen.has(neighbour)) continue
        seen.add(neighbour)

        if (out.nodes.size >= nodeLimit) {
          out.truncated = true
          return
        }

        const path = [...current.path, neighbour]
        const depth = goUpstream ? -hop : hop
        const existing = out.nodes.get(neighbour)
        if (!existing || Math.abs(existing.depth) > hop) {
          out.nodes.set(neighbour, { fieldId: neighbour, depth, path, isTerminal: true })
        }
        out.maxDepthReached = Math.max(out.maxDepthReached, hop)
        next.push({ fieldId: neighbour, path })
      }
    }

    if (next.length === 0) return
    frontier = next

    // Ran out of depth budget with work still queued — the graph continues past here.
    if (hop === maxDepth) out.truncated = true
  }
}

function recordEdge(out: WalkOutput, edge: DependencyEdge, _isCycle: boolean): void {
  if (out.edges.has(edge.id)) return
  out.edges.set(edge.id, {
    id: edge.id,
    from: edge.sourceFieldId,
    to: edge.fieldId,
    kind: edge.kind,
    // Set once, after both walks finish, from the cycles actually detected. Deciding
    // it here would depend on which direction happened to reach the edge first: the
    // closing edge of a loop looks like an ordinary edge from one side and a cycle
    // edge from the other.
    isCycle: false,
  })
}

export function traverse(
  edges: DependencyEdge[],
  rootFieldId: string,
  direction: Direction = 'both',
  maxDepth: number = DEFAULT_LINEAGE_DEPTH,
  nodeLimit: number = DEFAULT_NODE_LIMIT,
): LineageResult {
  const index = buildIndex(edges)

  const out: WalkOutput = {
    nodes: new Map([
      [rootFieldId, { fieldId: rootFieldId, depth: 0, path: [rootFieldId], isTerminal: true }],
    ]),
    edges: new Map(),
    cycles: [],
    truncated: false,
    maxDepthReached: 0,
  }

  if (direction === 'up' || direction === 'both') {
    walk(index, rootFieldId, true, maxDepth, nodeLimit, out)
  }
  if (direction === 'down' || direction === 'both') {
    walk(index, rootFieldId, false, maxDepth, nodeLimit, out)
  }

  const cycles = dedupeCycles(out.cycles)
  markCycleEdges(out.edges, cycles)

  return {
    rootFieldId,
    direction,
    requestedDepth: maxDepth,
    nodes: [...out.nodes.values()].sort((a, b) => a.depth - b.depth),
    edges: [...out.edges.values()],
    cycles,
    truncated: out.truncated,
    maxDepthReached: out.maxDepthReached,
  }
}

/**
 * Flag every edge that participates in a detected loop.
 *
 * Derived from the cycles rather than from traversal order, so the same edges are
 * flagged whichever direction the walk ran.
 */
function markCycleEdges(edges: Map<string, LineageEdge>, cycles: string[][]): void {
  const adjacent = new Set<string>()
  for (const cycle of cycles) {
    const ring = cycle.slice(0, -1)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!
      const b = ring[(i + 1) % ring.length]!
      // Both orientations: a cycle found upstream lists the same edges as one found
      // downstream, just walked the other way.
      adjacent.add(`${a}|${b}`)
      adjacent.add(`${b}|${a}`)
    }
  }
  for (const edge of edges.values()) {
    if (adjacent.has(`${edge.from}|${edge.to}`)) edge.isCycle = true
  }
}

/** Rotate a ring so it starts at its smallest member. */
function rotateToSmallest(ring: string[]): string[] {
  let pivot = 0
  for (let i = 1; i < ring.length; i++) {
    if (ring[i]! < ring[pivot]!) pivot = i
  }
  return [...ring.slice(pivot), ...ring.slice(0, pivot)]
}

/**
 * Collapse the same loop reported more than once.
 *
 * Two things make one loop look like several: different entry points produce
 * rotations of the sequence, and an upstream walk lists it in the reverse order of a
 * downstream walk. Canonicalising for rotation alone would still report a `both`
 * traversal's single loop twice, so the reversal is normalised too.
 */
function dedupeCycles(cycles: string[][]): string[][] {
  const seen = new Set<string>()
  const result: string[][] = []

  for (const cycle of cycles) {
    const ring = cycle.slice(0, -1)
    if (ring.length === 0) continue

    const forward = rotateToSmallest(ring)
    const backward = rotateToSmallest([...ring].reverse())
    const forwardKey = forward.join('>')
    const backwardKey = backward.join('>')

    const canonical = forwardKey <= backwardKey ? forward : backward
    const key = forwardKey <= backwardKey ? forwardKey : backwardKey
    if (seen.has(key)) continue
    seen.add(key)
    result.push([...canonical, canonical[0]!])
  }
  return result
}

/**
 * Whole-graph cycle census via Tarjan's strongly-connected components.
 *
 * A traversal rooted at one field only finds loops reachable from that field, so it
 * can never answer "does this catalog contain any circular dependencies?". Every SCC
 * with more than one member is a cycle cluster; single nodes with a self-edge count too.
 * O(V+E), iterative to avoid blowing the JS stack on a deep graph.
 */
export function findAllCycles(edges: DependencyEdge[]): string[][] {
  const adjacency = new Map<string, string[]>()
  const vertices = new Set<string>()
  for (const edge of edges) {
    vertices.add(edge.fieldId)
    vertices.add(edge.sourceFieldId)
    let list = adjacency.get(edge.sourceFieldId)
    if (!list) adjacency.set(edge.sourceFieldId, (list = []))
    list.push(edge.fieldId)
  }

  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const start of vertices) {
    if (indices.has(start)) continue

    // Explicit work stack: recursion would overflow on a long dependency chain.
    const work: Array<{ node: string; childIndex: number }> = [
      { node: start, childIndex: 0 },
    ]
    indices.set(start, counter)
    lowlink.set(start, counter)
    counter++
    stack.push(start)
    onStack.add(start)

    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const children = adjacency.get(frame.node) ?? []

      if (frame.childIndex < children.length) {
        const child = children[frame.childIndex++]!
        if (!indices.has(child)) {
          indices.set(child, counter)
          lowlink.set(child, counter)
          counter++
          stack.push(child)
          onStack.add(child)
          work.push({ node: child, childIndex: 0 })
        } else if (onStack.has(child)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, indices.get(child)!))
        }
        continue
      }

      work.pop()
      const parent = work[work.length - 1]
      if (parent) {
        lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!))
      }

      if (lowlink.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = []
        let member: string
        do {
          member = stack.pop()!
          onStack.delete(member)
          component.push(member)
        } while (member !== frame.node)

        const isSelfLoop =
          component.length === 1 && (adjacency.get(component[0]!) ?? []).includes(component[0]!)
        if (component.length > 1 || isSelfLoop) components.push(component.reverse())
      }
    }
  }

  return components
}
