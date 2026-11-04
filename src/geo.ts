export type LngLat = [number, number]

export interface RouteMeta {
  id: string
  name: string
  note: string
  color: string
}

export interface RouteData extends RouteMeta {
  coords: LngLat[]
  /** 每個點沿路線的累積距離（公尺） */
  cum: number[]
  total: number
}

const EARTH_R = 6371008.8
const RAD = Math.PI / 180
const M_PER_DEG_LAT = 111132.9

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD
  const dLon = (b[0] - a[0]) * RAD
  const la1 = a[1] * RAD
  const la2 = b[1] * RAD
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function buildRoute(meta: RouteMeta, coords: LngLat[]): RouteData {
  const cum = [0]
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]))
  }
  return { ...meta, coords, cum, total: cum[cum.length - 1] ?? 0 }
}

export interface Projection {
  /** 所在線段索引 */
  seg: number
  /** 線段內比例 0..1 */
  t: number
  /** 沿線累積距離（公尺） */
  along: number
  /** 垂直偏離距離（公尺） */
  dist: number
  /** 投影點座標 */
  point: LngLat
  /** 是否因超出窗口而重新全域定位 */
  relocated: boolean
}

interface BestMatch {
  dist: number
  seg: number
  t: number
  along: number
}

function bestIn(
  route: RouteData,
  target: LngLat,
  mLat: number,
  mLon: number,
  from: number,
  to: number,
  preferEarly = false,
): BestMatch {
  const { coords, cum } = route
  let best: BestMatch = { dist: Infinity, seg: from, t: 0, along: cum[from] ?? 0 }
  // 第一次定位時，若兩處一樣近（閉環的起點與終點），取「比較前面」的那段
  const margin = preferEarly ? 10 : 0

  for (let i = from; i < to; i++) {
    const a = coords[i]
    const b = coords[i + 1]
    // 以目標點為原點，換算成局部平面公尺座標
    const ax = (a[0] - target[0]) * mLon
    const ay = (a[1] - target[1]) * mLat
    const bx = (b[0] - target[0]) * mLon
    const by = (b[1] - target[1]) * mLat

    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2
    t = t < 0 ? 0 : t > 1 ? 1 : t

    const px = ax + t * dx
    const py = ay + t * dy
    const d = Math.hypot(px, py)

    if (d < best.dist - margin) {
      best = {
        dist: d,
        seg: i,
        t,
        along: cum[i] + t * (cum[i + 1] - cum[i]),
      }
    }
  }
  return best
}

/**
 * 找出 GPS 點在路線上的投影。
 *
 * windowCenter 是上一次的沿線距離：只在這附近（±windowMeters）找最近點，
 * 避免路線交叉處進度忽然跳回前面。真的跑遠了才退回全域搜尋。
 */
export function project(
  route: RouteData,
  target: LngLat,
  windowCenter: number | null,
  windowMeters = 400,
): Projection {
  const { coords, cum } = route
  const n = coords.length
  if (n < 2) {
    return { seg: 0, t: 0, along: 0, dist: Infinity, point: target, relocated: false }
  }

  const mLat = M_PER_DEG_LAT
  const mLon = 111319.5 * Math.cos(target[1] * RAD)

  let best: BestMatch
  let relocated = false

  if (windowCenter === null) {
    best = bestIn(route, target, mLat, mLon, 0, n - 1, true)
  } else {
    let from = 0
    let to = n - 1
    const lo = windowCenter - windowMeters
    const hi = windowCenter + windowMeters

    for (let i = 0; i < n - 1; i++) {
      if (cum[i + 1] >= lo) {
        from = i
        break
      }
    }
    for (let i = n - 2; i >= 0; i--) {
      if (cum[i] <= hi) {
        to = i + 1
        break
      }
    }
    if (to <= from) {
      from = 0
      to = n - 1
    }

    best = bestIn(route, target, mLat, mLon, from, to)

    // 離開窗口太遠 → 視為中途加入，重新全域定位
    if (best.dist > 250) {
      best = bestIn(route, target, mLat, mLon, 0, n - 1)
      relocated = true
    }
  }

  const a = coords[best.seg]
  const b = coords[best.seg + 1] ?? coords[best.seg]
  const point: LngLat = [
    a[0] + (b[0] - a[0]) * best.t,
    a[1] + (b[1] - a[1]) * best.t,
  ]

  return { ...best, point, relocated }
}

export interface SplitLine {
  done: LngLat[]
  rest: LngLat[]
}

/** 依沿線距離把路線切成「已走完」與「剩下」兩段 */
export function splitAt(route: RouteData, along: number): SplitLine {
  const { coords, cum, total } = route
  const n = coords.length
  if (n < 2) return { done: [], rest: [...coords] }

  const d = Math.max(0, Math.min(total, along))

  let i = 0
  while (i < n - 2 && cum[i + 1] < d) i++

  const segLen = cum[i + 1] - cum[i]
  const t = segLen > 0 ? (d - cum[i]) / segLen : 0
  const p: LngLat = [
    coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
    coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
  ]

  const done = [...coords.slice(0, i + 1), p]
  const rest = [p, ...coords.slice(i + 1)]
  return { done, rest }
}

/** 取得路線上距離起點 s 公尺處的座標 */
export function pointAt(route: RouteData, s: number): LngLat {
  const { coords, cum, total } = route
  const n = coords.length
  const d = Math.max(0, Math.min(total, s))
  let i = 0
  while (i < n - 2 && cum[i + 1] < d) i++
  const segLen = cum[i + 1] - cum[i]
  const t = segLen > 0 ? (d - cum[i]) / segLen : 0
  return [
    coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
    coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
  ]
}

export interface NearestHit {
  /** 沿線累積距離（公尺） */
  along: number
  /** 與路線的垂直最短距離（公尺） */
  dist: number
  /** 路線上的最近點 */
  point: LngLat
}

/** 全域找路線上離 target 最近的點（不受進度窗口限制） */
export function nearestPoint(route: RouteData, target: LngLat, preferEarly = true): NearestHit {
  const { coords } = route
  const n = coords.length
  if (n < 2) return { along: 0, dist: Infinity, point: target }

  const mLat = M_PER_DEG_LAT
  const mLon = 111319.5 * Math.cos(target[1] * RAD)
  const best = bestIn(route, target, mLat, mLon, 0, n - 1, preferEarly)

  const a = coords[best.seg]
  const b = coords[best.seg + 1] ?? coords[best.seg]
  return {
    along: best.along,
    dist: best.dist,
    point: [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t],
  }
}

/** 起終點距離小於這個值，就當成閉環 */
export const CLOSED_GAP = 60

export function isClosed(route: RouteData): boolean {
  const n = route.coords.length
  return n > 1 && haversine(route.coords[0], route.coords[n - 1]) <= CLOSED_GAP
}

/**
 * 產生「從 along 處起跑」的路線。
 *
 * - 閉環：把路線在 along 處切開再接回原點，總長不變，跑完一圈回到起跑點。
 * - 非閉環：從 along 處一路跑到原終點，along 之前的路段不會跑到，總長縮短。
 */
export function routeFrom(route: RouteData, along: number): RouteData {
  const { coords, cum, total } = route
  const n = coords.length
  if (n < 2 || along <= 0.5 || along >= total - 0.5) return route

  let i = 0
  while (i < n - 2 && cum[i + 1] < along) i++
  const segLen = cum[i + 1] - cum[i]
  const t = segLen > 0 ? Math.min(1, Math.max(0, (along - cum[i]) / segLen)) : 0
  const p: LngLat = [
    coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
    coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
  ]

  const head = coords.slice(i + 1)
  const tail = coords.slice(0, i + 1)
  const next = isClosed(route) ? [p, ...head, ...tail, p] : [p, ...head]

  const nextCum = [0]
  for (let k = 1; k < next.length; k++) {
    nextCum.push(nextCum[k - 1] + haversine(next[k - 1], next[k]))
  }

  return { ...route, coords: next, cum: nextCum, total: nextCum[nextCum.length - 1] ?? 0 }
}

/** 把點往東 dx 公尺、往北 dy 公尺移動 */
export function moveByMeters(p: LngLat, dx: number, dy: number): LngLat {
  const mLon = 111319.5 * Math.cos(p[1] * RAD)
  return [p[0] + dx / mLon, p[1] + dy / M_PER_DEG_LAT]
}

/** 以某點為圓心，產生半徑 radius 公尺的近似圓多邊形（GeoJSON 座標） */
export function circlePolygon(center: LngLat, radius: number, steps = 48): LngLat[] {
  const mLon = 111319.5 * Math.cos(center[1] * RAD)
  const ring: LngLat[] = []
  for (let i = 0; i <= steps; i++) {
    const ang = (i / steps) * Math.PI * 2
    const dx = Math.cos(ang) * radius
    const dy = Math.sin(ang) * radius
    ring.push([center[0] + dx / mLon, center[1] + dy / M_PER_DEG_LAT])
  }
  return ring
}

