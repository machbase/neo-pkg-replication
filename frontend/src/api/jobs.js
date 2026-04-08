import { request } from './client'

const RC = '/cgi-bin/api/rc'

// list 응답: [{ name, installed, running }]
function mapListItem(j) {
  const { checkpoints, ...rest } = j
  return { ...rest, id: j.name, installed: j.installed, status: j.running ? 'running' : 'stopped' }
}

export const listJobs = async () => {
  const data = await request('GET', `${RC}/list`)
  return data.map(mapListItem)
}

// 단건 응답: { name, config: { ... }, checkpoints: { ... } }
export const getJob = async (name) => {
  const data = await request('GET', `${RC}?name=${encodeURIComponent(name)}`)
  return { name: data.name, ...data.config, checkpoints: data.checkpoints }
}

// 생성: { name, config }
export const createJob = (data) =>
  request('POST', RC, data)

// 수정: ReplicatorConfig 본문
export const updateJob = (name, config) =>
  request('PUT', `${RC}?name=${encodeURIComponent(name)}`, config)

export const deleteJob = (name) =>
  request('DELETE', `${RC}?name=${encodeURIComponent(name)}`)

export const startJob = (name) =>
  request('POST', `${RC}/start?name=${encodeURIComponent(name)}`)

export const stopJob = (name) =>
  request('POST', `${RC}/stop?name=${encodeURIComponent(name)}`)

export const recoverJob = (name) =>
  request('POST', `${RC}/recover?name=${encodeURIComponent(name)}`)

export const overwriteJob = (name) =>
  request('POST', `${RC}/overwrite?name=${encodeURIComponent(name)}`)

export const installJob = (name) =>
  request('POST', `${RC}/install?name=${encodeURIComponent(name)}`)

export const fetchTableColumns = ({ host, port, user, password, table }) =>
  request('POST', '/cgi-bin/api/table/columns', { host, port: Number(port), user, password, table })
