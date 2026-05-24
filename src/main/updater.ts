/**
 * 自动更新（基于 electron-updater + GitHub Releases）
 * 启动后 5s 静默检查，发现新版下载，下载完成弹询问
 */
import { app, dialog, BrowserWindow } from 'electron'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { logger } from './logger'

let configured = false
let mainWindowGetter: (() => BrowserWindow | null) | null = null

export function setupAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (configured) return
  configured = true
  mainWindowGetter = getWindow

  // dev 模式不检查更新
  if (!app.isPackaged) {
    logger.debug('Updater', '开发模式跳过自动更新')
    return
  }

  // 没配 publish 渠道（未签名内测）：跳过自动检查，避免 GH_TOKEN missing 错误
  // 用户可以通过「关于 → 检查更新」手动触发
  // electron-updater 在没配置时会在 update-config-not-found 抛错
  let configMissing = false
  try {
    // 提前探测一次，确认 publish 配置存在
    // updater.getFeedURL() 没配置时返回 null
    if (typeof (autoUpdater as any).getFeedURL === 'function') {
      const feed = (autoUpdater as any).getFeedURL?.()
      if (!feed) configMissing = true
    }
  } catch {
    configMissing = true
  }

  if (configMissing) {
    logger.debug('Updater', '未配置发布渠道，跳过自动更新检查（关于页可手动检查）')
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (msg: any) => logger.info('Updater', String(msg)),
    warn: (msg: any) => logger.warn('Updater', String(msg)),
    error: (msg: any) => logger.error('Updater', String(msg)),
    debug: (msg: any) => logger.debug('Updater', String(msg)),
  } as any

  autoUpdater.on('checking-for-update', () => {
    logger.info('Updater', '检查更新中...')
  })
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logger.info('Updater', `发现新版本 ${info.version}（当前 ${app.getVersion()}）`)
    sendToRenderer('update:available', info)
  })
  autoUpdater.on('update-not-available', () => {
    logger.debug('Updater', '已是最新版本')
  })
  autoUpdater.on('error', (err) => {
    logger.warn('Updater', `更新失败: ${err?.message || err}`)
  })
  autoUpdater.on('download-progress', (p) => {
    logger.debug('Updater', `下载进度 ${p.percent.toFixed(1)}% (${(p.bytesPerSecond / 1024).toFixed(0)} KB/s)`)
    sendToRenderer('update:progress', { percent: p.percent, bytesPerSecond: p.bytesPerSecond })
  })
  autoUpdater.on('update-downloaded', async (info: UpdateInfo) => {
    logger.info('Updater', `更新已下载 v${info.version}，等待用户确认重启`)
    sendToRenderer('update:downloaded', info)

    const win = mainWindowGetter?.()
    const choice = await dialog.showMessageBox(win || undefined!, {
      type: 'info',
      title: '更新可用',
      message: `StreamDesk Worker v${info.version} 已下载完成`,
      detail: '是否立即重启以应用更新？',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice.response === 0) {
      ;(global as any).__isQuitting = true
      autoUpdater.quitAndInstall(false, true)
    }
  })

  // 启动 5s 后检查一次，之后每 4 小时检查一次
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 5_000)
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 4 * 60 * 60 * 1000)
}

function sendToRenderer(channel: string, payload: any): void {
  try {
    mainWindowGetter?.()?.webContents.send(channel, payload)
  } catch { /* ignore */ }
}

/** 用户主动检查更新（设置/关于页按钮调用） */
export async function checkForUpdatesManually(): Promise<{ ok: boolean; message?: string }> {
  if (!app.isPackaged) {
    return { ok: false, message: '开发模式不支持检查更新' }
  }
  try {
    const r = await autoUpdater.checkForUpdates()
    if (r?.updateInfo?.version === app.getVersion()) {
      return { ok: true, message: '已是最新版本' }
    }
    return { ok: true, message: '正在检查...' }
  } catch (e: any) {
    return { ok: false, message: e?.message || '检查失败' }
  }
}
