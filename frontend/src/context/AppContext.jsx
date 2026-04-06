import { createContext, useContext, useState, useCallback, useRef } from 'react'
import * as jobsApi from '../api/jobs'

const AppContext = createContext(null)

let notifId = 0

export function AppProvider({ children }) {
  const [selectedJobId, setSelectedJobId] = useState(null)
  const [notifications, setNotifications] = useState([])
  const [jobDetail, setJobDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const detailCacheRef = useRef({ id: null, data: null })

  const notify = useCallback((message, type = 'info') => {
    const id = ++notifId
    setNotifications(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id))
    }, 4000)
  }, [])

  const dismissNotification = useCallback((id) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
  }, [])

  const fetchJobDetail = useCallback(async (jobId, force = false) => {
    if (!jobId) {
      setJobDetail(null)
      return null
    }
    if (!force && detailCacheRef.current.id === jobId && detailCacheRef.current.data) {
      setJobDetail(detailCacheRef.current.data)
      return detailCacheRef.current.data
    }
    const isRefresh = force && detailCacheRef.current.id === jobId && detailCacheRef.current.data
    if (!isRefresh) setDetailLoading(true)
    try {
      const data = await jobsApi.getJob(jobId)
      detailCacheRef.current = { id: jobId, data }
      setJobDetail(data)
      return data
    } catch (e) {
      notify(e.reason || e.message, 'error')
      if (!isRefresh) setJobDetail(null)
      return null
    } finally {
      if (!isRefresh) setDetailLoading(false)
    }
  }, [notify])

  const clearJobDetail = useCallback(() => {
    detailCacheRef.current = { id: null, data: null }
    setJobDetail(null)
  }, [])

  return (
    <AppContext.Provider value={{
      selectedJobId, setSelectedJobId,
      notifications, notify, dismissNotification,
      jobDetail, detailLoading, fetchJobDetail, clearJobDetail
    }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
