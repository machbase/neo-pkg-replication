import { useState, useCallback } from 'react'
import { listTables, getTableSchema } from '../api/servers'
import { useApp } from '../context/AppContext'

export default function useTableSchema() {
  const { notify } = useApp()
  const [tables, setTables] = useState([])
  const [columns, setColumns] = useState([])

  const fetchTables = useCallback(async (serverName) => {
    if (!serverName) { setTables([]); return }
    try {
      const data = await listTables(serverName)
      setTables(data)
    } catch (e) {
      setTables([])
      notify(e.reason || e.message, 'error')
    }
  }, [notify])

  const fetchColumns = useCallback(async (serverName, tableName) => {
    if (!serverName || !tableName) { setColumns([]); return }
    try {
      const data = await getTableSchema(serverName, tableName)
      setColumns(data)
    } catch (e) {
      setColumns([])
      notify(e.reason || e.message, 'error')
    }
  }, [notify])

  return { tables, columns, fetchTables, fetchColumns }
}
