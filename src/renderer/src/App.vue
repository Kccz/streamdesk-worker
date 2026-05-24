<script setup lang="ts">
import { ref, computed, h, onMounted, onUnmounted, watch } from 'vue'
import { useWorkerStore } from './stores/worker'
import Activate from './views/Activate.vue'
import Dashboard from './views/Dashboard.vue'
import Settings from './views/Settings.vue'
import About from './views/About.vue'
import Toast from './components/Toast.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'

type TabKey = 'dashboard' | 'settings' | 'about'

const store = useWorkerStore()
const tab = ref<TabKey>('dashboard')

const showActivate = computed(() => !store.activated)
const isOnline = computed(() =>
  store.stats.status === 'polling' || store.stats.status === 'running',
)
const statusTone = computed(() => {
  switch (store.stats.status) {
    case 'polling':
    case 'running':  return 'on'
    case 'error':    return 'err'
    case 'stopping': return 'off'
    default:         return 'off'
  }
})
const statusLabel = computed(() => {
  switch (store.stats.status) {
    case 'polling':  return '运行中'
    case 'running':  return '执行任务中'
    case 'stopping': return '停止中...'
    case 'error':    return '出错重试中'
    case 'stopped':  return '已停止'
    default:         return '空闲'
  }
})

// 运行时长（搬自 Dashboard）
const startedAt = ref<number | null>(null)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

watch(
  () => store.stats.status,
  (s, prev) => {
    if ((s === 'polling' || s === 'running') && (prev === 'stopped' || prev === 'idle' || !prev)) {
      startedAt.value = Date.now()
    } else if (s === 'stopped') {
      startedAt.value = null
    }
  },
  { immediate: true },
)

onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const uptimeText = computed(() => {
  if (!startedAt.value || !isOnline.value) return ''
  const ms = now.value - startedAt.value
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return `${hr}h${min % 60}m`
})

interface NavItem {
  key: TabKey
  label: string
  icon: () => any
}

// 简单 SVG 图标（避免引入图标库）
const Icon = {
  dashboard: () =>
    h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('path', { d: 'M3 13h8V3H3z' }),
      h('path', { d: 'M13 21h8V11h-8z' }),
      h('path', { d: 'M3 21h8v-6H3z' }),
      h('path', { d: 'M13 9h8V3h-8z' }),
    ]),
  settings: () =>
    h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('circle', { cx: 12, cy: 12, r: 3 }),
      h('path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' }),
    ]),
  info: () =>
    h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('circle', { cx: 12, cy: 12, r: 10 }),
      h('path', { d: 'M12 16v-4M12 8h.01' }),
    ]),
}

const navItems: NavItem[] = [
  { key: 'dashboard', label: '仪表盘', icon: Icon.dashboard },
  { key: 'settings', label: '应用设置', icon: Icon.settings },
  { key: 'about', label: '关于', icon: Icon.info },
]
</script>

<template>
  <div class="app">
    <Toast />
    <ConfirmDialog />
    <Activate v-if="showActivate" />
    <div v-else class="layout">
      <!-- 侧边栏 -->
      <aside class="sidebar">
        <div class="brand">
          <div class="logo">
            <span class="logo-letter">S</span>
          </div>
          <div class="brand-meta">
            <div class="brand-name">StreamDesk</div>
            <div class="brand-sub">Worker</div>
          </div>
        </div>

        <nav class="nav">
          <button
            v-for="item in navItems"
            :key="item.key"
            class="nav-item"
            :class="{ active: tab === item.key }"
            @click="tab = item.key"
          >
            <component :is="item.icon" />
            <span>{{ item.label }}</span>
          </button>
        </nav>

        <div class="sidebar-footer">
          <div class="status-line">
            <span class="status-dot" :class="`tone-${statusTone}`" />
            <span class="status-label">{{ statusLabel }}</span>
            <span v-if="uptimeText" class="status-uptime">{{ uptimeText }}</span>
          </div>
          <div class="device-line" :title="store.config?.workerId">
            {{ store.config?.workerId || '-' }}
          </div>
          <div class="ver">v{{ store.appVersion }}</div>
        </div>
      </aside>

      <!-- 主内容 -->
      <main class="content">
        <Dashboard v-if="tab === 'dashboard'" />
        <Settings v-else-if="tab === 'settings'" />
        <About v-else />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.layout {
  display: flex;
  height: 100%;
}

/* ==================== 侧边栏 ==================== */
.sidebar {
  width: 200px;
  background: var(--bg-elev);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  -webkit-app-region: drag;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 14px 14px;
  padding-top: 36px;
}
.logo {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--primary) 0%, #ff7043 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(239, 83, 80, 0.25);
}
.logo-letter {
  color: #fff;
  font-weight: 800;
  font-size: 16px;
  font-family: 'SF Pro Display', -apple-system, sans-serif;
}
.brand-meta {
  line-height: 1.2;
}
.brand-name {
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.2px;
}
.brand-sub {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.nav {
  -webkit-app-region: no-drag;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 8px;
  flex: 1;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  text-align: left;
  transition: all 0.15s;
  width: 100%;
}
.nav-item:hover {
  background: var(--bg-soft);
  color: var(--text);
}
.nav-item.active {
  background: var(--primary-soft);
  color: var(--primary);
}
.nav-item svg {
  flex-shrink: 0;
}

.sidebar-footer {
  -webkit-app-region: no-drag;
  padding: 14px 16px;
  border-top: 1px solid var(--border);
}

.status-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-subtle);
  flex-shrink: 0;
}
.status-dot.tone-on {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
  animation: blink 1.6s ease-in-out infinite;
}
.status-dot.tone-err {
  background: var(--error);
  box-shadow: 0 0 0 3px var(--error-soft);
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.status-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-uptime {
  font-family: 'Menlo', monospace;
  font-size: 10px;
  color: var(--text-subtle);
  flex-shrink: 0;
}
.device-line {
  font-family: 'Menlo', monospace;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ver {
  margin-top: 4px;
  color: var(--text-subtle);
  font-family: 'Menlo', monospace;
  font-size: 10px;
}

/* ==================== 主内容 ==================== */
.content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 28px;
  background: var(--bg);
}
</style>
