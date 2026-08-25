const REQUEST_TIMEOUT_MS = 12000

async function request(path, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = Array.isArray(payload.detail)
        ? payload.detail.map((item) => item.msg).join('；')
        : payload.detail
      throw new Error(detail || `请求失败（${response.status}）`)
    }
    return payload
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时，请检查本地服务。')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export const api = {
  createJob: (body) => request('/api/jobs', { method: 'POST', body: JSON.stringify(body) }),
  listJobs: () => request('/api/jobs'),
  getJob: (id) => request(`/api/jobs/${id}`),
  cancelJob: (id) => request(`/api/jobs/${id}/cancel`, { method: 'POST' }),
}
