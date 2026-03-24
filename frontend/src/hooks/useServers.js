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
      setServers(data)
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

  const healthCheck = useCallback(async (name) => {
    return await serversApi.checkHealth(name)
  }, [])

  return { servers, loading, addServer, editServer, removeServer, healthCheck, refreshServers: fetchServers }
}
