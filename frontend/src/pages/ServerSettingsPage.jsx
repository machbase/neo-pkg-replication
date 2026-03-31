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
    <div className="p-5">
      <div className="flex justify-between items-center mb-4">
        <h2 className="page-title">Server Settings</h2>
        <button
          onClick={() => { setEditingServer(null); setShowForm(true) }}
          className="btn btn-content btn-primary"
        >
          <Icon name="add"  />
          Add Server
        </button>
      </div>

      {loading ? (
        <p className="text-on-surface-tertiary text-base">Loading...</p>
      ) : servers.length === 0 ? (
        <div className="text-center py-8 text-on-surface-tertiary">
          <Icon name="dns" className="text-4xl mb-2 opacity-30" />
          <p className="text-md font-medium">No servers configured</p>
          <p className="text-sm mt-1 opacity-60">Add a server to get started</p>
        </div>
      ) : (
        <div className="space-y-1">
          {servers.map(srv => (
            <div key={srv.name} className="bg-surface-alt py-2 px-4 rounded-base border border-border flex items-center gap-3">
              <Icon name="dns" className="text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <h4 className="text-base font-semibold text-on-surface">{srv.name}</h4>
                <p className="text-sm text-on-surface-tertiary">{srv.host}:{srv.port} &middot; {srv.user}</p>
              </div>
              <div className="flex items-center gap-1">
                {healthResults[srv.name] === 'checking' && (
                  <span className="text-sm text-on-surface-tertiary">Checking...</span>
                )}
                {healthResults[srv.name] === 'healthy' && (
                  <span className="text-sm text-success font-medium flex items-center gap-1">
                    <Icon name="check_circle" className="icon-sm" /> OK
                  </span>
                )}
                {healthResults[srv.name] === 'unhealthy' && (
                  <span className="text-sm text-error font-medium flex items-center gap-1">
                    <Icon name="error" className="icon-sm" /> Fail
                  </span>
                )}
                <button
                  onClick={() => handleHealthCheck(srv.name)}
                  className="p-1 text-on-surface-tertiary hover:bg-surface-hover rounded-base transition-colors"
                  title="Check health"
                >
                  <Icon name="monitor_heart"  />
                </button>
                <button
                  onClick={() => { setEditingServer(srv); setShowForm(true) }}
                  className="p-1 text-on-surface-tertiary hover:bg-surface-hover rounded-base transition-colors"
                  title="Edit"
                >
                  <Icon name="edit"  />
                </button>
                <button
                  onClick={() => setConfirmDelete(srv.name)}
                  className="p-1 text-error hover:bg-error-muted rounded-base transition-colors"
                  title="Delete"
                >
                  <Icon name="delete"  />
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
