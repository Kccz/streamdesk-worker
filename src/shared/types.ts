// 主进程 / 渲染进程共用类型

export type WorkerStatus = 'idle' | 'polling' | 'running' | 'stopping' | 'stopped' | 'error'

export interface WorkerConfig {
  server: string
  workerId: string
  // token 不在这里返回（敏感，存 keychain）
}

export interface AppSettings {
  /** 调试日志 */
  debug: boolean
  /** 开机自启 */
  autoLaunch: boolean
  /** 浏览器最大并发 context */
  browserMaxContexts: number
  /** 自定义浏览器路径（留空走 Playwright 自带） */
  browserExecutablePath?: string
}

export interface CurrentTask {
  id: string
  type: 'netflix_login' | 'manual_operate'
  email: string
  startedAt: number
}

export interface TaskHistoryItem {
  id: string
  type: string
  email: string
  success: boolean
  error?: string
  duration: number
  finishedAt: number
}

export interface RuntimeStats {
  status: WorkerStatus
  current: CurrentTask | null
  todayTotal: number
  todaySuccess: number
  todayFailed: number
}

export interface LogLine {
  level: 'info' | 'warn' | 'error' | 'debug'
  ts: number
  text: string
}

/** 渲染进程 → 主进程 单向调用 (invoke) */
export interface IpcInvoke {
  /** 是否已激活（钥匙串里有 token） */
  'auth:isActivated': () => Promise<boolean>
  /** 用激活码兑换 token（保存到钥匙串） */
  'auth:activate': (payload: { server: string; code: string; deviceName: string }) => Promise<{
    ok: boolean
    workerId?: string
    error?: string
  }>
  /** 注销，清除 token */
  'auth:logout': () => Promise<void>
  /** 拿当前配置（不包含 token） */
  'config:get': () => Promise<WorkerConfig | null>

  /** 启动 worker poll */
  'worker:start': () => Promise<{ ok: boolean; error?: string }>
  /** 停止 worker poll */
  'worker:stop': () => Promise<void>
  /** 当前运行状态 */
  'worker:stats': () => Promise<RuntimeStats>

  /** 设置 */
  'settings:get': () => Promise<AppSettings>
  'settings:set': (s: Partial<AppSettings>) => Promise<AppSettings>

  /** 系统：打开日志目录 / 应用版本 */
  'system:openLogDir': () => Promise<void>
  'system:appVersion': () => Promise<string>
}

/** 主进程 → 渲染进程 推送事件（renderer 监听） */
export interface IpcPush {
  'stats:update': RuntimeStats
  'log:line': LogLine
  'task:history': TaskHistoryItem
}
