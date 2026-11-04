// 開發用：用本機 Chrome 開頁面、印出佈局與地圖狀態、存截圖
// 用法：node scripts/check.mjs [url] [outfile] [mode]
//   mode: browse | preview | run | sim | second | desktop
//         gps | gps-start | gps-mid   （假 GPS，需先給定位權限）
import puppeteer from 'puppeteer-core'

const url = process.argv[2] ?? 'http://localhost:5173/'
const out = process.argv[3] ?? 'shot.png'
const mode = process.argv[4] ?? 'browse'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'],
  defaultViewport: {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
})

const page = await browser.newPage()
page.on('console', (m) => console.log('[console]', m.type(), m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('requestfailed', (r) => console.log('[requestfailed]', r.url(), r.failure()?.errorText))

if (mode === 'desktop') {
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
}

if (mode.startsWith('gps')) {
  // 必須在導航前先給權限，否則頁面載入時的第一次定位會直接失敗
  const points = {
    gps: { latitude: 25.062599, longitude: 121.539558, accuracy: 10 }, // 起點往東偏 70m
    'gps-start': { latitude: 25.062599, longitude: 121.538864, accuracy: 10 }, // 正好在起點
    'gps-mid': { latitude: 25.068489, longitude: 121.530226, accuracy: 10 }, // 路線 50% 處
  }
  await browser.defaultBrowserContext().overridePermissions(url, ['geolocation'])
  await page.setGeolocation(points[mode] ?? points.gps)
}

await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
await wait(4000)

const routeIndex = mode === 'second' ? 1 : 0

async function selectRoute(index) {
  await page.evaluate((i) => {
    const app = window.__app
    const id = app?.routes[i]?.id
    if (id) app.select(id)
  }, index)
  await wait(1500)
}

async function startRun() {
  await page.evaluate(() => {
    const btn = document.getElementById('startMode')
    const startBtn = btn?.querySelector('[data-mode="start"]')
    // 想測「原始起點」時，這個按鈕是可見的才點
    if (startBtn && !btn.hidden) startBtn.click()
  })
  await wait(300)
  await page.click('#startRun')
  await wait(1200)
}

if (['preview', 'second'].includes(mode)) {
  await selectRoute(routeIndex)
}

if (['run', 'sim', 'gps', 'gps-start', 'gps-mid'].includes(mode)) {
  await selectRoute(0)
  // gps-mid 想驗證「原始起點」模式：從 0% 正常累積到 50%
  if (mode !== 'gps-mid') {
    await page.click('#startRun')
    await wait(1200)
  } else {
    await startRun()
  }
}

if (mode === 'sim') {
  await page.click('#simToggle')
  await wait(400)
  const before = await page.evaluate(() => window.__app?.sim)
  await page.keyboard.down('d')
  await wait(1600)
  await page.keyboard.up('d')
  await wait(600)
  const after = await page.evaluate(() => window.__app?.sim)
  console.log('SIM', JSON.stringify({ before, after }))
}

const state = await page.evaluate(() => {
  const app = window.__app
  const text = (id) => (document.getElementById(id)?.textContent ?? '').trim()
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
  }
  const map = window.__mapView?.map
  return {
    phase: app?.phase,
    routes: app?.routes.map((r) => `${r.name} ${(r.total / 1000).toFixed(1)}km`),
    activeId: app?.activeId,
    progress: app?.progress,
    sim: app?.sim,
    readout: {
      pct: text('pct'),
      left: text('left'),
      off: text('off'),
      status: text('status'),
      bar: document.getElementById('bar')?.style.width,
      startInfo: text('startInfo'),
      previewTotal: text('pvTotal'),
    },
    layout: {
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      sheet: box('.sheet'),
      cards: document.querySelectorAll('.route-card').length,
      dpad: box('#dpad'),
    },
    map: {
      styleLoaded: map?.isStyleLoaded(),
      zoom: Number(map?.getZoom()?.toFixed(2)),
      center: map?.getCenter()?.toArray().map((n) => +n.toFixed(4)),
      sourceBytes: {
        routes: JSON.stringify(map?.getSource('routes')?._data ?? '').length,
        rest: JSON.stringify(map?.getSource('route-rest')?._data ?? '').length,
        done: JSON.stringify(map?.getSource('route-done')?._data ?? '').length,
      },
    },
  }
})

console.log(JSON.stringify(state, null, 2))
await page.screenshot({ path: out })
await browser.close()
