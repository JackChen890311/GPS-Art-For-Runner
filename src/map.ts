import maplibregl, { type GeoJSONSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection, LineString, MultiLineString, Polygon } from 'geojson'
import { circlePolygon, haversine, splitAt, type LngLat, type RouteData } from './geo'

/**
 * OpenFreeMap：免費、免金鑰、可自架的向量圖磚（資料來自 OpenStreetMap）。
 * 要換成其他底圖時，只要換掉這個 style 就好。
 */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

function lineFeature(coords: LngLat[], properties: Record<string, unknown> = {}): Feature<LineString> | null {
  if (coords.length < 2) return null
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'LineString', coordinates: coords },
  }
}

function lineCollection(coords: LngLat[]): FeatureCollection<LineString> {
  const f = lineFeature(coords)
  return { type: 'FeatureCollection', features: f ? [f] : [] }
}

function routeCollection(routes: RouteData[]): FeatureCollection<LineString> {
  const features = routes
    .map((r) => lineFeature(r.coords, { color: r.color }))
    .filter((f): f is Feature<LineString> => f !== null)
  return { type: 'FeatureCollection', features }
}

/** 實際軌跡可能因為訊號中斷或吸附而斷成好幾段，用 MultiLineString */
function segmentCollection(segments: LngLat[][]): FeatureCollection<MultiLineString> {
  const features: Feature<MultiLineString>[] = segments
    .filter((s) => s.length >= 2)
    .map((s) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiLineString', coordinates: [s] },
    }))
  return { type: 'FeatureCollection', features }
}

function markerElement(className: string, text: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = `mk ${className}`
  el.textContent = text
  return el
}

export class MapView {
  readonly map: maplibregl.Map

  private ready = false
  private routes: RouteData[] = []
  private active: RouteData | null = null
  private along = 0
  private showEndpoints = false
  private muted = false
  private lastPos: { lon: number; lat: number; accuracy: number } | null = null
  private startPoint: LngLat | null = null
  private hasFix = false

  private meMarker: maplibregl.Marker
  private startMarker: maplibregl.Marker | null = null
  private endMarker: maplibregl.Marker | null = null
  private startPointMarker: maplibregl.Marker | null = null
  private refMarker: maplibregl.Marker | null = null

  constructor(container: string) {
    const meEl = document.createElement('div')
    meEl.className = 'me'
    meEl.style.display = 'none'
    meEl.innerHTML = '<span class="me-halo"></span><span class="me-dot"></span>'

    this.map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: [0, 0],
      zoom: 1,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    })

    this.map.touchZoomRotate.disableRotation()

    this.meMarker = new maplibregl.Marker({ element: meEl, anchor: 'center' })
      .setLngLat([0, 0])
      .addTo(this.map)

    this.map.on('load', () => {
      this.ready = true
      this.installLayers()
      // 地圖載入前就先拿到的路線 / 定位，這時候補畫上去
      this.renderRoutes()
      this.renderActive()
      this.applyPosition(this.lastPos)
      if (this.routes.length > 0) this.fitAll()
    })
  }

  private src(id: string): GeoJSONSource {
    return this.map.getSource(id) as GeoJSONSource
  }

  private installLayers(): void {
    this.map.addSource('routes', { type: 'geojson', data: EMPTY })
    this.map.addSource('route-full', { type: 'geojson', data: EMPTY })
    this.map.addSource('route-done', { type: 'geojson', data: EMPTY })
    this.map.addSource('route-rest', { type: 'geojson', data: EMPTY })
    this.map.addSource('accuracy', { type: 'geojson', data: EMPTY })
    this.map.addSource('connector', { type: 'geojson', data: EMPTY })
    this.map.addSource('reference', { type: 'geojson', data: EMPTY })
    this.map.addSource('trace', { type: 'geojson', data: EMPTY })

    // GPS 精度圈
    this.map.addLayer({
      id: 'accuracy-fill',
      type: 'fill',
      source: 'accuracy',
      paint: { 'fill-color': '#2f6df6', 'fill-opacity': 0.1 },
    })
    this.map.addLayer({
      id: 'accuracy-line',
      type: 'line',
      source: 'accuracy',
      paint: { 'line-color': '#2f6df6', 'line-opacity': 0.28, 'line-width': 1 },
    })

    // 其他路線（背景）
    this.map.addLayer({
      id: 'routes-casing',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 6.5, 'line-opacity': 0.8 },
    })
    this.map.addLayer({
      id: 'routes-line',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 3.5,
        'line-opacity': 0.72,
      },
    })

    // 選取中的路線：白色描邊讓它在複雜底圖上仍然清楚
    this.map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route-full',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 10, 'line-opacity': 0.92 },
    })

    // 已完成（灰）
    this.map.addLayer({
      id: 'route-done',
      type: 'line',
      source: 'route-done',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#b9bdcc', 'line-width': 4.5 },
    })

    // 尚未完成（主色）
    this.map.addLayer({
      id: 'route-rest',
      type: 'line',
      source: 'route-rest',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#5b4bff', 'line-width': 5 },
    })

    // 原路徑上「跑不到」的前段（深灰實線），要蓋在主線上面才看得見
    this.map.addLayer({
      id: 'reference',
      type: 'line',
      source: 'reference',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#767d8d',
        'line-width': 4,
        'line-opacity': 0.9,
      },
    })

    // 實際走出來的軌跡（麵包屑）：白邊 + 橘色，蓋在最上層
    this.map.addLayer({
      id: 'trace-casing',
      type: 'line',
      source: 'trace',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 },
    })
    this.map.addLayer({
      id: 'trace-line',
      type: 'line',
      source: 'trace',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ff6b2c', 'line-width': 5, 'line-opacity': 1 },
    })

    // 你 → 起跑點
    this.map.addLayer({
      id: 'connector',
      type: 'line',
      source: 'connector',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#2f6df6',
        'line-width': 2,
        'line-opacity': 0.55,
      },
    })
  }

  /** 瀏覽模式：一次畫出所有路線 */
  setRoutes(routes: RouteData[]): void {
    this.routes = routes
    if (!this.ready) return
    this.renderRoutes()
  }

  /**
   * 選取 / 取消選取一條路線（預覽與起跑都用這條）。
   * muted = true 時規劃路線會退成低調的灰藍色，讓實際軌跡（橘）跳出來。
   */
  setActive(route: RouteData | null, opts: { endpoints?: boolean; muted?: boolean } = {}): void {
    this.active = route
    this.along = 0
    this.showEndpoints = opts.endpoints ?? false
    this.muted = opts.muted ?? false
    if (!this.ready) return
    this.renderRoutes()
    this.renderActive()
  }

  private renderRoutes(): void {
    const visible = this.active
      ? this.routes.filter((r) => r.id !== this.active?.id)
      : this.routes
    this.src('routes').setData(routeCollection(visible))
  }

  private clearActiveMarkers(): void {
    this.startMarker?.remove()
    this.endMarker?.remove()
    this.startMarker = null
    this.endMarker = null
  }

  private renderActive(): void {
    this.clearActiveMarkers()

    if (!this.active) {
      this.src('route-full').setData(EMPTY)
      this.src('route-rest').setData(EMPTY)
      this.src('route-done').setData(EMPTY)
      return
    }

    const route = this.active
    this.src('route-full').setData(lineCollection(route.coords))
    const { done, rest } = splitAt(route, this.along)
    this.src('route-done').setData(lineCollection(done))
    this.src('route-rest').setData(lineCollection(rest))
    this.applyRoutePaint(route)

    if (!this.showEndpoints) return

    this.startMarker = new maplibregl.Marker({
      element: markerElement('start', '起'),
      anchor: 'center',
    })
      .setLngLat(route.coords[0])
      .addTo(this.map)

    // 閉環時起終點重疊，只顯示起點
    const gap = haversine(route.coords[0], route.coords[route.coords.length - 1])
    if (gap > 60) {
      this.endMarker = new maplibregl.Marker({
        element: markerElement('end', '終'),
        anchor: 'center',
      })
        .setLngLat(route.coords[route.coords.length - 1])
        .addTo(this.map)
    }
  }

  /** 起跑時規劃路線退成灰藍色，預覽時用路線本身的顏色 */
  private applyRoutePaint(route: RouteData): void {
    this.map.setPaintProperty('route-rest', 'line-color', this.muted ? '#aab2c0' : route.color)
    this.map.setPaintProperty('route-done', 'line-color', this.muted ? '#aab2c0' : '#b9bdcc')
  }

  /** 實際走出來的軌跡（可能斷成多段） */
  setTrace(segments: LngLat[][]): void {
    if (!this.ready) return
    this.src('trace').setData(segmentCollection(segments))
  }

  setProgress(along: number): void {
    this.along = along
    if (!this.ready || !this.active) return
    const { done, rest } = splitAt(this.active, along)
    this.src('route-done').setData(lineCollection(done))
    this.src('route-rest').setData(lineCollection(rest))
  }

  /** 預覽用：標出「實際會從哪裡起跑」，並從目前位置拉一條線過去 */
  setStartPoint(point: LngLat | null): void {
    this.startPoint = point
    this.startPointMarker?.remove()
    this.startPointMarker = null

    if (this.ready && point) {
      this.startPointMarker = new maplibregl.Marker({
        element: markerElement('start', '起'),
        anchor: 'center',
      })
        .setLngLat(point)
        .addTo(this.map)
    }
    this.renderConnector()
  }

  /**
   * 原路徑上「不會跑到」的前段（起跑點之前），畫成深灰實線。
   * 傳入的是那一段的座標；null 表示沒有要跳過的路段。
   * label 會顯示在原始起點的標記上（例如「原 50%」）。
   */
  setReference(coords: LngLat[] | null, label = '原'): void {
    this.refMarker?.remove()
    this.refMarker = null

    if (!this.ready || !coords || coords.length < 2) {
      if (this.ready) this.src('reference').setData(EMPTY)
      return
    }

    this.src('reference').setData(lineCollection(coords))
    this.refMarker = new maplibregl.Marker({
      element: markerElement('ref', label),
      anchor: 'center',
    })
      .setLngLat(coords[0])
      .addTo(this.map)
  }

  private renderConnector(): void {
    if (!this.ready) return
    if (!this.startPoint || !this.lastPos) {
      this.src('connector').setData(EMPTY)
      return
    }
    const here: LngLat = [this.lastPos.lon, this.lastPos.lat]
    // 起點就是你站的位置時，不需要多畫一條 0 公尺的線
    if (haversine(here, this.startPoint) < 1) {
      this.src('connector').setData(EMPTY)
      return
    }
    this.src('connector').setData(lineCollection([here, this.startPoint]))
  }

  setPosition(pos: { lon: number; lat: number; accuracy: number } | null): void {
    this.lastPos = pos
    this.applyPosition(pos)
    this.renderConnector()
  }

  private applyPosition(pos: { lon: number; lat: number; accuracy: number } | null): void {
    if (!this.ready) return
    const el = this.meMarker.getElement()

    if (!pos) {
      el.style.display = 'none'
      this.src('accuracy').setData(EMPTY)
      this.hasFix = false
      return
    }

    el.style.display = ''
    this.meMarker.setLngLat([pos.lon, pos.lat])

    const radius = Math.max(pos.accuracy, 12)
    const ring = circlePolygon([pos.lon, pos.lat], radius)
    const feature: Feature<Polygon> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [ring] },
    }
    this.src('accuracy').setData({ type: 'FeatureCollection', features: [feature] })
    this.hasFix = true
  }

  private fitPadding(): maplibregl.PaddingOptions {
    return window.innerWidth < 720
      ? { top: 116, bottom: 320, left: 36, right: 36 }
      : { top: 100, bottom: 90, left: 450, right: 90 }
  }

  private boundsOf(routes: RouteData[]): maplibregl.LngLatBounds | null {
    if (routes.length === 0) return null
    const bounds = new maplibregl.LngLatBounds()
    for (const r of routes) for (const c of r.coords) bounds.extend(c)
    return bounds
  }

  fitAll(duration = 700): void {
    if (!this.ready) return
    const bounds = this.boundsOf(this.routes)
    if (!bounds) return
    this.map.fitBounds(bounds, { padding: this.fitPadding(), duration })
  }

  fitRoute(route: RouteData, duration = 700): void {
    if (!this.ready) return
    const bounds = this.boundsOf([route])
    if (!bounds) return
    this.map.fitBounds(bounds, { padding: this.fitPadding(), duration })
  }

  flyToPosition(pos: { lon: number; lat: number }, zoom?: number): void {
    if (!this.ready) return
    this.map.flyTo({
      center: [pos.lon, pos.lat],
      zoom: zoom ?? Math.max(this.map.getZoom(), 15),
      duration: 700,
    })
  }

  /** 模擬移動時輕推鏡頭，不要每 frame 都打斷動畫 */
  followPosition(pos: { lon: number; lat: number }): void {
    if (!this.ready) return
    this.map.panTo([pos.lon, pos.lat], { duration: 140, easing: (t) => t })
  }

  get positioned(): boolean {
    return this.hasFix
  }
}
