import { request } from './client'

export const listJobs = () =>
  request('GET', '/api/jobs')

export const getJob = (id) =>
  request('GET', `/api/jobs/${encodeURIComponent(id)}`)

export const createJob = (data) =>
  request('POST', '/api/jobs', data)

export const updateJob = (id, data) =>
  request('PUT', `/api/jobs/${encodeURIComponent(id)}`, data)

export const deleteJob = (id) =>
  request('DELETE', `/api/jobs/${encodeURIComponent(id)}`)

export const startJob = (id) =>
  request('POST', `/api/jobs/${encodeURIComponent(id)}/start`)

export const stopJob = (id) =>
  request('POST', `/api/jobs/${encodeURIComponent(id)}/stop`)
