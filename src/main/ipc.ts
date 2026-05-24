import type { IpcMain, BrowserWindow } from 'electron'
import { app, shell } from 'electron'
import axios from 'axios'
import os from 'node:os'
import { credentials } from './core/credentials'
import { configStore, settingsStore, historyStore, statsStore } from './core/settings'
import { pollClient } from './core/pollClient'
import { logger } from './logger'
import type { AppSettings, WorkerConfig } from '@shared/types'

/** 激活/网络错误 → 用户友好文案 */
function friendlyActivateError(e: any): string {
  const code = e?.code
  const status = e?.response?.status
  const serverMsg = e?.response?.data?.message
  if (status === 400) return serverMsg || '请求参数无效'
  if (status === 401 || status === 404) return '激活码无效或已被使用'
  if (status === 403) return '该激活码对应的节点已被禁用'
  if (status === 429) return '请求过于频繁，请稍后再试'
  if (status && status >= 500) return `服务器繁忙（${status}），请稍后重试`
  if (status) return serverMsg || `服务器返回 ${status}`
  // 网络层错误
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(e?.message || '')) {
    return '无法解析服务器地址，请检查 URL 是否正确'
  }
  if (code === 'ECONNREFUSED') return '服务器拒绝连接，请检查地址或防火墙'
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return '连接超时，请检查网络'
  if (code === 'CERT_HAS_EXPIRED' || /certificate/i.test(e?.message || '')) {
    return '服务器证书异常'
  }
  if (/Network Error/i.test(e?.message || '')) return '网络异常，请检查连接'
  return e?.message || '激活失败'
}

export function registerIpc(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  // ==================== auth ====================
  ipcMain.handle('auth:isActivated', async () => {
    const cfg = configStore.get()
    if (!cfg) return false
    const token = await credentials.get()
    return !!token
  })

  ipcMain.handle('auth:activate', async (_e, payload: { server: string; code: string; deviceName: string }) => {
    try {
      const server = (payload.server || '').replace(/\/$/, '')
      if (!server || !payload.code) {
        return { ok: false, error: '服务器地址和激活码不能为空' }
      }
      if (!/^https?:\/\//.test(server)) {
        return { ok: false, error: '服务器地址必须以 http:// 或 https:// 开头' }
      }
      const res = await axios.post(
        `${server}/api/worker/activate`,
        {
          code: payload.code,
          deviceName: payload.deviceName || os.hostname(),
          os: process.platform,
          osVersion: os.release(),
          appVersion: app.getVersion(),
        },
        { timeout: 15000 },
      )
      const data = res.data?.data
      if (!data?.token || !data?.workerId) {
        return { ok: false, error: res.data?.message || '激活失败' }
      }
      await credentials.set(data.token)
      configStore.set({ server, workerId: data.workerId })
      logger.info('Auth', `激活成功 workerId=${data.workerId} server=${server}`)
      return { ok: true, workerId: data.workerId }
    } catch (e: any) {
      const msg = friendlyActivateError(e)
      logger.error('Auth', `激活失败: ${msg}（原始：${e?.message || '-'}）`)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('auth:logout', async () => {
    pollClient.stop()
    await credentials.clear()
    configStore.set(null)
    historyStore.clear()
    statsStore.reset()
    logger.info('Auth', '已注销，已清除本地凭证、历史与统计')
  })

  ipcMain.handle('config:get', async (): Promise<WorkerConfig | null> => {
    return configStore.get()
  })

  // ==================== worker ====================
  ipcMain.handle('worker:start', async () => {
    const cfg = configStore.get()
    const token = await credentials.get()
    if (!cfg || !token) return { ok: false, error: '未激活，请先激活设备' }
    if (pollClient.isRunning()) return { ok: true }

    pollClient.start({
      server: cfg.server,
      token,
      workerId: cfg.workerId,
      appVersion: app.getVersion(),
    }).catch((e) => logger.error('Worker', `start 异常: ${e.message}`))
    return { ok: true }
  })

  ipcMain.handle('worker:stop', async () => {
    pollClient.stop()
  })

  /** 中止当前正在执行的任务（不停 worker，只 abort current task） */
  ipcMain.handle('worker:abortCurrent', async () => {
    pollClient.abortCurrent()
  })

  ipcMain.handle('worker:stats', async () => pollClient.getStats())
  ipcMain.handle('worker:history', async () => pollClient.getHistory())

  // ==================== settings ====================
  ipcMain.handle('settings:get', async () => settingsStore.get())
  ipcMain.handle('settings:set', async (_e, s: Partial<AppSettings>) => {
    const prev = settingsStore.get()
    const next = settingsStore.patch(s)

    // 开机自启（dev 模式调用会报 Operation not permitted，故仅打包后生效）
    if (s.autoLaunch !== undefined && process.platform !== 'linux' && app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!next.autoLaunch, openAsHidden: true })
      } catch (err: any) {
        logger.warn('Settings', `设置开机自启失败: ${err?.message || err}`)
      }
    }

    // 浏览器配置改变 → 关闭浏览器池，下次任务会重新 launch（应用新配置）
    const browserCfgChanged =
      (s.browserMaxContexts !== undefined && next.browserMaxContexts !== prev.browserMaxContexts) ||
      (s.browserExecutablePath !== undefined && next.browserExecutablePath !== prev.browserExecutablePath)
    if (s.browserMaxContexts !== undefined) {
      process.env.BROWSER_MAX_CONTEXTS = String(next.browserMaxContexts)
    }
    if (s.browserExecutablePath !== undefined) {
      process.env.BROWSER_EXECUTABLE_PATH = next.browserExecutablePath || ''
    }
    if (browserCfgChanged) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const browserPool = require('./core/browserPool.js')
        // 仅当当前没在跑任务时关闭，避免打断
        if (browserPool?.activeContexts === 0 || browserPool?.getStatus?.()?.activeContexts === 0) {
          await browserPool.shutdown?.()
          logger.info('Settings', '浏览器池已关闭，下次任务用新配置重启')
        } else {
          logger.info('Settings', '浏览器池有活动任务，新配置在下次空闲后生效')
        }
      } catch (e: any) {
        logger.warn('Settings', `应用浏览器新配置失败：${e.message}`)
      }
    }

    if (s.debug !== undefined) {
      process.env.WORKER_DEBUG = next.debug ? 'true' : ''
    }
    return next
  })

  // ==================== system ====================
  ipcMain.handle('system:openLogDir', async () => {
    await shell.openPath(logger.logDir())
  })
  ipcMain.handle('system:appVersion', async () => app.getVersion())
  ipcMain.handle('system:checkUpdate', async () => {
    const { checkForUpdatesManually } = await import('./updater')
    return checkForUpdatesManually()
  })

  // ==================== 推送 ====================
  // 状态变化推渲染（窗口隐藏时也尝试推，destroyed 时跳过）
  const pushStats = (stats: any): void => {
    const win = getWindow()
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('stats:update', stats)
    }
  }
  const pushTaskHistory = (item: any): void => {
    const win = getWindow()
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('task:history', item)
    }
  }
  const pushLog = (line: any): void => {
    const win = getWindow()
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('log:line', line)
    }
  }

  pollClient.on('stats', pushStats)
  pollClient.on('task:history', pushTaskHistory)
  // Token 失效：自动清凭据 + 通知渲染回到激活页
  pollClient.on('auth:invalid', async (info: any) => {
    logger.warn('Auth', `服务器拒绝 token：${info?.message || `HTTP ${info?.status}`}`)
    await credentials.clear()
    configStore.set(null)
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('auth:invalid', info)
    }
  })
  // 日志推渲染
  logger.on(pushLog)
}
