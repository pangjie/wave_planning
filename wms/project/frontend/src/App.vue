<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from './api'

const ACTIVE_STATUSES = ['queued', 'running']
const POLL_INTERVAL_MS = 1000
const RETRY_INTERVAL_MS = 2500

const workflow = ref('export')
const browserMode = ref('headed')
const waveInput = ref('')
const job = ref(null)
const error = ref('')
const connectionNotice = ref('')
const loading = ref(false)
const bootstrapping = ref(true)
const timelineRef = ref(null)
let pollTimer = null

const isActive = computed(() => ACTIVE_STATUSES.includes(job.value?.status))
const inputWaveNos = computed(() => {
  const seen = new Set()
  return waveInput.value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false
      seen.add(item)
      return true
    })
})
const invalidWaveNos = computed(() => (
  inputWaveNos.value.filter((item) => !/^[A-Za-z0-9_-]+$/.test(item))
))
const waveInputLimit = computed(() => (workflow.value === 'print_waves' ? 100 : 500))
const waveInputValid = computed(() => (
  invalidWaveNos.value.length === 0
  && inputWaveNos.value.length <= waveInputLimit.value
  && (workflow.value !== 'print_waves' || inputWaveNos.value.length > 0)
))
const waveInputStatus = computed(() => {
  if (!inputWaveNos.value.length) {
    return workflow.value === 'pick_waves'
      ? '留空时处理全部待拣货波次'
      : '每行输入一个波次号'
  }
  if (invalidWaveNos.value.length) return `格式异常：${invalidWaveNos.value.join('、')}`
  if (inputWaveNos.value.length > waveInputLimit.value) {
    return `一次最多输入 ${waveInputLimit.value} 个不同波次`
  }
  return `已识别 ${inputWaveNos.value.length} 个不同波次`
})
const waveInputLabel = computed(() => (
  workflow.value === 'pick_waves' ? '指定波次号（可选）' : '波次号'
))
const canStart = computed(() => (
  !isActive.value
  && !bootstrapping.value
  && (workflow.value === 'export' || waveInputValid.value)
))
const currentEvent = computed(() => {
  const events = job.value?.events
  return events?.[events.length - 1]
})
const jobModeLabel = computed(() => (
  ({
    export: '导出所有订单',
    print_waves: '打印选中波次',
    pick_waves: '所有波次拣货',
  }[job.value?.mode] || '自动化任务')
))
const buttonLabel = computed(() => {
  if (loading.value) return '正在创建任务…'
  if (isActive.value) return '任务执行中'
  if (workflow.value === 'print_waves') return '开始打印并合并'
  if (workflow.value === 'pick_waves') {
    return inputWaveNos.value.length
      ? `开始拣货 ${inputWaveNos.value.length} 个指定波次`
      : '开始全部待拣货波次'
  }
  return '提交正式导出'
})
const statusLabel = computed(() => ({
  queued: '排队中',
  running: '执行中',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '执行失败',
  cancelled: '已取消',
}[job.value?.status] || '尚未运行'))

function formatTime(value, includeDate = false) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    ...(includeDate ? { month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function stopPolling() {
  clearTimeout(pollTimer)
  pollTimer = null
}

function scheduleRefresh(delay = POLL_INTERVAL_MS) {
  stopPolling()
  pollTimer = setTimeout(refreshJob, delay)
}

async function restoreLatestJob() {
  try {
    const jobs = await api.listJobs()
    job.value = jobs.find((item) => ACTIVE_STATUSES.includes(item.status)) || jobs[0] || null
    if (job.value) {
      workflow.value = job.value.mode
      browserMode.value = job.value.browser_mode
      if (['print_waves', 'pick_waves'].includes(job.value.mode)) {
        waveInput.value = (job.value.wave_nos || []).join('\n')
      }
    }
    if (isActive.value) scheduleRefresh(0)
  } catch (err) {
    connectionNotice.value = `暂时无法读取任务状态：${err.message}`
  } finally {
    bootstrapping.value = false
  }
}

async function startJob() {
  if (!canStart.value) return
  loading.value = true
  error.value = ''
  connectionNotice.value = ''
  try {
    const payload = {
      mode: workflow.value,
      browser_mode: browserMode.value,
      confirm_production: true,
    }
    if (['print_waves', 'pick_waves'].includes(workflow.value)) {
      payload.wave_nos = inputWaveNos.value
    }
    job.value = await api.createJob(payload)
    scheduleRefresh(0)
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function refreshJob() {
  if (!job.value?.id) return
  try {
    job.value = await api.getJob(job.value.id)
    connectionNotice.value = ''
    if (isActive.value) scheduleRefresh()
  } catch (err) {
    connectionNotice.value = `状态连接暂时中断，正在自动重试：${err.message}`
    scheduleRefresh(RETRY_INTERVAL_MS)
  }
}

async function cancelJob() {
  if (!job.value?.id || loading.value) return
  loading.value = true
  error.value = ''
  try {
    job.value = await api.cancelJob(job.value.id)
    stopPolling()
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

watch(
  () => `${job.value?.id || ''}:${job.value?.events?.length || 0}`,
  async () => {
    await nextTick()
    if (timelineRef.value) timelineRef.value.scrollTop = timelineRef.value.scrollHeight
  },
  { flush: 'post' },
)

onMounted(restoreLatestJob)
onBeforeUnmount(stopPolling)
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">W</span>
        <div>
          <p>WMS AUTOMATION</p>
          <h1>自动化控制台</h1>
        </div>
      </div>
      <span class="environment"><i></i>生产环境</span>
    </header>

    <section class="workspace">
      <article class="panel control-panel">
        <div class="panel-heading">
          <div>
            <span class="section-label">CONTROL</span>
            <h2>任务设置</h2>
          </div>
          <span class="panel-number">01</span>
        </div>

        <fieldset class="workflow-switch" :disabled="isActive || bootstrapping">
          <legend>功能</legend>
          <label :class="{ selected: workflow === 'export' }">
            <input v-model="workflow" type="radio" value="export" />
            <span class="option-number">01</span>
            <strong>导出所有订单</strong>
            <span class="radio-mark" aria-hidden="true"></span>
          </label>
          <label :class="{ selected: workflow === 'print_waves' }">
            <input v-model="workflow" type="radio" value="print_waves" />
            <span class="option-number">02</span>
            <strong>打印选中波次</strong>
            <span class="radio-mark" aria-hidden="true"></span>
          </label>
          <label :class="{ selected: workflow === 'pick_waves' }">
            <input v-model="workflow" type="radio" value="pick_waves" />
            <span class="option-number">03</span>
            <strong>所有波次拣货</strong>
            <span class="radio-mark" aria-hidden="true"></span>
          </label>
        </fieldset>

        <section v-if="['print_waves', 'pick_waves'].includes(workflow)" class="wave-options">
          <div class="input-heading">
            <label for="wave-input">{{ waveInputLabel }}</label>
            <span :class="{ invalid: !waveInputValid && inputWaveNos.length }">{{ waveInputStatus }}</span>
          </div>
          <textarea
            id="wave-input"
            v-model="waveInput"
            :disabled="isActive || bootstrapping"
            rows="6"
            spellcheck="false"
            placeholder="W0092607180001&#10;W0092607180002"
          ></textarea>
        </section>

        <fieldset class="browser-switch" :disabled="isActive || bootstrapping">
          <legend>浏览器模式</legend>
          <label :class="{ selected: browserMode === 'headed' }">
            <input v-model="browserMode" type="radio" value="headed" />
            <span><strong>有头模式</strong><small>显示浏览器</small></span>
          </label>
          <label :class="{ selected: browserMode === 'headless' }">
            <input v-model="browserMode" type="radio" value="headless" />
            <span><strong>无头模式</strong><small>后台运行</small></span>
          </label>
        </fieldset>

        <p v-if="error" class="message error-message" role="alert">{{ error }}</p>
        <p v-if="connectionNotice" class="message connection-message" role="status">{{ connectionNotice }}</p>

        <div class="actions">
          <button class="primary-action" :disabled="!canStart || loading" @click="startJob">
            <span>{{ buttonLabel }}</span><b aria-hidden="true">↗</b>
          </button>
          <button v-if="isActive" class="cancel-action" :disabled="loading" @click="cancelJob">取消任务</button>
        </div>

        <details class="session-note">
          <summary>登录会话说明</summary>
          <p>首次运行请在弹出的专用浏览器中登录。会话仅保存在本机，后续任务会自动复用。</p>
        </details>
      </article>

      <article class="panel status-panel" :aria-busy="isActive">
        <div class="panel-heading">
          <div>
            <span class="section-label">ACTIVITY</span>
            <h2>执行记录</h2>
          </div>
          <span class="status-chip" :class="job?.status || 'idle'"><i></i>{{ statusLabel }}</span>
        </div>

        <div v-if="bootstrapping" class="empty-state" role="status">
          <span>SYNCING</span>
          <strong>正在读取任务</strong>
        </div>

        <div v-else-if="!job" class="empty-state">
          <span>READY</span>
          <strong>等待任务</strong>
        </div>

        <template v-else>
          <div class="job-summary">
            <div>
              <span>{{ isActive ? '当前任务' : '最近任务' }}</span>
              <strong>{{ jobModeLabel }}</strong>
            </div>
            <time>{{ formatTime(job.created_at, true) }}</time>
          </div>

          <div v-if="currentEvent" class="current-event" aria-live="polite">
            <span>最新进度</span>
            <p>{{ currentEvent.message }}</p>
          </div>

          <ol ref="timelineRef" class="timeline" aria-label="任务执行日志">
            <li
              v-for="(event, index) in job.events"
              :key="`${event.at}-${index}`"
              :class="{ latest: index === job.events.length - 1 }"
            >
              <span class="timeline-dot" aria-hidden="true"></span>
              <div>
                <time>{{ formatTime(event.at) }}</time>
                <p>{{ event.message }}</p>
                <code>{{ event.stage }}</code>
              </div>
            </li>
          </ol>

          <div v-if="job.result" class="result-card" :class="{ partial: job.status === 'partial' }">
            <span>结果</span>
            <strong>{{ job.result.message }}</strong>
            <small v-if="job.result.template">模板：{{ job.result.template }}</small>
            <small v-if="job.result.wave_nos">波次号：{{ job.result.wave_nos.join('、') }}</small>
            <small v-if="job.result.failed_wave_nos?.length">未完成波次：{{ job.result.failed_wave_nos.join('、') }}</small>
            <small v-for="warning in job.result.warnings || []" :key="warning">提示：{{ warning }}</small>
            <small v-if="job.result.wave_count">完成波次：{{ job.result.wave_count }} 个</small>
            <small v-if="job.result.sku_rows">SKU 明细合计：{{ job.result.sku_rows }} 条</small>
            <small v-if="job.result.task_filename">任务文件：{{ job.result.task_filename }}</small>
            <small v-if="job.result.downloaded_file">保存位置：{{ job.result.downloaded_file }}</small>
            <small v-if="job.result.downloaded_copy">另存副本：{{ job.result.downloaded_copy }}</small>
            <small v-if="job.result.printed_files">单独文件：{{ job.result.printed_files.join('、') }}</small>
            <small v-if="job.result.merged_file">合并文件：{{ job.result.merged_file }}</small>
          </div>
          <div v-if="job.error" class="result-card failed" role="alert">
            <span>错误</span><strong>{{ job.error }}</strong>
          </div>
        </template>
      </article>
    </section>
  </main>
</template>
