import { request } from './client'

export const listServers = () =>
  request('GET', '/api/servers')

export const createServer = (data) =>
  request('POST', '/api/servers', data)

export const updateServer = (name, data) =>
  request('PUT', `/api/servers/${encodeURIComponent(name)}`, data)

export const deleteServer = (name) =>
  request('DELETE', `/api/servers/${encodeURIComponent(name)}`)

export const checkHealth = (name) =>
  request('GET', `/api/servers/${encodeURIComponent(name)}/health`)

export const listTables = (name) =>
  request('GET', `/api/servers/${encodeURIComponent(name)}/tables`)

export const getTableSchema = (name, table) =>
  request('GET', `/api/servers/${encodeURIComponent(name)}/tables/${encodeURIComponent(table)}/schema`)
