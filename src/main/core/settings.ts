import Store from 'electron-store'
import type { AppSettings, WorkerConfig, TaskHistoryItem } from '@shared/types'

interface DailyStats {
  date: string // YYYY-M-D
  total: number
  success: number
  failed: number
}

interface Schema {
  config: WorkerConfig | null
  settings: AppSettings
  history: TaskHistoryItem[]
  dailyStats: DailyStats | null
}

const defaults: Schema = {
  config: null,
  settings: {
    debug: false,
    autoLaunch: false,
    browserMaxContexts: 5,
    browserExecutablePath: '',
  },
  history: [],
  dailyStats: null,
}

const store = new Store<Schema>({ name: 'config', defaults })

export const configStore = {
  get: (): WorkerConfig | null => store.get('config'),
  set: (cfg: WorkerConfig | null): void => {
    if (cfg === null) store.delete('config' as any)
    else store.set('config', cfg)
  },
}

export const settingsStore = {
  get: (): AppSettings => store.get('settings'),
  patch: (s: Partial<AppSettings>): AppSettings => {
    const next = { ...store.get('settings'), ...s }
    store.set('settings', next)
    return next
  },
}

const HISTORY_MAX = 200 // 持久化最多保留多少条

export const historyStore = {
  list: (): TaskHistoryItem[] => store.get('history', []),
  push: (item: TaskHistoryItem): TaskHistoryItem[] => {
    const list = [item, ...store.get('history', [])].slice(0, HISTORY_MAX)
    store.set('history', list)
    return list
  },
  clear: (): void => {
    store.set('history', [])
  },
}

export const statsStore = {
  get: (): DailyStats => {
    const today = todayKey()
    const cur = store.get('dailyStats')
    if (!cur || cur.date !== today) {
      const reset: DailyStats = { date: today, total: 0, success: 0, failed: 0 }
      store.set('dailyStats', reset)
      return reset
    }
    return cur
  },
  bump: (success: boolean): DailyStats => {
    const cur = statsStore.get()
    cur.total++
    if (success) cur.success++
    else cur.failed++
    store.set('dailyStats', cur)
    return cur
  },
  reset: (): DailyStats => {
    const fresh: DailyStats = { date: todayKey(), total: 0, success: 0, failed: 0 }
    store.set('dailyStats', fresh)
    return fresh
  },
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
