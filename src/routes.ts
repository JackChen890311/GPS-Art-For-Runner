import type { RouteMeta } from './geo'

export interface RouteEntry extends RouteMeta {
  /** 相對於網站根目錄的 GPX 路徑 */
  file: string
}

/**
 * 一個 route 一個條目。之後接上 Astro 的 content collection 時，
 * 這份清單會改成從 frontmatter 自動產生。
 */
export const ROUTES: RouteEntry[] = [
  {
    id: 'dino',
    name: '小恐龍',
    note: '市區街道｜封閉環形',
    color: '#5b4bff',
    file: './gpx/dino.gpx',
  },
  {
    id: 'dino2Half',
    name: '迅猛龍',
    note: '街區繞行｜封閉環形',
    color: '#0f9d6e',
    file: './gpx/dino2Half.gpx',
  },
]
