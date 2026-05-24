import { defineStore } from 'pinia'
import { ref, onMounted, onUnmounted } from 'vue'
import type { LogLine, RuntimeStats, TaskHistoryItem, WorkerConfig, AppSettings } from '../../../shared/types'

export const useWorkerStore = defineStore('worker', () => {
  const activated = ref(false)
  const config = ref<WorkerConfig | null>(null)
  const stats = ref<RuntimeStats>({
    status: 'stopped',
    current: null,
    todayTotal: 0,
    todaySuccess: 0,
    todayFailed: 0,
  })
  const settings = ref<AppSettings>({
    debug: false,
    autoLaunch: false,
    browserMaxContexts: 5,
    browserExecutablePath: '',
  })
  const logs = ref<LogLine[]>([])
  const history = ref<TaskHistoryItem[]>([])
  const appVersion = ref('')

  async function refresh(): Promise<void> {
    activated.value = await window.api.isActivated()
    config.value = await window.api.getConfig()
    stats.value = await window.api.getStats()
    settings.value = await window.api.getSettings()
    appVersion.value = await window.api.appVersion()
    history.value = await window.api.getHistory()
  }

  function appendLog(line: LogLine): void {
    logs.value.push(line)
    if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500)
  }

  function appendHistory(item: TaskHistoryItem): void {
    history.value.unshift(item)
    if (history.value.length > 200) history.value.length = 200
  }

  onMounted(() => {
    refresh()
    window.api.onStats((s) => (stats.value = s))
    window.api.onLog((l) => appendLog(l))
    window.api.onTaskHistory((i) => appendHistory(i))
    window.api.onAuthInvalid((info) => {
      // token 被撤销 → 主进程已经清凭证了，前端弹提示并刷新回到激活页
      const reason = info?.status === 403
        ? '该节点已被云端禁用'
        : info?.message || '激活码已失效或被撤销'
      // 延迟一帧确保 Toast 组件已挂载
      requestAnimationFrame(() => {
        const w = window as any
        w.__toast?.error('设备授权失效', `${reason}，请重新激活`)
      })
      refresh()
    })
  })

  // 兜底轮询：状态推送可能因为窗口隐藏 / IPC 抖动丢失，每 1.5s 主动拉一次
  let pollTimer: ReturnType<typeof setInterval> | null = null
  onMounted(() => {
    pollTimer = setInterval(async () => {
      try {
        const s = await window.api.getStats()
        if (
          s.status !== stats.value.status ||
          s.todayTotal !== stats.value.todayTotal ||
          (s.current?.id || null) !== (stats.value.current?.id || null)
        ) {
          stats.value = s
        }
      } catch {
        /* ignore */
      }
    }, 1500)
  })
  onUnmounted(() => {
    if (pollTimer) clearInterval(pollTimer)
  })

  return {
    activated,
    config,
    stats,
    settings,
    logs,
    history,
    appVersion,
    refresh,
  }
})
