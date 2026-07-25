<script setup lang="ts">
import gsap from 'gsap'
import { Flip } from 'gsap/Flip'
import { CARDINALITY_LABELS } from '#shared/constants'

/**
 * The ERD canvas.
 *
 * Division of labour, which is what keeps this tractable:
 *   elkjs  decides where things go (in a worker)
 *   SVG    draws them
 *   GSAP   owns every transform and animates between layouts
 *
 * The hard rule is that Vue never binds `transform` on an element GSAP animates.
 * Layout coordinates live in a non-reactive Map; if Vue also wrote transforms, a
 * re-render mid-tween would fight the tween and nodes would visibly stutter.
 */

const props = defineProps<{
  nodes: any[]
  edges: any[]
  collapsed: boolean
  /** Field IDs to highlight; everything else dims. */
  highlightRecordIds?: string[] | null
}>()

const emit = defineEmits<{ select: [id: string] }>()

if (import.meta.client) gsap.registerPlugin(Flip)

const ROW_HEIGHT = 20
const HEADER_HEIGHT = 42
const NODE_WIDTH = 236
const MAX_VISIBLE_ROWS = 8

const container = ref<HTMLElement | null>(null)
const cameraGroup = ref<SVGGElement | null>(null)
const laying = ref(false)
const expanded = ref<Set<string>>(new Set())

/**
 * Non-reactive on purpose — GSAP reads these to place nodes, and making them
 * reactive would re-render the SVG on every frame of a Flip tween.
 */
let positions = new Map<string, { x: number; y: number; width: number; height: number }>()
const edgePaths = ref<Map<string, string>>(new Map())
const canvasSize = ref({ width: 0, height: 0 })
const layoutVersion = ref(0)

const prefersReducedMotion = import.meta.client
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false
const duration = (seconds: number) => (prefersReducedMotion ? 0 : seconds)

function visibleRows(node: any): any[] {
  if (props.collapsed) return []
  const fields = node.fields ?? []
  return expanded.value.has(node.id) ? fields : fields.slice(0, MAX_VISIBLE_ROWS)
}

function nodeHeight(node: any): number {
  if (props.collapsed) return 64
  return HEADER_HEIGHT + visibleRows(node).length * ROW_HEIGHT + 10
}

const camera = reactive({ x: 0, y: 0, k: 1 })

function applyCamera() {
  if (cameraGroup.value) {
    gsap.set(cameraGroup.value, {
      x: camera.x,
      y: camera.y,
      scale: camera.k,
      transformOrigin: '0 0',
    })
  }
}

async function relayout(animate = true) {
  if (!import.meta.client || props.nodes.length === 0) {
    canvasSize.value = { width: 0, height: 0 }
    return
  }
  laying.value = true

  // Capture where things are now, before the DOM changes, so Flip can tween from
  // here to wherever ELK decides they belong.
  const state =
    animate && positions.size > 0
      ? Flip.getState(container.value?.querySelectorAll('.erd-node') ?? [])
      : null

  try {
    const result = await computeLayout(
      props.nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: nodeHeight(n) })),
      props.edges.map((e) => ({
        id: e.id,
        source: e.parentRecordId,
        target: e.childRecordId,
      })),
    )

    positions = result.nodes
    canvasSize.value = { width: result.width, height: result.height }

    const paths = new Map<string, string>()
    for (const [id, points] of result.edges) paths.set(id, toSvgPath(points))
    edgePaths.value = paths
    layoutVersion.value++

    await nextTick()
    placeNodes()

    if (state) {
      Flip.from(state, {
        duration: duration(0.55),
        ease: 'power2.inOut',
        stagger: 0.008,
        absolute: true,
        onEnter: (els) =>
          gsap.fromTo(
            els,
            { opacity: 0, scale: 0.9 },
            { opacity: 1, scale: 1, duration: duration(0.3) },
          ),
        onLeave: (els) => gsap.to(els, { opacity: 0, scale: 0.9, duration: duration(0.2) }),
      })
    } else {
      // First paint: assemble left to right, following the layered order, so the
      // diagram reads as "dependencies first".
      const els = container.value?.querySelectorAll('.erd-node')
      if (els?.length) {
        gsap.fromTo(
          els,
          { opacity: 0, scale: 0.92 },
          {
            opacity: 1,
            scale: 1,
            duration: duration(0.4),
            stagger: { amount: duration(0.5), from: 'start' },
          },
        )
      }
      fitToView(false)
    }
  } finally {
    laying.value = false
  }
}

/** GSAP writes node transforms; Vue only ever renders the node's contents. */
function placeNodes() {
  const root = container.value
  if (!root) return
  for (const [id, pos] of positions) {
    const el = root.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
    if (el) gsap.set(el, { x: pos.x, y: pos.y })
  }
}

function fitToView(animate = true) {
  const el = container.value
  if (!el || canvasSize.value.width === 0) return

  const padding = 40
  const scale = Math.min(
    (el.clientWidth - padding * 2) / canvasSize.value.width,
    (el.clientHeight - padding * 2) / canvasSize.value.height,
    1.2,
  )
  const target = {
    k: Math.max(scale, 0.15),
    x: (el.clientWidth - canvasSize.value.width * Math.max(scale, 0.15)) / 2,
    y: (el.clientHeight - canvasSize.value.height * Math.max(scale, 0.15)) / 2,
  }

  if (animate && !prefersReducedMotion) {
    gsap.to(camera, { ...target, duration: 0.5, ease: 'power2.out', onUpdate: applyCamera })
  } else {
    Object.assign(camera, target)
    applyCamera()
  }
}

function focusNode(id: string) {
  const pos = positions.get(id)
  const el = container.value
  if (!pos || !el) return

  const k = Math.max(camera.k, 0.9)
  gsap.to(camera, {
    k,
    x: el.clientWidth / 2 - (pos.x + pos.width / 2) * k,
    y: el.clientHeight / 2 - (pos.y + pos.height / 2) * k,
    duration: duration(0.5),
    ease: 'power2.out',
    onUpdate: applyCamera,
  })
}

defineExpose({ fitToView, focusNode })

// --- panning and zooming ---------------------------------------------------

let dragging = false
let dragStart = { x: 0, y: 0, camX: 0, camY: 0 }

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  dragging = true
  dragStart = { x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y }
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (!dragging) return
  camera.x = dragStart.camX + (event.clientX - dragStart.x)
  camera.y = dragStart.camY + (event.clientY - dragStart.y)
  applyCamera()
}

function onPointerUp(event: PointerEvent) {
  dragging = false
  ;(event.currentTarget as Element).releasePointerCapture?.(event.pointerId)
}

function onWheel(event: WheelEvent) {
  event.preventDefault()
  const el = container.value
  if (!el) return

  const rect = el.getBoundingClientRect()
  const px = event.clientX - rect.left
  const py = event.clientY - rect.top

  const next = Math.min(2.5, Math.max(0.1, camera.k * (event.deltaY < 0 ? 1.1 : 0.9)))
  // Zoom about the cursor rather than the origin, so the point under the pointer
  // stays put — anything else feels like the diagram is sliding away.
  camera.x = px - ((px - camera.x) / camera.k) * next
  camera.y = py - ((py - camera.y) / camera.k) * next
  camera.k = next
  applyCamera()
}

function toggleExpand(id: string) {
  const next = new Set(expanded.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expanded.value = next
  relayout(true)
}

// --- highlight / dim -------------------------------------------------------

const highlighted = computed(() =>
  props.highlightRecordIds ? new Set(props.highlightRecordIds) : null,
)

const isDimmed = (id: string) => Boolean(highlighted.value && !highlighted.value.has(id))

watch(
  () => [props.nodes, props.edges, props.collapsed],
  () => relayout(positions.size > 0),
  { deep: false },
)

onMounted(() => {
  relayout(false)
  applyCamera()
})

/**
 * GSAP context scoped to this component: reverted on unmount so tweens cannot
 * outlive the canvas and write to detached nodes after a route change.
 */
let ctx: gsap.Context | null = null
onMounted(() => {
  ctx = gsap.context(() => {}, container.value ?? undefined)
})
onBeforeUnmount(() => ctx?.revert())

const edgeMidpoint = (id: string) => {
  const path = edgePaths.value.get(id)
  if (!path) return null
  const match = [...path.matchAll(/([\d.-]+) ([\d.-]+)/g)]
  const mid = match[Math.floor(match.length / 2)]
  return mid ? { x: Number(mid[1]), y: Number(mid[2]) } : null
}
</script>

<template>
  <div
    ref="container"
    class="relative h-[calc(100vh-13rem)] overflow-hidden rounded-lg border border-default bg-elevated/20"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
  >
    <div
      v-if="laying"
      class="absolute right-3 top-3 z-10 rounded-md bg-default px-2 py-1 text-xs text-muted shadow-sm"
    >
      Laying out…
    </div>

    <div class="absolute bottom-3 right-3 z-10 flex gap-1">
      <UButton
        icon="i-lucide-maximize"
        size="xs"
        color="neutral"
        variant="solid"
        title="Fit to view"
        @click="fitToView()"
      />
    </div>

    <svg class="size-full cursor-grab active:cursor-grabbing" :class="dragging && 'cursor-grabbing'">
      <defs>
        <marker
          id="erd-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ui-border-inverted)" />
        </marker>
      </defs>

      <g ref="cameraGroup">
        <g class="edges">
          <g v-for="edge in edges" :key="edge.id">
            <path
              :d="edgePaths.get(edge.id)"
              fill="none"
              stroke="var(--ui-border-inverted)"
              class="transition-opacity"
              :stroke-width="collapsed ? Math.min(1 + (edge.weight ?? 1) * 0.6, 5) : 1.5"
              :stroke-dasharray="edge.isIdentifying === false ? '4 3' : undefined"
              marker-end="url(#erd-arrow)"
              :opacity="
                highlighted &&
                !(highlighted.has(edge.parentRecordId) && highlighted.has(edge.childRecordId))
                  ? 0.12
                  : 0.75
              "
            />
            <text
              v-if="!collapsed && edgeMidpoint(edge.id)"
              :x="edgeMidpoint(edge.id)!.x"
              :y="edgeMidpoint(edge.id)!.y - 4"
              text-anchor="middle"
              fill="var(--ui-text-dimmed)"
              class="text-[9px]"
            >
              {{ CARDINALITY_LABELS[edge.cardinality] ?? '' }}
            </text>
          </g>
        </g>

        <g class="nodes">
          <g
            v-for="node in nodes"
            :key="node.id"
            :data-node-id="node.id"
            class="erd-node cursor-pointer transition-opacity"
            :opacity="isDimmed(node.id) ? 0.15 : 1"
            @click.stop="emit('select', node.id)"
            @dblclick.stop="collapsed ? null : toggleExpand(node.id)"
          >
            <rect
              :width="NODE_WIDTH"
              :height="nodeHeight(node)"
              rx="8"
              fill="var(--ui-bg)"
              stroke="var(--ui-border-accented)"
              stroke-width="1"
            />
            <rect
              :width="NODE_WIDTH"
              :height="4"
              rx="2"
              :fill="node.moduleColor ?? '#94a3b8'"
            />

            <text x="12" y="26" fill="var(--ui-text-highlighted)" class="text-[13px] font-medium">
              {{ node.label ?? node.apiName }}
            </text>
            <text
              v-if="collapsed"
              x="12"
              y="46"
              fill="var(--ui-text-muted)"
              class="text-[11px]"
            >
              {{ node.recordCount }} record{{ node.recordCount === 1 ? '' : 's' }}
            </text>
            <text
              v-else
              :x="NODE_WIDTH - 12"
              y="26"
              text-anchor="end"
              fill="var(--ui-text-dimmed)"
              class="text-[10px]"
            >
              {{ node.origin === 'native' ? 'native' : 'custom' }}
            </text>

            <g v-if="!collapsed">
              <line
                x1="0"
                :x2="NODE_WIDTH"
                :y1="HEADER_HEIGHT - 8"
                :y2="HEADER_HEIGHT - 8"
                stroke="var(--ui-border-accented)"
                stroke-width="1"
              />
              <g
                v-for="(field, i) in visibleRows(node)"
                :key="field.id"
                :transform="`translate(0, ${HEADER_HEIGHT + i * ROW_HEIGHT})`"
              >
                <text x="12" y="12" fill="var(--ui-text-muted)" class="text-[11px]">
                  {{ field.label ?? field.apiName }}
                </text>
                <text
                  v-if="field.isPrimaryKey"
                  :x="NODE_WIDTH - 12"
                  y="12"
                  text-anchor="end"
                  fill="var(--ui-color-warning-500)"
                  class="text-[9px] font-medium"
                >PK</text>
                <circle
                  v-else-if="field.sourceKind !== 'user_entry'"
                  :cx="NODE_WIDTH - 16"
                  cy="8"
                  r="3"
                  :fill="
                    field.sourceKind === 'derived'
                      ? 'var(--ui-color-primary-500)'
                      : 'var(--ui-color-info-500)'
                  "
                />
              </g>
              <text
                v-if="(node.fields?.length ?? 0) > visibleRows(node).length"
                x="12"
                :y="HEADER_HEIGHT + visibleRows(node).length * ROW_HEIGHT + 12"
                fill="var(--ui-text-dimmed)"
                class="text-[10px] italic"
              >
                +{{ node.fields.length - visibleRows(node).length }} more — double-click
              </text>
            </g>
          </g>
        </g>
      </g>
    </svg>
  </div>
</template>
