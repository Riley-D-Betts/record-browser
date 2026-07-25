import ELK from 'elkjs/lib/elk-api'
import type { ElkNode } from 'elkjs/lib/elk-api'

/**
 * ERD layout via elkjs, in a Web Worker.
 *
 * GSAP animates positions but does not compute them — a schema diagram needs real
 * layered layout with orthogonal edge routing, which is what ELK is for. Layout of a
 * few hundred nodes takes long enough to drop frames, so it runs off the main thread.
 */

export interface LayoutNodeInput {
  id: string
  /** Rendered height depends on how many field rows the node shows. */
  height: number
  width: number
}

export interface LayoutEdgeInput {
  id: string
  source: string
  target: string
}

export interface LayoutPosition {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutResult {
  nodes: Map<string, LayoutPosition>
  edges: Map<string, Array<{ x: number; y: number }>>
  width: number
  height: number
}

let elk: InstanceType<typeof ELK> | null = null

function getElk() {
  if (!elk) {
    elk = new ELK({
      workerFactory: () =>
        new Worker(new URL('elkjs/lib/elk-worker.min.js', import.meta.url), {
          type: 'classic',
        }),
    })
  }
  return elk
}

const BASE_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.layered.spacing.nodeNodeBetweenLayers': '110',
  'elk.spacing.nodeNode': '48',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  // ERDs are cyclic by nature — a layered algorithm has to be told how to break them
  // or it will not terminate on real data.
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[top=32,left=32,bottom=32,right=32]',
}

export async function computeLayout(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  direction: 'RIGHT' | 'DOWN' = 'RIGHT',
): Promise<LayoutResult> {
  if (nodes.length === 0) {
    return { nodes: new Map(), edges: new Map(), width: 0, height: 0 }
  }

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: { ...BASE_OPTIONS, 'elk.direction': direction },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    // ELK rejects an edge with a missing endpoint, so filter defensively — a stale
    // edge would otherwise take the whole diagram down rather than just itself.
    edges: edges
      .filter((e) => nodes.some((n) => n.id === e.source) && nodes.some((n) => n.id === e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  }

  const laid = await getElk().layout(graph)

  const nodePositions = new Map<string, LayoutPosition>()
  for (const child of laid.children ?? []) {
    nodePositions.set(child.id, {
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? 0,
      height: child.height ?? 0,
    })
  }

  const edgePaths = new Map<string, Array<{ x: number; y: number }>>()
  for (const edge of laid.edges ?? []) {
    const section = edge.sections?.[0]
    if (!section) continue
    edgePaths.set(edge.id, [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ])
  }

  return {
    nodes: nodePositions,
    edges: edgePaths,
    width: laid.width ?? 0,
    height: laid.height ?? 0,
  }
}

/** Rounded orthogonal path through ELK's bend points. */
export function toSvgPath(points: Array<{ x: number; y: number }>, radius = 8): string {
  if (points.length < 2) return ''
  if (points.length === 2) {
    return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`
  }

  let d = `M ${points[0]!.x} ${points[0]!.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!
    const curr = points[i]!
    const next = points[i + 1]!

    // Shrink the corner radius if either leg is too short, or the curve overshoots
    // the segment and the line visibly doubles back.
    const inLength = Math.hypot(curr.x - prev.x, curr.y - prev.y)
    const outLength = Math.hypot(next.x - curr.x, next.y - curr.y)
    const r = Math.min(radius, inLength / 2, outLength / 2)

    const enter = {
      x: curr.x - ((curr.x - prev.x) / (inLength || 1)) * r,
      y: curr.y - ((curr.y - prev.y) / (inLength || 1)) * r,
    }
    const exit = {
      x: curr.x + ((next.x - curr.x) / (outLength || 1)) * r,
      y: curr.y + ((next.y - curr.y) / (outLength || 1)) * r,
    }

    d += ` L ${enter.x} ${enter.y} Q ${curr.x} ${curr.y} ${exit.x} ${exit.y}`
  }
  const last = points[points.length - 1]!
  return `${d} L ${last.x} ${last.y}`
}
