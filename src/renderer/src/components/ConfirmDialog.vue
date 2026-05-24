<script setup lang="ts">
import { ref } from 'vue'

interface ConfirmOptions {
  title: string
  desc?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

const current = ref<PendingConfirm | null>(null)

function confirm(opts: ConfirmOptions): Promise<boolean> {
  // 同时只允许一个确认框：如果已经有一个，先 resolve 为 false
  if (current.value) {
    current.value.resolve(false)
  }
  return new Promise<boolean>((resolve) => {
    current.value = { ...opts, resolve }
  })
}

function close(ok: boolean): void {
  if (!current.value) return
  current.value.resolve(ok)
  current.value = null
}

function onOverlayClick(): void {
  close(false)
}

// 全局暴露
;(window as any).__confirm = confirm
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg">
      <div v-if="current" class="dlg-overlay" @click.self="onOverlayClick">
        <div class="dlg" @click.stop>
          <div class="dlg-icon" :class="{ danger: current.danger }">
            <svg v-if="current.danger" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
          </div>
          <div class="dlg-body">
            <div class="dlg-title">{{ current.title }}</div>
            <div v-if="current.desc" class="dlg-desc">{{ current.desc }}</div>
          </div>
          <div class="dlg-actions">
            <button class="btn" @click="close(false)">{{ current.cancelText || '取消' }}</button>
            <button :class="['btn', current.danger ? 'btn-danger' : 'btn-primary']" @click="close(true)">
              {{ current.confirmText || '确定' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dlg-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
  z-index: 9998;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.dlg {
  width: 100%;
  max-width: 380px;
  background: var(--bg-elev);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border);
  padding: 22px 22px 18px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 14px 14px;
}
.dlg-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--info-soft);
  color: var(--info);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  align-self: start;
}
.dlg-icon.danger {
  background: var(--error-soft);
  color: var(--error);
}
.dlg-body {
  min-width: 0;
}
.dlg-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.45;
}
.dlg-desc {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}
.dlg-actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.btn-danger {
  background: var(--error);
  border-color: var(--error);
  color: #fff;
}
.btn-danger:hover {
  background: #b91c1c;
  border-color: #b91c1c;
}

.dlg-enter-active,
.dlg-leave-active {
  transition: opacity 0.2s ease;
}
.dlg-enter-active .dlg,
.dlg-leave-active .dlg {
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.dlg-enter-from,
.dlg-leave-to {
  opacity: 0;
}
.dlg-enter-from .dlg,
.dlg-leave-to .dlg {
  transform: scale(0.95) translateY(8px);
}
</style>
