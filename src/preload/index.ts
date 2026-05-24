import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  LogLine,
  RuntimeStats,
  TaskHistoryItem,
  WorkerConfig,
} from '../shared/types'

interface ActivatePayload {
  server: string
  code: string
  deviceName: string
}

interface ActivateResult {
  ok: boolean
  workerId?: string
  error?: string
}

interface UpdateCheckResult {
  ok: boolean
  message?: string
}

interface AuthInvalidInfo {
  status?: number
  message?: string
}

const api = {
  // ===== auth / config =====
  isActivated: (): Promise<boolean> => ipcRenderer.invoke('auth:isActivated'),
  activate: (payload: ActivatePayload): Promise<ActivateResult> =>
    ipcRenderer.invoke('auth:activate', payload),
  logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  getConfig: (): Promise<WorkerConfig | null> => ipcRenderer.invoke('config:get'),

  // ===== worker =====
  startWorker: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('worker:start'),
  stopWorker: (): Promise<void> => ipcRenderer.invoke('worker:stop'),
  abortCurrent: (): Promise<void> => ipcRenderer.invoke('worker:abortCurrent'),
  getStats: (): Promise<RuntimeStats> => ipcRenderer.invoke('worker:stats'),
  getHistory: (): Promise<TaskHistoryItem[]> => ipcRenderer.invoke('worker:history'),

  // ===== settings =====
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', s),

  // ===== system =====
  openLogDir: (): Promise<void> => ipcRenderer.invoke('system:openLogDir'),
  appVersion: (): Promise<string> => ipcRenderer.invoke('system:appVersion'),
  checkUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('system:checkUpdate'),

  // ===== 订阅推送（返回 unsubscribe） =====
  onStats: (cb: (s: RuntimeStats) => void): (() => void) => {
    const handler = (_: unknown, s: RuntimeStats): void => cb(s)
    ipcRenderer.on('stats:update', handler)
    return () => ipcRenderer.off('stats:update', handler)
  },
  onLog: (cb: (line: LogLine) => void): (() => void) => {
    const handler = (_: unknown, line: LogLine): void => cb(line)
    ipcRenderer.on('log:line', handler)
    return () => ipcRenderer.off('log:line', handler)
  },
  onTaskHistory: (cb: (item: TaskHistoryItem) => void): (() => void) => {
    const handler = (_: unknown, item: TaskHistoryItem): void => cb(item)
    ipcRenderer.on('task:history', handler)
    return () => ipcRenderer.off('task:history', handler)
  },
  onAuthInvalid: (cb: (info: AuthInvalidInfo) => void): (() => void) => {
    const handler = (_: unknown, info: AuthInvalidInfo): void => cb(info)
    ipcRenderer.on('auth:invalid', handler)
    return () => ipcRenderer.off('auth:invalid', handler)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ApiBridge = typeof api
