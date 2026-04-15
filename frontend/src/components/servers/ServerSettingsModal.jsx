import { useState, useEffect } from 'react'
import ServerForm from './ServerForm'
import ConfirmDialog from '../common/ConfirmDialog'
import Icon from '../common/Icon'
import useServers from '../../hooks/useServers'

export default function ServerSettingsModal({ onClose }) {
  const { servers, loading, addServer, editServer, removeServer } = useServers()
  const [showForm, setShowForm] = useState(false)
  const [editingServer, setEditingServer] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape' && !showForm && !confirmDelete) onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose, showForm, confirmDelete])

  const handleSave = async (data) => {
    try {
      if (editingServer) {
        await editServer(editingServer.name, data)
      } else {
        await addServer(data)
      }
      setShowForm(false)
      setEditingServer(null)
    } catch {
      return
    }
  }

  const handleDelete = async () => {
    try {
      await removeServer(confirmDelete)
      setConfirmDelete(null)
    } catch {
      return
    }
  }

  return (
    <>
      <div className="modal-overlay" onMouseDown={onClose}>
        <div className="modal modal-lg" onMouseDown={e => e.stopPropagation()}>
          <div className="modal-header">
            <div className="modal-header-title">
              <Icon name="dns" className="text-primary" />
              Server Settings
            </div>
            <button onClick={onClose} className="p-4 hover:bg-surface-hover rounded-base tooltip" data-tooltip="Close">
              <Icon name="close" />
            </button>
          </div>

          <div className="modal-body">
            {loading ? (
              <p className="text-on-surface-tertiary text-base py-8 text-center">Loading...</p>
            ) : servers.length === 0 ? (
              <div className="text-center py-12 text-on-surface-tertiary">
                <Icon name="dns" className="text-4xl mb-2 opacity-20" />
                <p className="text-sm font-medium">No servers configured</p>
                <p className="text-xs mt-1 opacity-60">Add a server to get started</p>
              </div>
            ) : (
              <div className="server-card-list">
                {servers.map(srv => (
                  <div key={srv.name} className="server-card">
                    <div className="server-card-info">
                      <div className="server-card-name-row">
                        <span className="server-card-name">{srv.name}</span>
                      </div>
                      <div className="server-card-detail">
                        {srv.host}:{srv.port} &middot; {srv.user}
                      </div>
                    </div>
                    <div className="server-card-actions">
                      <button
                        onClick={() => { setEditingServer(srv); setShowForm(true) }}
                        className="server-card-action tooltip"
                        data-tooltip="Edit"
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        onClick={() => setConfirmDelete(srv.name)}
                        className="server-card-action server-card-action--danger tooltip"
                        data-tooltip="Delete"
                      >
                        <Icon name="delete" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button onClick={onClose} className="btn btn-content btn-ghost">Close</button>
            <button
              onClick={() => { setEditingServer(null); setShowForm(true) }}
              className="btn btn-content btn-primary"
            >
              <Icon name="add" />
              Add Server
            </button>
          </div>
        </div>
      </div>

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
    </>
  )
}
