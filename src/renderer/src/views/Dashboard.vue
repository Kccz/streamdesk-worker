<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useWorkerStore } from '../stores/worker'

const store = useWorkerStore()
const logRef = ref<HTMLElement | null>(null)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

// 启动时间（用于显示运行时长）
// → 已移到 App.vue 的侧边栏底部

// 日志面板控制
const logLevel = ref<'all' | 'info' | 'warn' | 'error'>('all')
const autoScroll = ref(true)

const filteredLogs = computed(() => {
  if (logLevel.value === 'all') return store.logs
  return store.logs.filter((l) => l.level === logLevel.value)
})

function levelLabel(lvl: string): string {
  return { info: '信息', warn: '警告', error: '错误', debug: '调试' }[lvl] || lvl
}

function clearLogs(): void {
  store.logs.length = 0
}

function onLogScroll(): void {
  const el = logRef.value
  if (!el) return
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 12
  autoScroll.value = atBottom
}

watch(
  () => filteredLogs.value.length,
  () => {
    if (!autoScroll.value) return
    nextTick(() => {
      const el = logRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)

onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const isRunning = computed(() =>
  store.stats.status === 'polling' || store.stats.status === 'running',
)
const isStopping = computed(() => store.stats.status === 'stopping')
const successRate = computed(() => {
  if (store.stats.todayTotal === 0) return null
  return Math.round((store.stats.todaySuccess / store.stats.todayTotal) * 100)
})

async function start(): Promise<void> {
  await window.api.startWorker()
  ;(window as any).__toast?.success('Worker 已启动', '正在连接云端拉取任务')
}
async function stop(): Promise<void> {
  await window.api.stopWorker()
}
async function abortCurrent(): Promise<void> {
  const ok = await (window as any).__confirm?.({
    title: '中止当前任务？',
    desc: '任务会被标记为失败并上报到云端',
    confirmText: '中止',
    danger: true,
  })
  if (!ok) return
  await window.api.abortCurrent()
  ;(window as any).__toast?.warning('已中止', '当前任务已请求中止')
}
async function logout(): Promise<void> {
  const ok = await (window as any).__confirm?.({
    title: '注销并清除本地凭证？',
    desc: '设备配置 / 任务历史 / 今日统计 都会被清除，且需要重新激活',
    confirmText: '注销',
    danger: true,
  })
  if (!ok) return
  await window.api.logout()
  await store.refresh()
  ;(window as any).__toast?.info('已注销', '本地凭证、历史和统计已清除')
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
function logIcon(level: string): string {
  switch (level) {
    case 'error': return '✕'
    case 'warn':  return '!'
    case 'debug': return '·'
    default:      return '›'
  }
}
</script>

<template>
  <div class="dashboard">
    <!-- 页面标题 + 操作 -->
    <header class="page-head">
      <div>
        <h1>仪表盘</h1>
        <p class="muted">实时监控 worker 状态和今日任务</p>
      </div>
      <div class="head-actions">
        <button v-if="!isRunning && !isStopping" class="btn btn-primary" @click="start">
          <span class="ico">▶</span>
          启动
        </button>
        <button v-else class="btn" :disabled="isStopping" @click="stop">
          <span class="ico">■</span>
          {{ isStopping ? '停止中...' : '停止' }}
        </button>
        <button class="btn ghost" @click="logout">注销</button>
      </div>
    </header>

    <!-- ==================== 紧凑统计 ==================== -->
    <section class="stats-card">
      <div class="mini-stat">
        <div class="mini-label">今日任务</div>
        <div class="mini-value">{{ store.stats.todayTotal }}</div>
      </div>
      <div class="mini-stat">
        <div class="mini-label">成功</div>
        <div class="mini-value success">{{ store.stats.todaySuccess }}</div>
      </div>
      <div class="mini-stat">
        <div class="mini-label">失败</div>
        <div class="mini-value error">{{ store.stats.todayFailed }}</div>
      </div>
      <div class="mini-stat">
        <div class="mini-label">成功率</div>
        <div class="mini-value">
          <template v-if="successRate === null"><span class="dim">-</span></template>
          <template v-else>{{ successRate }}<span class="unit">%</span></template>
        </div>
      </div>
    </section>

    <!-- 当前任务（条幅，仅在有任务时显示） -->
    <Transition name="fade">
      <section v-if="store.stats.current" class="current-task">
        <div class="ct-pulse" />
        <div class="ct-info">
          <span class="ct-label">正在执行</span>
          <span class="ct-id">#{{ store.stats.current.id }}</span>
          <span class="ct-type">{{ store.stats.current.type }}</span>
          <span class="ct-email">{{ store.stats.current.email }}</span>
        </div>
        <div class="ct-time">{{ fmtMs(now - store.stats.current.startedAt) }}</div>
        <button class="ct-abort" title="中止当前任务" @click="abortCurrent">中止</button>
      </section>
    </Transition>

    <!-- ==================== 最近任务 / 实时日志 ==================== -->
    <section class="logs-grid">
      <div class="card history">
        <div class="card-head">
          <h3>最近任务</h3>
          <span class="card-count">{{ store.history.length }}</span>
        </div>
        <div v-if="store.history.length === 0" class="empty">
          <span class="empty-icon">⏳</span>
          <p>暂无任务记录</p>
        </div>
        <ul v-else class="history-list">
          <li v-for="h in store.history" :key="h.id">
            <span class="hist-dot" :class="h.success ? 'ok' : 'fail'" />
            <span class="hist-time">{{ fmtTime(h.finishedAt) }}</span>
            <span class="hist-email">{{ h.email }}</span>
            <span class="hist-duration">{{ fmtMs(h.duration) }}</span>
            <span :class="['hist-status', h.success ? 'ok' : 'fail']">
              {{ h.success ? '成功' : '失败' }}
            </span>
          </li>
        </ul>
      </div>

      <div class="card log-panel">
        <div class="card-head">
          <h3>实时日志</h3>
          <div class="log-toolbar">
            <select v-model="logLevel" class="log-select">
              <option value="all">全部</option>
              <option value="info">信息</option>
              <option value="warn">警告</option>
              <option value="error">错误</option>
            </select>
            <button class="log-btn" :class="{ active: !autoScroll }" @click="autoScroll = !autoScroll" :title="autoScroll ? '暂停自动滚动' : '恢复自动滚动'">
              {{ autoScroll ? '⏸' : '▶' }}
            </button>
            <button class="log-btn" title="清空" @click="clearLogs">✕</button>
          </div>
        </div>
        <div ref="logRef" class="log-list" @scroll="onLogScroll">
          <div v-if="filteredLogs.length === 0" class="empty">
            <span class="empty-icon">∅</span>
            <p>暂无{{ logLevel === 'all' ? '' : levelLabel(logLevel) }}日志</p>
          </div>
          <div
            v-for="(line, i) in filteredLogs"
            :key="i"
            :class="['log-line', `lvl-${line.level}`]"
          >
            <span class="log-icon">{{ logIcon(line.level) }}</span>
            <span class="log-ts">{{ fmtTime(line.ts) }}</span>
            <span class="log-text">{{ line.text }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
}

/* ===== 页面标题 ===== */
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}
.page-head h1 {
  font-size: 18px;
  font-weight: 600;
}
.page-head .muted {
  font-size: 12px;
  margin-top: 2px;
}
.head-actions {
  display: flex;
  gap: 8px;
}
.btn .ico {
  font-size: 10px;
  margin-right: 2px;
}
.btn.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
}
.btn.ghost:hover {
  background: var(--bg-soft);
  color: var(--text);
}

/* ==================== 紧凑统计卡 ==================== */
.stats-card {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}
.mini-stat {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  border-right: 1px solid var(--border);
  transition: background 0.15s;
}
.mini-stat:last-child {
  border-right: none;
}
.mini-stat:hover {
  background: var(--bg-soft);
}
.mini-label {
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.3px;
}
.mini-value {
  font-size: 24px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.mini-value.success { color: var(--success); }
.mini-value.error { color: var(--error); }
.mini-value .unit {
  font-size: 14px;
  color: var(--text-muted);
  margin-left: 2px;
  font-weight: 600;
}
.dim {
  color: var(--text-subtle);
}

/* ===== 当前任务条 ===== */
.current-task {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  background: var(--primary-soft);
  border: 1px solid rgba(239, 83, 80, 0.2);
  border-radius: 10px;
}
.ct-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 4px rgba(239, 83, 80, 0.25);
  animation: pulse-mini 1.2s ease-out infinite;
  flex-shrink: 0;
}
@keyframes pulse-mini {
  0%   { box-shadow: 0 0 0 0 rgba(239, 83, 80, 0.5); }
  100% { box-shadow: 0 0 0 8px rgba(239, 83, 80, 0); }
}
.ct-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  min-width: 0;
}
.ct-label {
  color: var(--text-muted);
  font-size: 11px;
}
.ct-id {
  font-family: 'Menlo', monospace;
  background: var(--primary-soft);
  color: var(--primary);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
}
.ct-type {
  background: var(--bg-soft);
  padding: 2px 8px;
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 11px;
}
.ct-email {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ct-time {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  font-family: 'Menlo', monospace;
  font-size: 12px;
}
.ct-abort {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-weight: 500;
  transition: all 0.15s;
}
.ct-abort:hover {
  background: var(--error-soft);
  border-color: rgba(220, 38, 38, 0.3);
  color: var(--error);
}

/* ===== 历史 / 日志 ===== */
.logs-grid {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.card {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  background: var(--bg-card);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.card-head h3 {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-muted);
}
.card-count {
  background: var(--bg-soft);
  color: var(--text-muted);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-variant-numeric: tabular-nums;
}

.log-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.log-select {
  font-size: 11px;
  padding: 3px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  outline: none;
  cursor: pointer;
}
.log-select:focus {
  border-color: var(--primary);
}
.log-btn {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-muted);
  background: transparent;
  transition: all 0.15s;
}
.log-btn:hover {
  background: var(--bg-soft);
  color: var(--text);
}
.log-btn.active {
  background: var(--warning-soft);
  color: var(--warning);
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--text-muted);
  font-size: 12px;
  padding: 24px 12px;
}
.empty-icon {
  font-size: 24px;
  opacity: 0.4;
  margin-bottom: 4px;
}

/* 历史 */
.history-list {
  list-style: none;
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
}
.history-list li {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  transition: background 0.15s;
}
.history-list li:hover {
  background: var(--bg-soft);
}
.hist-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.hist-dot.ok { background: var(--success); }
.hist-dot.fail { background: var(--error); }
.hist-time {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  font-family: 'Menlo', monospace;
  font-size: 11px;
  flex-shrink: 0;
}
.hist-email {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hist-duration {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  flex-shrink: 0;
}
.hist-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}
.hist-status.ok   { background: var(--success-soft); color: var(--success); }
.hist-status.fail { background: var(--error-soft);   color: var(--error); }

/* 日志 */
.log-list {
  flex: 1;
  overflow-y: auto;
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.7;
  user-select: text;
  padding: 6px 0;
}
.log-line {
  display: flex;
  gap: 8px;
  padding: 2px 16px;
  align-items: flex-start;
}
.log-line:hover {
  background: var(--bg-soft);
}
.log-icon {
  width: 14px;
  text-align: center;
  color: var(--text-muted);
  flex-shrink: 0;
  opacity: 0.6;
}
.log-ts {
  color: var(--text-muted);
  flex-shrink: 0;
  opacity: 0.7;
}
.log-text {
  word-break: break-all;
  flex: 1;
}
.lvl-error .log-icon { color: var(--error); opacity: 1; }
.lvl-error .log-text { color: var(--error); }
.lvl-warn .log-icon { color: var(--warning); opacity: 1; }
.lvl-warn .log-text { color: var(--warning); }
.lvl-debug .log-text { color: var(--text-muted); }

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
