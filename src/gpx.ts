import type { LngLat } from './geo'

export interface ParsedGpx {
  coords: LngLat[]
  name: string | null
  elevation: number[]
}

export async function loadGpx(url: string): Promise<ParsedGpx> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`無法載入 ${url}（HTTP ${res.status}）`)
  return parseGpx(await res.text())
}

export function parseGpx(text: string): ParsedGpx {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('GPX 格式錯誤，無法解析')
  }

  const nodes = [
    ...Array.from(doc.getElementsByTagNameNS('*', 'trkpt')),
    ...Array.from(doc.getElementsByTagNameNS('*', 'rtept')),
  ]

  const coords: LngLat[] = []
  const elevation: number[] = []

  for (const node of nodes) {
    const lat = Number(node.getAttribute('lat'))
    const lon = Number(node.getAttribute('lon'))
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

    const last = coords[coords.length - 1]
    // 去掉連續重複點，避免除零
    if (last && Math.abs(last[0] - lon) < 1e-9 && Math.abs(last[1] - lat) < 1e-9) continue

    coords.push([lon, lat])

    const eleNode = node.getElementsByTagNameNS('*', 'ele')[0]
    const ele = eleNode?.textContent ? Number(eleNode.textContent) : NaN
    elevation.push(Number.isFinite(ele) ? ele : NaN)
  }

  if (coords.length < 2) throw new Error('這個 GPX 沒有足夠的軌跡點')

  const nameNode = doc.getElementsByTagNameNS('*', 'name')[0]
  return { coords, name: nameNode?.textContent?.trim() || null, elevation }
}
