class ApiError extends Error {
  constructor(status, reason) {
    super(reason)
    this.status = status
    this.reason = reason
  }
}

const API_BASE = import.meta.env.VITE_API_BASE ?? '/web/apps/neo-replication'

async function request(method, path, body) {
  const opts = {
    method,
    headers: {}
  }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }

  const res = await fetch(API_BASE + path, opts)

  if (res.status === 204) return null

  const json = await res.json()
  if (!json.ok) throw new ApiError(res.status, json.reason)
  return json.data
}

export { request, ApiError }
