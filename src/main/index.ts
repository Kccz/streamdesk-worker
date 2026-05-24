import { app, BrowserWindow, shell, ipcMain, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc'
import { logger } from './logger'
import { settingsStore, configStore } from './core/settings'
import { credentials } from './core/credentials'
import { pollClient } from './core/pollClient'
import { setupAutoUpdater } from './updater'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const browserPool = require('./core/browserPool.js')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 880,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'StreamDesk Worker',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1014',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (e) => {
    // 关窗口时只隐藏，仍后台跑（除非 app.quit()）
    if (!(global as any).__isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
      if (process.platform === 'darwin') app.dock?.hide()
    }
  })

  mainWindow.on('show', () => {
    if (process.platform === 'darwin') app.dock?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildTrayMenu(): Electron.Menu {
  const stats = pollClient.getStats()
  const cfg = configStore.get()
  const running = stats.status === 'polling' || stats.status === 'running'
  const statusText = (() => {
    switch (stats.status) {
      case 'polling': return '运行中'
      case 'running': return `执行任务中 ${stats.current?.id ?? ''}`
      case 'stopping': return '正在停止...'
      case 'stopped': return '已停止'
      case 'error': return '出错重试中'
      default: return '空闲'
    }
  })()

  return Menu.buildFromTemplate([
    { label: `状态：${statusText}`, enabled: false },
    cfg ? { label: `节点：${cfg.workerId}`, enabled: false } : { label: '未激活', enabled: false },
    { label: `今日：完成 ${stats.todayTotal}（成功 ${stats.todaySuccess} / 失败 ${stats.todayFailed}）`, enabled: false },
    { type: 'separator' },
    {
      label: running ? '停止 worker' : '启动 worker',
      enabled: !!cfg && stats.status !== 'stopping',
      click: async () => {
        if (running) pollClient.stop()
        else if (cfg) {
          const token = await credentials.get()
          if (!token) return
          pollClient.start({
            server: cfg.server,
            token,
            workerId: cfg.workerId,
            appVersion: app.getVersion(),
          }).catch(() => {})
        }
      },
    },
    {
      label: '打开主窗口',
      click: () => {
        if (!mainWindow) createWindow()
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        ;(global as any).__isQuitting = true
        app.quit()
      },
    },
  ])
}

function refreshTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(buildTrayMenu())
}

function createTray(): void {
  // 占位图标，正式发布替换 resources/tray/iconTemplate.png
  const iconPath = join(__dirname, '../../resources/tray/iconTemplate.png')
  let icon: Electron.NativeImage
  try {
    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) icon = nativeImage.createEmpty()
  } catch {
    icon = nativeImage.createEmpty()
  }
  tray = new Tray(icon)
  tray.setToolTip('StreamDesk Worker')
  refreshTrayMenu()

  tray.on('click', () => {
    if (!mainWindow) createWindow()
    mainWindow?.show()
  })

  // 状态变化时刷新菜单
  pollClient.on('stats', () => refreshTrayMenu())
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('cc.streamdesk.worker')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 开机自启同步
  // 注意：未打包的 dev 模式下 macOS 会报 "Operation not permitted"（来自原生 platform_util_mac，try/catch 抓不到）
  // 仅在打包后才设置，dev 时设置也无意义（路径指向的是 Electron.app 而不是真正的 app）
  const settings = settingsStore.get()
  if (process.platform !== 'linux' && app.isPackaged) {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!settings.autoLaunch,
        openAsHidden: true,
      })
    } catch (err: any) {
      logger.warn('App', `设置开机自启失败: ${err?.message || err}`)
    }
  } else if (settings.autoLaunch) {
    logger.debug('App', '开发模式跳过开机自启设置（仅打包后生效）')
  }

  registerIpc(ipcMain, () => mainWindow)
  createWindow()
  createTray()
  setupAutoUpdater(() => mainWindow)

  // 已激活则自动启动 worker（开机自启 + 后台静默场景关键）
  setTimeout(async () => {
    try {
      const cfg = configStore.get()
      const token = await credentials.get()
      if (cfg && token && !pollClient.isRunning()) {
        logger.info('App', '检测到已激活，自动启动 worker')
        pollClient.start({
          server: cfg.server,
          token,
          workerId: cfg.workerId,
          appVersion: app.getVersion(),
        }).catch((e) => logger.error('App', `自动启动失败: ${e.message}`))
      }
    } catch (err: any) {
      logger.error('App', `自启检查异常: ${err.message}`)
    }
  }, 800)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })

  logger.info('App', `启动完成 v${app.getVersion()} platform=${process.platform}`)
})

// 全平台后台运行：不在 window-all-closed 时退出
app.on('window-all-closed', () => {
  // 故意不退出，保留托盘后台运行
})

app.on('before-quit', async (e) => {
  if ((global as any).__cleaningUp) return // 防止重入
  ;(global as any).__isQuitting = true
  ;(global as any).__cleaningUp = true

  e.preventDefault()
  logger.info('App', '开始清理 worker / browserPool ...')

  try {
    // 1. 停 worker（会取消 long-poll + abort 当前 LoginService）
    pollClient.stop()
    // 等最多 3s 让任务上报和资源释放
    await new Promise<void>((resolve) => {
      // 已经 stopped 直接 resolve（理论不会，但防御一下）
      if (pollClient.getStats().status === 'stopped') {
        resolve()
        return
      }
      const t = setTimeout(resolve, 3000)
      const handler = (s: any): void => {
        if (s.status === 'stopped') {
          clearTimeout(t)
          pollClient.off('stats', handler)
          resolve()
        }
      }
      pollClient.on('stats', handler)
    })

    // 2. 关浏览器池（关掉 chromium 进程）
    try {
      if (browserPool?.shutdown) await browserPool.shutdown()
    } catch (err: any) {
      logger.warn('App', `browserPool 关闭异常: ${err.message}`)
    }

    logger.info('App', '清理完成，退出')
  } catch (err: any) {
    logger.error('App', `清理异常: ${err.message}`)
  }

  app.exit(0)
})

// ==================== 多开检测 + 全局错误捕获 ====================
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

// 全局未捕获异常 → 写日志，不让 app 崩溃
process.on('uncaughtException', (err) => {
  try {
    logger.error('Main', `未捕获异常: ${err?.stack || err?.message || err}`)
  } catch { /* ignore */ }
})
process.on('unhandledRejection', (reason: any) => {
  try {
    logger.error('Main', `未处理 rejection: ${reason?.stack || reason?.message || reason}`)
  } catch { /* ignore */ }
})
// 渲染进程崩溃 / 不响应
app.on('render-process-gone', (_event, _wc, details) => {
  logger.error('Main', `渲染进程异常 reason=${details.reason} exitCode=${details.exitCode}`)
})
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit') {
    logger.error('Main', `子进程异常 type=${details.type} reason=${details.reason}`)
  }
})