<script setup lang="ts">
/**
 * Generative hero artwork: the brand mark (a broken orbit ring with a
 * pointer) blown up into a living system — hairline orbit rings at tilted
 * angles, scattered waypoint nodes, and a comet pointer traveling a closed
 * path with a fading trail (the same visual the product's virtual cursor
 * draws on real pages). Single cyan-on-ink palette; reduced-motion renders
 * one static composition; hidden tabs stop the rAF loop.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const host = ref<HTMLDivElement | null>(null)
/** Teardown registered by the mounted hook, run at component unmount. */
let teardown: (() => void) | undefined

onBeforeUnmount(() => { teardown?.() })

onMounted(() => {
  const el = host.value
  if (el === null) return
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  el.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  if (ctx === null) return

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const dpr = Math.min(window.devicePixelRatio || 1, 2)

  const draw = (t: number): void => {
    const w = el.clientWidth
    const h = el.clientHeight
    if (w === 0 || h === 0) return
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${String(w)}px`
    canvas.style.height = `${String(h)}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const cx = w * 0.66
    const cy = h * 0.44
    const base = Math.min(w, h) * 0.52

    // Orbit rings: tilted ellipses, hairline, brighter arc segment sweeping.
    const rings = [
      { rx: 1.0, ry: 0.38, rot: -0.30, alpha: 0.30, phase: 0.9 },
      { rx: 0.78, ry: 0.30, rot: 0.22, alpha: 0.22, phase: 2.1 },
      { rx: 1.22, ry: 0.46, rot: -0.08, alpha: 0.16, phase: 4.4 },
      { rx: 0.52, ry: 0.52, rot: 0.0, alpha: 0.12, phase: 1.6 },
    ]
    for (const ring of rings) {
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(ring.rot)
      ctx.beginPath()
      ctx.ellipse(0, 0, base * ring.rx, base * ring.ry, 0, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(122, 173, 255, ${String(ring.alpha * 0.55)})`
      ctx.lineWidth = 1
      ctx.stroke()
      // The traveling bright arc — the "activity" reading of an orbit.
      const sweep = Math.PI * 0.5
      const start = ring.phase + t * 0.00018
      ctx.beginPath()
      ctx.ellipse(0, 0, base * ring.rx, base * ring.ry, 0, start, start + sweep)
      const grad = ctx.createLinearGradient(-base * ring.rx, 0, base * ring.rx, 0)
      grad.addColorStop(0, 'rgba(103, 232, 249, 0)')
      grad.addColorStop(1, 'rgba(103, 232, 249, 0.85)')
      ctx.strokeStyle = grad
      ctx.lineWidth = 1.4
      ctx.stroke()
      ctx.restore()
    }

    // Waypoint nodes sitting on the rings, pulsing softly.
    const nodes = [
      { ring: rings[0]!, a: 1.1, size: 2.2 },
      { ring: rings[1]!, a: 3.7, size: 1.7 },
      { ring: rings[2]!, a: 5.2, size: 1.9 },
      { ring: rings[0]!, a: 4.4, size: 1.5 },
      { ring: rings[2]!, a: 2.3, size: 2.6 },
    ]
    for (const node of nodes) {
      const rx = base * node.ring.rx
      const ry = base * node.ring.ry
      const x = cx + Math.cos(node.a) * rx * Math.cos(node.ring.rot) - Math.sin(node.a) * ry * Math.sin(node.ring.rot)
      const y = cy + Math.cos(node.a) * rx * Math.sin(node.ring.rot) + Math.sin(node.a) * ry * Math.cos(node.ring.rot)
      const pulse = 0.55 + 0.45 * Math.sin(t * 0.0012 + node.a * 3)
      ctx.beginPath()
      ctx.arc(x, y, node.size + pulse * 1.2, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(103, 232, 249, ${String(0.25 + pulse * 0.45)})`
      ctx.fill()
    }

    // The comet pointer: a closed Lissajous-ish path with a fading trail.
    const trail = 90
    for (let i = trail; i >= 0; i -= 1) {
      const p = (t * 0.00042) - i * 0.012
      const rx = base * 1.0
      const ry = base * 0.38
      const rot = rings[0]!.rot
      const ox = Math.cos(p * 1.0 + 0.4)
      const oy = Math.sin(p * 2.0) * 0.5 + Math.sin(p * 1.0) * 0.5
      const ex = ox * rx
      const ey = oy * ry
      const x = cx + ex * Math.cos(rot) - ey * Math.sin(rot)
      const y = cy + ex * Math.sin(rot) + ey * Math.cos(rot)
      const k = 1 - i / trail
      ctx.beginPath()
      ctx.arc(x, y, 0.8 + k * 2.2, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(103, 232, 249, ${String(k * k * 0.75)})`
      ctx.fill()
      if (i === 0) {
        ctx.beginPath()
        ctx.arc(x, y, 4.5, 0, Math.PI * 2)
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 5)
        glow.addColorStop(0, 'rgba(103, 232, 249, 0.9)')
        glow.addColorStop(1, 'rgba(103, 232, 249, 0)')
        ctx.fillStyle = glow
        ctx.fill()
      }
    }
  }

  let raf = 0
  let running = false
  const start = (): void => {
    if (running || reduced) return
    running = true
    const loop = (t: number): void => {
      draw(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
  }
  const stop = (): void => {
    running = false
    cancelAnimationFrame(raf)
  }

  if (reduced) {
    draw(4000)
  } else {
    start()
  }

  const onVisibility = (): void => {
    if (document.hidden) stop()
    else start()
  }
  document.addEventListener('visibilitychange', onVisibility)

  let resizeRaf = 0
  const onResize = (): void => {
    cancelAnimationFrame(resizeRaf)
    resizeRaf = requestAnimationFrame(() => { draw(performance.now()) })
  }
  const ro = new ResizeObserver(onResize)
  ro.observe(el)

  teardown = () => {
    stop()
    document.removeEventListener('visibilitychange', onVisibility)
    ro.disconnect()
    cancelAnimationFrame(resizeRaf)
  }
})
</script>

<template>
  <div ref="host" class="orbit-art" aria-hidden="true" />
</template>

<style scoped>
.orbit-art {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  /* Fade the composition out toward the page edges so it reads as one
     breathed-in layer behind the hero, never a boxed graphic. */
  -webkit-mask-image: radial-gradient(58% 62% at 66% 42%, #000 0%, transparent 78%);
  mask-image: radial-gradient(58% 62% at 66% 42%, #000 0%, transparent 78%);
}

@media (prefers-reduced-motion: reduce) {
  .orbit-art {
    opacity: 0.7;
  }
}
</style>
