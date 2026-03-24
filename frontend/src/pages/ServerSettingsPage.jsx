import { useState } from 'react'
import ServerForm from '../components/servers/ServerForm'
import ConfirmDialog from '../components/common/ConfirmDialog'
import Icon from '../components/common/Icon'

export default function ServerSettingsPage({ servers, loading, onAdd, onEdit, onDelete, onHealthCheck }) {
  const [showForm, setShowForm] = useState(false)
  const [editingServer, setEditingServer] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [healthResults, setHealthResults] = useState({})

  const handleSave = async (data) => {
    try {
      if (editingServer) {
        await onEdit(editingServer.name, data)
      } else {
        await onAdd(data)
      }
      setShowForm(false)
      setEditingServer(null)
    } catch {
      return
    }
  }

  const handleDelete = async () => {
    try {
      await onDelete(confirmDelete)
      setConfirmDelete(null)
    } catch {
      return
    }
  }

  const handleHealthCheck = async (name) => {
    setHealthResults(prev => ({ ...prev, [name]: 'checking' }))
    try {
      await onHealthCheck(name)
      setHealthResults(prev => ({ ...prev, [name]: 'healthy' }))
    } catch {
      setHealthResults(prev => ({ ...prev, [name]: 'unhealthy' }))
    }
  }

  return (
    <div className="p-10">
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-3xl font-extrabold tracking-tight text-on-surface">Server Settings</h2>
        <button
          onClick={() => { setEditingServer(null); setShowForm(true) }}
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-on-primary bg-gradient-to-br from-primary to-primary-container rounded-lg shadow-sm"
        >
          <Icon name="add" className="text-xl" />
          Add Server
        </button>
      </div>

      {loading ? (
        <p className="text-on-surface-variant">Loading...</p>
      ) : servers.length === 0 ? (
        <div className="text-center py-16 text-on-surface-variant">
          <Icon name="dns" className="text-6xl mb-4 opacity-30" />
          <p className="text-lg font-medium">No servers configured</p>
          <p className="text-sm mt-2 opacity-60">Add a server to get started</p>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map(srv => (
            <div key={srv.name} className="bg-surface-container-lowest p-5 rounded-xl border border-outline-variant/15 flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-primary-container/10 flex items-center justify-center text-primary">
                <Icon name="dns" />
              </div>
              <div className="flex-1">
                <h4 className="font-bold text-on-surface">{srv.name}</h4>
                <p className="text-sm text-on-surface-variant">{srv.host}:{srv.port} &middot; {srv.user}</p>
              </div>
              <div className="flex items-center gap-2">
                {healthResults[srv.name] === 'checking' && (
                  <span className="text-xs text-on-surface-variant">Checking...</span>
                )}
                {healthResults[srv.name] === 'healthy' && (
                  <span className="text-xs text-green-600 font-semibold flex items-center gap-1">
                    <Icon name="check_circle" className="text-sm" /> Connected
                  </span>
                )}
                {healthResults[srv.name] === 'unhealthy' && (
                  <span className="text-xs text-error font-semibold flex items-center gap-1">
                    <Icon name="error" className="text-sm" /> Failed
                  </span>
                )}
                <button
                  onClick={() => handleHealthCheck(srv.name)}
                  className="p-2 text-on-surface-variant hover:bg-surface-container-high rounded-lg transition-colors"
                  title="Check health"
                >
                  <Icon name="monitor_heart" className="text-xl" />
                </button>
                <button
                  onClick={() => { setEditingServer(srv); setShowForm(true) }}
                  className="p-2 text-on-surface-variant hover:bg-surface-container-high rounded-lg transition-colors"
                  title="Edit"
                >
                  <Icon name="edit" className="text-xl" />
                </button>
                <button
                  onClick={() => setConfirmDelete(srv.name)}
                  className="p-2 text-error hover:bg-error-container/20 rounded-lg transition-colors"
                  title="Delete"
                >
                  <Icon name="delete" className="text-xl" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <ServerForm
          server={editingServer}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditingServer(null) }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete Server"
          message={`Are you sure you want to delete server "${confirmDelete}"?`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}
