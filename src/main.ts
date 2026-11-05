import './style.css'
import { ROUTES } from './routes'
import { loadGpx } from './gpx'
import {
  buildRoute,
  haversine,
  isClosed,
  moveByMeters,
  nearestPoint,
  project,
  routeFrom,
  splitAt,
  type LngLat,
  type RouteData,
} from './geo'
import { MapView } from './map'
import { Tracker, type Fix } from './nav'

const mapView = new MapView('map')
const tracker = new Tracker()

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`找不到 #${id}`)
  return node as T
}

const ui = {
  simToggle: el<HTMLButtonElement>('simToggle'),
  toast: el('toast'),

  paneBrowse: el('paneBrowse'),
  panePreview: el('panePreview'),
  paneRun: el('paneRun'),
  routeCount: el('routeCount'),
  routeList: el('routeList'),
  browseHint: el('browseHint'),
  relocate: el<HTMLButtonElement>('relocate'),

  pvName: el('pvName'),
  pvNote: el('pvNote'),
  pvTotal: el('pvTotal'),
  startInfo: el('startInfo'),
  startMode: el('startMode'),
  startRun: el<HTMLButtonElement>('startRun'),
  backToBrowse: el<HTMLButtonElement>('backToBrowse'),

  runName: el('runName'),
  runNote: el('runNote'),
  runTotal: el('runTotal'),
  pct: el('pct'),
  left: el('left'),
  off: el('off'),
  bar: el('bar'),
  status: el('status'),
  stats: el('stats'),
  locate: el<HTMLButtonElement>('locate'),
  endRun: el<HTMLButtonElement>('endRun'),

  summary: el('summary'),
  smTitle: el('smTitle'),
  smNote: el('smNote'),
  smPct: el('smPct'),
  smTime: el('smTime'),
  smDist: el('smDist'),
  smSpeed: el('smSpeed'),
  smOff: el('smOff'),
  smShot: el<HTMLCanvasElement>('smShot'),
  smShotEmpty: el('smShotEmpty'),
  smClose: el<HTMLButtonElement>('smClose'),

  sim: el('sim'),
  simSnap: el<HTMLButtonElement>('simSnap'),
  dpad: el('dpad'),
}

type Phase = 'browse' | 'preview' | 'run'
type Dir = 'up' | 'down' | 'left' | 'right'

let phase: Phase = 'browse'
let routes: RouteData[] = []
let activeId: string | null = null
let runRoute: RouteData | null = null
let previewRoute: RouteData | null = null
let previewLeadIn = 0
let runLeadIn = 0
let startAlong = 0

let currentFix: Fix | null = null
let lastAlong: number | null = null
let finished = false
let farNotified = false
let toastTimer = 0

/** 起跑後實際走出來的軌跡，可能因為訊號中斷斷成多段 */
let trace: LngLat[][] = []

/* ---------------- 本次跑圖統計 ---------------- */

let runStartedAt = 0
let traceDistance = 0
let deviationSum = 0
let deviationCount = 0
let lastPct = 0

/* ---------------- 模擬位置 ---------------- */

const SIM_ACCURACY = 8
const SIM_SPEED = 700 // m/s，長按移動鍵時的速度

let simMode = false
let simPos: LngLat | null = null
const pressed = new Set<Dir>()
let simRaf = 0
let simLast = 0
let lastFollowAt = 0

/* ---------------- UI 小工具 ---------------- */

type Tone = 'idle' | 'ok' | 'warn' | 'bad'

function setStatus(text: string, tone: Tone): void {
  ui.status.textContent = text
  ui.status.className = `pill ${tone === 'idle' ? '' : tone}`.trim()
}

function showToast(message: string, ms = 2600): void {
  ui.toast.textContent = message
  ui.toast.classList.add('show')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), ms)
}

function fmtDist(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`
  return `${(meters / 1000).toFixed(1)} km`
}

function routeById(id: string | null): RouteData | null {
  if (!id) return null
  return routes.find((r) => r.id === id) ?? null
}

function activeRoute(): RouteData | null {
  return routeById(activeId)
}

function closestRoute(pos: LngLat): RouteData | null {
  const candidates = runRoute ? [runRoute] : routes
  let best: RouteData | null = null
  let bestDist = Infinity
  for (const r of candidates) {
    const d = nearestPoint(r, pos).dist
    if (d < bestDist) {
      bestDist = d
      best = r
    }
  }
  return best
}

/* ---------------- 路線清單 ---------------- */

function buildRouteList(): void {
  ui.routeList.innerHTML = ''
  for (const route of routes) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'route-card'
    card.dataset.id = route.id

    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    swatch.style.background = route.color

    const main = document.createElement('span')
    main.className = 'rc-main'
    const name = document.createElement('span')
    name.className = 'rc-name'
    name.textContent = route.name
    const note = document.createElement('span')
    note.className = 'rc-note'
    note.textContent = route.note
    main.append(name, note)

    const meta = document.createElement('span')
    meta.className = 'rc-meta'
    const km = document.createElement('span')
    km.className = 'rc-km'
    km.textContent = `${(route.total / 1000).toFixed(1)} km`
    const near = document.createElement('span')
    near.className = 'rc-near'
    near.dataset.near = route.id
    near.textContent = '—'
    meta.append(km, near)

    card.append(swatch, main, meta)
    card.addEventListener('click', () => enterPreview(route.id))
    ui.routeList.appendChild(card)
  }

  ui.routeCount.textContent = routes.length > 0 ? `${routes.length} 條` : ''
  updateBrowseDistances()
}

function updateBrowseDistances(): void {
  const pos: LngLat | null = currentFix ? [currentFix.lon, currentFix.lat] : null
  for (const route of routes) {
    const node = ui.routeList.querySelector<HTMLElement>(`[data-near="${route.id}"]`)
    if (!node) continue
    node.textContent = pos ? `距你 ${fmtDist(nearestPoint(route, pos).dist)}` : '未定位'
  }
}

/* ---------------- 流程 ---------------- */

function setPhase(next: Phase): void {
  phase = next
  ui.paneBrowse.hidden = next !== 'browse'
  ui.panePreview.hidden = next !== 'preview'
  ui.paneRun.hidden = next !== 'run'
  ui.startMode.hidden = true
}

function enterBrowse(): void {
  activeId = null
  runRoute = null
  previewRoute = null
  previewLeadIn = 0
  runLeadIn = 0
  lastAlong = null
  finished = false
  startAlong = 0

  trace = []
  mapView.setTrace([])
  mapView.setActive(null)
  mapView.setStartPoint(null)
  mapView.setReference(null)
  mapView.fitAll()
  setPhase('browse')
  updateBrowseDistances()
}

function enterPreview(id: string): void {
  const route = routeById(id)
  if (!route) return

  activeId = id
  runRoute = null
  previewRoute = null
  previewLeadIn = 0
  runLeadIn = 0
  lastAlong = null
  finished = false
  startAlong = 0

  ui.pvName.textContent = route.name
  ui.pvNote.textContent = route.note
  ui.pvTotal.textContent = (route.total / 1000).toFixed(1)

  mapView.setStartPoint(null)
  setPhase('preview')
  updatePreviewRoutes()
  mapView.fitRoute(previewRoute ?? route)
}

/**
 * 把「你目前站的位置」接到路線切入點前面。
 * 這樣起跑後是從腳下開始走，不會被瞬移到路線上最近的點。
 */
function withApproach(
  route: RouteData,
  here: LngLat,
): { route: RouteData; leadIn: number } {
  const gap = haversine(here, route.coords[0])
  if (gap <= 2) return { route, leadIn: 0 }
  return { route: buildRoute(route, [here, ...route.coords]), leadIn: gap }
}

/** 依目前位置與起跑方式，算出實際要跑的路線並畫在地圖上 */
function updatePreviewRoutes(): void {
  const route = activeRoute()
  if (!route) return

  const near = currentFix ? nearestPoint(route, [currentFix.lon, currentFix.lat]) : null

  const here: LngLat | null = currentFix ? [currentFix.lon, currentFix.lat] : null
  const useNearest = currentFix !== null && near !== null
  // 閉環的「終點」其實就是起點，別讓它顯示成 100% 處接上
  const atLoopEnd = useNearest && near !== null && isClosed(route) && near.along >= route.total - 30
  startAlong = useNearest && !atLoopEnd ? near.along : 0
  const entry = useNearest && !atLoopEnd ? near.point : route.coords[0]

  // 起點就是「你現在站的地方」；只有選擇原始起點時才回到 GPX 起點
  const startPoint = useNearest && here ? here : entry
  const planned = routeFrom(route, startAlong)
  const { route: shown, leadIn } = useNearest && here
    ? withApproach(planned, here)
    : { route: planned, leadIn: 0 }

  previewRoute = shown
  previewLeadIn = leadIn

  mapView.setActive(shown, { endpoints: false })
  mapView.setStartPoint(startPoint)
  // 原路徑上「不會跑到」的前段，用深灰實線標出來
  updateReference(route, startAlong)
  ui.startMode.hidden = true

  if (!currentFix) {
    ui.startInfo.textContent = '尚未定位，將從路線起點開始'
    return
  }

  if (useNearest) {
    const where = startAlong > 1
      ? `路線 ${Math.round((startAlong / route.total) * 100)}% 處`
      : '路線起點'
    const gap = near.dist < 3 ? '站在路線上' : `離路線 ${fmtDist(near.dist)}`
    ui.startInfo.textContent = `從你目前位置起跑｜${gap}，${where}接上`
    return
  }

  const dist = haversine(here ?? entry, entry)
  ui.startInfo.textContent = `距起點 ${fmtDist(dist)}｜從原起點起跑`
}

/** 把原路徑上「起跑點之前」的那一段畫成深灰實線（跑不到的部分），標記上寫原始起跑百分比 */
function updateReference(base: RouteData, along: number): void {
  if (along > 1) {
    const pct = base.total > 0 ? Math.round((along / base.total) * 100) : 0
    mapView.setReference(splitAt(base, along).done, `原 ${pct}%`)
  } else {
    mapView.setReference(null)
  }
}

/** 記錄實際走過的點；跳躍太大（吸附、重新定位）就開新的一段 */
function pushTrace(f: Fix): void {
  const point: LngLat = [f.lon, f.lat]
  const segment = trace[trace.length - 1]
  const last = segment?.[segment.length - 1]
  if (last && haversine(last, point) > 200) {
    trace.push([point])
  } else if (last) {
    const step = haversine(last, point)
    if (step > 2) {
      segment.push(point)
      traceDistance += step
    } else {
      return
    }
  } else {
    trace.push([point])
  }
  mapView.setTrace(trace)
}

function startRun(): void {
  const base = activeRoute()
  if (!base) return

  const along = currentFix ? startAlong : 0
  const next = previewRoute ?? routeFrom(base, along)

  runRoute = next
  runLeadIn = previewLeadIn
  lastAlong = 0
  finished = false
  farNotified = false
  trace = []
  traceDistance = 0
  deviationSum = 0
  deviationCount = 0
  lastPct = 0
  runStartedAt = Date.now()
  mapView.setTrace([])

  ui.runName.textContent = base.name
  ui.runNote.textContent =
    along > 1 ? `${base.note}｜從 ${Math.round((along / base.total) * 100)}% 處起跑` : base.note
  ui.runTotal.textContent = (next.total / 1000).toFixed(1)

  // 規劃路線退成灰藍色，實際軌跡（橘）才是主角
  mapView.setActive(next, { endpoints: true, muted: true })
  mapView.setStartPoint(null)
  // 起跑後仍保留原路徑的「未跑段」深灰實線，對照百分比
  updateReference(base, along)
  mapView.fitRoute(next)
  setPhase('run')
  resetRunStats()

  if (simMode && simPos) {
    // 模擬中：就從假位置原地起跑，不把它瞬移到路線上
    pushSimFix()
  } else {
    applyFix(currentFix)
  }
  showToast('開始跑圖！沿著路線跑，偏離時看下方數字', 2600)
}

function endRun(): void {
  const summary = buildRunSummary()
  enterBrowse()
  openSummary(summary)
}

/* ---------------- 結束跑圖的總結 ---------------- */

interface RunSummary {
  name: string
  note: string
  pct: number
  seconds: number
  distance: number
  avgSpeed: number | null
  avgDeviation: number | null
  segments: LngLat[][]
  plan: LngLat[] | null
}

function buildRunSummary(): RunSummary {
  const route = runRoute
  const seconds = runStartedAt > 0 ? (Date.now() - runStartedAt) / 1000 : 0
  return {
    name: route?.name ?? '跑圖',
    note: ui.runNote.textContent ?? '',
    pct: lastPct,
    seconds,
    distance: traceDistance,
    avgSpeed: seconds >= 1 && traceDistance > 1 ? traceDistance / seconds : null,
    avgDeviation: deviationCount > 0 ? deviationSum / deviationCount : null,
    segments: trace.map((seg) => [...seg]),
    plan: route ? route.coords : null,
  }
}

function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 把這次的軌跡畫成一張圖：淡灰是規劃路線，橘色是實際走過的路 */
function drawTrace(canvas: HTMLCanvasElement, segments: LngLat[][], plan: LngLat[] | null): boolean {
  const points = segments.flat()
  if (points.length < 2) return false

  const W = 840
  const H = 630
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return false

  ctx.fillStyle = '#eef1f6'
  ctx.fillRect(0, 0, W, H)

  const M_PER_DEG = 111320
  const lats = points.map((p) => p[1])
  const lons = points.map((p) => p[0])
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2
  const kx = Math.cos((midLat * Math.PI) / 180) * M_PER_DEG

  const toMeters = (p: LngLat): [number, number] => [
    (p[0] - centerLon) * kx,
    (p[1] - midLat) * M_PER_DEG,
  ]

  const local = points.map(toMeters)
  const xs = local.map((p) => p[0])
  const ys = local.map((p) => p[1])
  // 幾乎沒移動時不要把畫面放到無限大
  const spanX = Math.max(60, Math.max(...xs) - Math.min(...xs))
  const spanY = Math.max(60, Math.max(...ys) - Math.min(...ys))

  const pad = 48
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY)
  const project = (p: LngLat): [number, number] => {
    const [mx, my] = toMeters(p)
    return [W / 2 + mx * scale, H / 2 - my * scale]
  }

  const tracePath = (coords: LngLat[]): void => {
    ctx.beginPath()
    coords.forEach((p, i) => {
      const [x, y] = project(p)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }

  // 這次的規劃路線（淡淡的，當背景）
  if (plan && plan.length > 1) {
    ctx.strokeStyle = 'rgba(122, 130, 150, 0.28)'
    ctx.lineWidth = 7
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    tracePath(plan)
  }

  // 實際軌跡：白色描邊讓它在任何底色上都清楚
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const [color, width] of [
    ['rgba(255, 255, 255, 0.95)', 15],
    ['#ff6b2c', 8],
  ] as const) {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    for (const seg of segments) {
      if (seg.length >= 2) tracePath(seg)
    }
  }

  const dot = (p: LngLat, color: string): void => {
    const [x, y] = project(p)
    ctx.beginPath()
    ctx.arc(x, y, 8, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, 5, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
  }
  dot(points[0], '#0f9d6e')
  dot(points[points.length - 1], '#14161c')

  return true
}

function openSummary(summary: RunSummary): void {
  ui.smTitle.textContent = summary.name
  ui.smNote.textContent = summary.note
  ui.smPct.textContent = String(Math.min(100, Math.round(summary.pct)))
  ui.smTime.textContent = fmtDuration(summary.seconds)
  ui.smDist.innerHTML =
    summary.distance < 1000
      ? `${Math.round(summary.distance)}<small> m</small>`
      : `${(summary.distance / 1000).toFixed(2)}<small> km</small>`
  ui.smSpeed.innerHTML =
    summary.avgSpeed === null
      ? '—'
      : `${(summary.avgSpeed * 3.6).toFixed(1)}<small> km/h</small>`
  ui.smOff.innerHTML =
    summary.avgDeviation === null
      ? '—'
      : `${Math.round(summary.avgDeviation)}<small> m</small>`

  const drawn = drawTrace(ui.smShot, summary.segments, summary.plan)
  ui.smShot.hidden = !drawn
  ui.smShotEmpty.hidden = drawn
  ui.summary.hidden = false
  ui.smClose.focus()
}

function closeSummary(): void {
  if (ui.summary.hidden) return
  ui.summary.hidden = true
}

/* ---------------- 進度 ---------------- */

function resetRunStats(): void {
  ui.pct.textContent = '0'
  ui.left.textContent = runRoute ? (runRoute.total / 1000).toFixed(1) : '—'
  ui.off.textContent = '--'
  ui.bar.style.width = '0%'
  ui.bar.style.background = ''
  ui.stats.classList.toggle('dim', !currentFix)
  setStatus('尚未定位', 'idle')
}

function applyFix(f: Fix | null): void {
  currentFix = f
  ui.relocate.hidden = f !== null
  mapView.setPosition(f)

  if (phase === 'browse') {
    updateBrowseDistances()
    return
  }

  if (phase === 'preview') {
    updatePreviewRoutes()
    return
  }

  if (!runRoute) return
  if (!f) {
    resetRunStats()
    return
  }

  pushTrace(f)

  const proj = project(runRoute, [f.lon, f.lat], lastAlong)
  lastAlong = proj.along

  // 百分比只算「路線本身」，從你腳下走到切入點的那一小段不算進度
  const routeSpan = Math.max(1, runRoute.total - runLeadIn)
  const covered = Math.max(0, proj.along - runLeadIn)
  const pct = Math.max(0, Math.min(100, (covered / routeSpan) * 100))
  // 剩餘距離則包含還沒走完的接駁段
  const remaining = Math.max(0, runRoute.total - proj.along)
  // 偏離距離小於 GPS 誤差時，一律視為在線上
  const deviation = proj.dist <= f.accuracy ? 0 : proj.dist

  lastPct = pct
  if (!finished) {
    deviationSum += deviation
    deviationCount += 1
  }

  ui.pct.textContent = pct.toFixed(0)
  ui.left.textContent =
    remaining < 1000 ? (remaining / 1000).toFixed(2) : (remaining / 1000).toFixed(1)
  ui.off.textContent = deviation < 10 ? deviation.toFixed(0) : String(Math.round(deviation))
  ui.bar.style.width = `${pct}%`

  mapView.setProgress(proj.along)

  const weakGps = f.accuracy > 40
  const farAway = deviation > 300

  if (pct >= 99.5 && deviation < 20) {
    if (!finished) {
      finished = true
      showToast(`「${runRoute.name}」跑完了`, 4200)
    }
    setStatus('完成', 'ok')
    ui.stats.classList.remove('dim')
    ui.bar.style.background = ''
  } else if (farAway) {
    setStatus('不在路線上', 'bad')
    ui.stats.classList.add('dim')
    ui.bar.style.background = '#d92d20'
  } else if (weakGps) {
    setStatus(`GPS 訊號弱 ±${Math.round(f.accuracy)}m`, 'warn')
    ui.stats.classList.remove('dim')
    ui.bar.style.background = ''
  } else if (runLeadIn > 1 && proj.along < runLeadIn - 1) {
    // 還在從腳下走到路線切入點的路上，進度先不動
    setStatus('前往路線', 'idle')
    ui.stats.classList.remove('dim')
    ui.bar.style.background = ''
  } else if (deviation < 20) {
    setStatus('在路線上', 'ok')
    ui.stats.classList.remove('dim')
    ui.bar.style.background = ''
  } else if (deviation < 50) {
    setStatus('稍微偏離', 'warn')
    ui.stats.classList.remove('dim')
    ui.bar.style.background = ''
  } else {
    setStatus('偏離路線', 'bad')
    ui.stats.classList.remove('dim')
    ui.bar.style.background = '#d92d20'
  }

  if (farAway && !farNotified) {
    farNotified = true
    showToast(`你距離「${runRoute.name}」約 ${(proj.dist / 1000).toFixed(1)} km`, 3400)
  }
}

/* ---------------- 模擬位置（WASD） ---------------- */

function pushSimFix(): void {
  if (!simPos) return
  applyFix({ lon: simPos[0], lat: simPos[1], accuracy: SIM_ACCURACY, at: Date.now() })
}

function simStartPoint(): LngLat {
  if (currentFix) return [currentFix.lon, currentFix.lat]
  const route = runRoute ?? activeRoute() ?? routes[0]
  if (route) return route.coords[0]
  const c = mapView.map.getCenter()
  return [c.lng, c.lat]
}

function setSimMode(on: boolean): void {
  simMode = on
  ui.simToggle.setAttribute('aria-pressed', String(on))
  ui.sim.hidden = !on
  ui.dpad.hidden = !on

  if (on) {
    tracker.stop()
    simPos = simStartPoint()
    pushSimFix()
  } else {
    pressed.clear()
    stopSimLoop()
    simPos = null
    applyFix(null)
    tracker.start()
  }
}

function beginDir(dir: Dir): void {
  if (!simMode) return
  pressed.add(dir)
  ensureSimLoop()
}

function endDir(dir: Dir): void {
  pressed.delete(dir)
}

function ensureSimLoop(): void {
  if (simRaf || !simMode || !simPos) return
  simLast = performance.now()
  simRaf = requestAnimationFrame(simStep)
}

function stopSimLoop(): void {
  if (simRaf) cancelAnimationFrame(simRaf)
  simRaf = 0
}

function simStep(now: number): void {
  simRaf = 0
  if (!simMode || !simPos) return

  const dt = Math.min(0.1, (now - simLast) / 1000)
  simLast = now

  let dx = 0
  let dy = 0
  if (pressed.has('up')) dy += 1
  if (pressed.has('down')) dy -= 1
  if (pressed.has('right')) dx += 1
  if (pressed.has('left')) dx -= 1

  if (dx === 0 && dy === 0) return

  const len = Math.hypot(dx, dy)
  const step = SIM_SPEED * dt
  simPos = moveByMeters(simPos, (dx / len) * step, (dy / len) * step)
  pushSimFix()

  if (now - lastFollowAt > 120) {
    mapView.followPosition({ lon: simPos[0], lat: simPos[1] })
    lastFollowAt = now
  }

  simRaf = requestAnimationFrame(simStep)
}

const KEY_TO_DIR: Record<string, Dir> = {
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
}

window.addEventListener('keydown', (e) => {
  if (!ui.summary.hidden) {
    if (e.key === 'Escape') closeSummary()
    return
  }
  if (!simMode) return
  const dir = KEY_TO_DIR[e.key]
  if (!dir) return
  e.preventDefault()
  beginDir(dir)
})

window.addEventListener('keyup', (e) => {
  const dir = KEY_TO_DIR[e.key]
  if (dir) endDir(dir)
})

window.addEventListener('blur', () => pressed.clear())

function bindDpad(): void {
  for (const btn of Array.from(ui.dpad.querySelectorAll<HTMLButtonElement>('button[data-dir]'))) {
    const dir = btn.dataset.dir as Dir
    const down = (e: PointerEvent): void => {
      e.preventDefault()
      btn.setPointerCapture(e.pointerId)
      beginDir(dir)
    }
    const up = (): void => endDir(dir)
    btn.addEventListener('pointerdown', down)
    btn.addEventListener('pointerup', up)
    btn.addEventListener('pointercancel', up)
    btn.addEventListener('lostpointercapture', up)
    btn.addEventListener('contextmenu', (e) => e.preventDefault())
  }
}

function snapToRoute(): void {
  if (!simPos) return
  const route = runRoute ?? activeRoute() ?? closestRoute(simPos)
  if (!route) return
  simPos = nearestPoint(route, simPos).point
  pushSimFix()
  showToast(`已吸附到「${route.name}」`, 1800)
}

/* ---------------- 事件綁定 ---------------- */

function bindEvents(): void {
  ui.simToggle.addEventListener('click', () => setSimMode(!simMode))
  ui.simSnap.addEventListener('click', snapToRoute)
  ui.startRun.addEventListener('click', startRun)
  ui.endRun.addEventListener('click', endRun)
  ui.backToBrowse.addEventListener('click', enterBrowse)

  ui.smClose.addEventListener('click', closeSummary)
  ui.summary.querySelector('.summary-backdrop')?.addEventListener('click', closeSummary)

  ui.locate.addEventListener('click', () => {
    if (simMode) {
      if (simPos) mapView.flyToPosition({ lon: simPos[0], lat: simPos[1] })
      showToast('模擬模式中，這是假位置', 1800)
      return
    }
    if (currentFix) {
      mapView.flyToPosition(currentFix)
      return
    }
    tracker.start()
    showToast('正在取得定位…')
  })

  ui.relocate.addEventListener('click', () => {
    tracker.start()
    showToast('正在重新取得定位…')
  })

  tracker.onFix = (fix) => applyFix(fix)
  tracker.onError = (kind, message) => {
    ui.relocate.hidden = false
    if (kind === 'insecure') {
      setStatus('需要 HTTPS 才能定位', 'warn')
      ui.browseHint.textContent = '需要 HTTPS 才能定位；先開模擬也能試跑。'
    } else {
      ui.browseHint.textContent = '拿不到定位；先開模擬也能試跑。'
    }
    showToast(message, 4200)
  }
}

/* ---------------- 載入 ---------------- */

async function loadAllRoutes(): Promise<void> {
  ui.routeCount.textContent = '載入中…'

  const results = await Promise.allSettled(
    ROUTES.map(async (meta) => buildRoute(meta, (await loadGpx(meta.file)).coords)),
  )

  routes = []
  let failed = 0
  results.forEach((result) => {
    if (result.status === 'fulfilled') routes.push(result.value)
    else failed++
  })

  if (routes.length === 0) {
    ui.routeCount.textContent = ''
    ui.browseHint.textContent = '路線載入失敗，請重新整理。'
    showToast(failed > 0 ? '路線載入失敗' : '目前沒有路線', 4200)
    return
  }

  buildRouteList()
  mapView.setRoutes(routes)
  mapView.fitAll()
  if (failed > 0) showToast(`${failed} 條路線載入失敗`, 3600)
}

/* ---------------- 啟動 ---------------- */

/** 讓虛擬十字鍵固定浮在資訊卡上方，不被內容高度蓋住 */
function trackSheetHeight(): void {
  const sheet = document.querySelector<HTMLElement>('.sheet')
  if (!sheet) return
  const apply = (): void => {
    const h = Math.round(sheet.getBoundingClientRect().height)
    document.documentElement.style.setProperty('--sheet-h', `${h}px`)
  }
  apply()
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(apply).observe(sheet)
}

bindEvents()
bindDpad()
trackSheetHeight()
setPhase('browse')
void loadAllRoutes()
tracker.start()

// 開發時方便在 console / 截圖腳本檢查狀態
declare global {
  interface Window {
    __mapView?: MapView
    __app?: {
      phase: Phase
      routes: { id: string; name: string; total: number }[]
      activeId: string | null
      sim: { lon: number; lat: number } | null
      progress: number | null
      leadIn: number
      routeStart: { lon: number; lat: number } | null
      select: (id: string) => void
      start: () => void
      end: () => void
      toggleSim: (on?: boolean) => void
      move: (dx: number, dy: number) => void
      snap: () => void
    }
  }
}

window.__mapView = mapView
window.__app = {
  get phase() {
    return phase
  },
  get routes() {
    return routes.map((r) => ({ id: r.id, name: r.name, total: r.total }))
  },
  get activeId() {
    return activeId
  },
  get sim() {
    return simPos ? { lon: simPos[0], lat: simPos[1] } : null
  },
  get progress() {
    return lastAlong
  },
  get leadIn() {
    return runLeadIn
  },
  get routeStart() {
    const first = runRoute?.coords[0] ?? previewRoute?.coords[0]
    return first ? { lon: first[0], lat: first[1] } : null
  },
  select: (id: string) => enterPreview(id),
  start: () => startRun(),
  end: () => endRun(),
  toggleSim: (on?: boolean) => setSimMode(on ?? !simMode),
  move: (dx: number, dy: number) => {
    if (!simPos) return
    simPos = moveByMeters(simPos, dx, dy)
    pushSimFix()
  },
  snap: () => snapToRoute(),
}
