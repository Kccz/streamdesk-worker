<script setup lang="ts">
import { ref } from 'vue'

interface ToastItem {
  id: number
  type: 'info' | 'success' | 'warning' | 'error'
  message: string
  desc?: string
}

const toasts = ref<ToastItem[]>([])
let nextId = 1

function show(opts: Omit<ToastItem, 'id'>, duration = 4000): number {
  const id = nextId++
  toasts.value.push({ id, ...opts })
  if (duration > 0) {
    setTimeout(() => dismiss(id), duration)
  }
  return id
}

function dismiss(id: number): void {
  const idx = toasts.value.findIndex((t) => t.id === id)
  if (idx >= 0) toasts.value.splice(idx, 1)
}

// 全局暴露给 store / 其它地方调用
const win = window as any
win.__toast = {
  info: (msg: string, desc?: string) => show({ type: 'info', message: msg, desc }),
  success: (msg: string, desc?: string) => show({ type: 'success', message: msg, desc }),
  warning: (msg: string, desc?: string) => show({ type: 'warning', message: msg, desc }, 6000),
  error: (msg: string, desc?: string) => show({ type: 'error', message: msg, desc }, 8000),
}

defineExpose({ show })
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack">
      <TransitionGroup name="toast">
        <div v-for="t in toasts" :key="t.id" :class="['toast', `t-${t.type}`]">
          <span class="toast-icon">
            <template v-if="t.type === 'success'">✓</template>
            <template v-else-if="t.type === 'warning'">!</template>
            <template v-else-if="t.type === 'error'">✕</template>
            <template v-else>i</template>
          </span>
          <div class="toast-body">
            <div class="toast-msg">{{ t.message }}</div>
            <div v-if="t.desc" class="toast-desc">{{ t.desc }}</div>
          </div>
          <button class="toast-close" @click="dismiss(t.id)">×</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-width: 380px;
  width: calc(100% - 32px);
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: var(--shadow-md);
  font-size: 13px;
  position: relative;
  min-width: 260px;
}
.toast::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 3px;
  border-radius: 10px 0 0 10px;
}
.toast.t-info::before    { background: var(--info); }
.toast.t-success::before { background: var(--success); }
.toast.t-warning::before { background: var(--warning); }
.toast.t-error::before   { background: var(--error); }

.toast-icon {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
  color: #fff;
  margin-top: 1px;
}
.t-info .toast-icon    { background: var(--info); }
.t-success .toast-icon { background: var(--success); }
.t-warning .toast-icon { background: var(--warning); }
.t-error .toast-icon   { background: var(--error); }

.toast-body {
  flex: 1;
  min-width: 0;
}
.toast-msg {
  font-weight: 500;
  line-height: 1.4;
  word-break: break-word;
}
.toast-desc {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

.toast-close {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 14px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.toast-close:hover {
  background: var(--bg-soft);
  color: var(--text);
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(20px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
.toast-leave-active {
  position: absolute;
  width: 100%;
}
</style>
