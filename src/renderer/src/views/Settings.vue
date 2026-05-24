<script setup lang="ts">
import { ref, watch } from 'vue'
import { useWorkerStore } from '../stores/worker'

const store = useWorkerStore()
const local = ref({ ...store.settings })

watch(
  () => store.settings,
  (s) => (local.value = { ...s }),
  { deep: true },
)

const labels: Record<string, string> = {
  autoLaunch: '开机自启',
  debug: '调试日志',
  browserMaxContexts: '最大并发数',
  browserExecutablePath: '浏览器路径',
}

async function commit(key: keyof typeof local.value): Promise<void> {
  store.settings = await window.api.setSettings({ ...local.value })
  ;(window as any).__toast?.success('已保存', `${labels[key as string]}已更新`)
}

function onToggle(key: 'autoLaunch' | 'debug', val: boolean): void {
  local.value[key] = val
  commit(key)
}
function onNumberBlur(): void {
  if (!Number.isFinite(local.value.browserMaxContexts) || local.value.browserMaxContexts < 1) {
    local.value.browserMaxContexts = 1
  }
  if (local.value.browserMaxContexts > 20) local.value.browserMaxContexts = 20
  commit('browserMaxContexts')
}
function onPathBlur(): void {
  commit('browserExecutablePath')
}
</script>

<template>
  <div class="settings">
    <header class="page-head">
      <h1>应用设置</h1>
      <p class="muted">所有改动会自动保存</p>
    </header>

    <section class="card">
      <header class="card-head">
        <h2>运行</h2>
        <p class="muted">控制 worker 的启动方式和日志输出</p>
      </header>
      <div class="rows">
        <div class="row toggle-row">
          <div>
            <div class="row-title">开机自启</div>
            <div class="row-desc">登录系统时在后台自动启动 worker</div>
          </div>
          <label class="toggle">
            <input
              type="checkbox"
              :checked="local.autoLaunch"
              @change="onToggle('autoLaunch', ($event.target as HTMLInputElement).checked)"
            />
            <span class="track" />
          </label>
        </div>
        <div class="row toggle-row">
          <div>
            <div class="row-title">调试日志</div>
            <div class="row-desc">输出更详细的诊断信息（用于排查问题）</div>
          </div>
          <label class="toggle">
            <input
              type="checkbox"
              :checked="local.debug"
              @change="onToggle('debug', ($event.target as HTMLInputElement).checked)"
            />
            <span class="track" />
          </label>
        </div>
      </div>
    </section>

    <section class="card">
      <header class="card-head">
        <h2>浏览器</h2>
        <p class="muted">控制并发数量和使用哪个浏览器执行任务</p>
      </header>
      <div class="rows">
        <div class="row field-row">
          <div class="field-label">
            <div class="row-title">最大并发 context</div>
            <div class="row-desc">同一时间最多并行多少个登录任务（建议 3-8）</div>
          </div>
          <input
            v-model.number="local.browserMaxContexts"
            type="number"
            min="1"
            max="20"
            class="num-input"
            @blur="onNumberBlur"
          />
        </div>
        <div class="row">
          <div class="field-label">
            <div class="row-title">自定义浏览器路径</div>
            <div class="row-desc">留空使用 Playwright 自带 Chromium</div>
          </div>
          <input
            v-model="local.browserExecutablePath"
            placeholder="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            class="path-input"
            @blur="onPathBlur"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 720px;
  margin: 0 auto;
}
.page-head h1 {
  font-size: 18px;
  font-weight: 600;
}
.page-head .muted {
  font-size: 12px;
  margin-top: 2px;
}
.card-head {
  margin-bottom: 14px;
}
.card {
  padding: 18px 20px;
}
h2 {
  font-size: 14px;
  font-weight: 600;
}
.muted {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.row:last-child {
  border-bottom: none;
}
.toggle-row,
.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.row-title {
  font-size: 13px;
  font-weight: 500;
}
.row-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}
.field-label {
  flex: 1;
  min-width: 0;
}

/* Toggle */
.toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
  flex-shrink: 0;
}
.toggle input {
  display: none;
}
.toggle .track {
  position: absolute;
  inset: 0;
  background: var(--border);
  border-radius: 10px;
  transition: background 0.2s;
}
.toggle .track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
.toggle input:checked + .track {
  background: var(--primary);
}
.toggle input:checked + .track::after {
  transform: translateX(16px);
}

/* Inputs */
.num-input {
  width: 80px;
  text-align: center;
}
.path-input {
  width: 100%;
  font-family: 'Menlo', monospace;
  font-size: 11px;
  margin-top: 8px;
}
</style>
