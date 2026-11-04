export interface Fix {
  lon: number
  lat: number
  /** 公尺 */
  accuracy: number
  at: number
}

export type TrackerErrorKind = 'unsupported' | 'insecure' | 'denied' | 'unavailable' | 'timeout'

export class Tracker {
  private watchId: number | null = null

  onFix: ((fix: Fix) => void) | null = null
  onError: ((kind: TrackerErrorKind, message: string) => void) | null = null

  get running(): boolean {
    return this.watchId !== null
  }

  start(): void {
    if (this.watchId !== null) return

    if (!('geolocation' in navigator)) {
      this.onError?.('unsupported', '這個瀏覽器不支援定位')
      return
    }

    // 手機用 http://192.168.x.x 開啟時，瀏覽器會直接封鎖定位
    if (!window.isSecureContext) {
      this.onError?.('insecure', '需要 HTTPS 才能定位，請用 tunnel 或部署後的網址')
      return
    }

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.onFix?.({
          lon: pos.coords.longitude,
          lat: pos.coords.latitude,
          accuracy: pos.coords.accuracy ?? 30,
          at: pos.timestamp,
        })
      },
      (err) => {
        // 清掉 watch，讓使用者按「回到我的位置」可以重新嘗試
        this.stop()
        const kind: TrackerErrorKind =
          err.code === err.PERMISSION_DENIED
            ? 'denied'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'unavailable'
              : 'timeout'
        const message =
          kind === 'denied'
            ? '定位權限被封鎖，請到瀏覽器設定開啟'
            : kind === 'unavailable'
              ? '拿不到 GPS 訊號，請確認已開啟定位'
              : '定位逾時，稍後再試'
        this.onError?.(kind, message)
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 15000,
      },
    )
  }

  stop(): void {
    if (this.watchId === null) return
    navigator.geolocation.clearWatch(this.watchId)
    this.watchId = null
  }
}
