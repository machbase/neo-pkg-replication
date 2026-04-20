import { useState, useEffect, useCallback } from 'react'
import * as serversApi from '../api/servers'
import { useApp } from '../context/AppContext'

export default function useServers() {
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(true)
  const { notify } = useApp()

  const fetchServers = useCallback(async () => {
    try {
      const data = await serversApi.listServers()
      setServers(Array.isArray(data) ? data : [])
    } catch (e) {
      notify(e.reason || e.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  const addServer = useCallback(async (data) => {
    try {
      await serversApi.createServer(data)
      notify(`Server '${data.name}' created`, 'success')
      await fetchServers()
    } catch (e) {
      notify(e.reason || e.message, 'error')
      throw e
    }
  }, [fetchServers, notify])

  const editServer = useCallback(async (name, data) => {
    try {
      await serversApi.updateServer(name, data)
      notify(`Server '${name}' updated`, 'success')
      await fetchServers()
    } catch (e) {
      notify(e.reason || e.message, 'error')
      throw e
    }
  }, [fetchServers, notify])

  const removeServer = useCallback(async (name) => {
    try {
      await serversApi.deleteServer(name)
      notify(`Server '${name}' deleted`, 'success')
      await fetchServers()
    } catch (e) {
      notify(e.reason || e.message, 'error')
      throw e
    }
  }, [fetchServers, notify])

  // notify는 호출부에서 처리 (리스트=toast, 폼=인라인 메시지)
  const testServer = useCallback((payload) => serversApi.testServer(payload), [])

  return { servers, loading, addServer, editServer, removeServer, testServer, refreshServers: fetchServers }
}
