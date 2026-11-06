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
    note: '',
    color: '#5b4bff',
    file: './gpx/dino.gpx',
  },
  {
    id: 'dino2',
    name: '迅猛龍',
    note: '',
    color: '#0f9d6e',
    file: './gpx/dino2.gpx',
  },
  {
    id: 'people',
    name: '跑跳人',
    note: '',
    color: '#850f9d',
    file: './gpx/people.gpx',
  },
  {
    id: 'dog',
    name: '臘腸狗',
    note: '',
    color: '#d4c410',
    file: './gpx/dog.gpx',
  },
]
