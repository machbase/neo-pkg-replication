import { useEffect, useState } from 'react'
import Icon from './Icon'

export default function ConfirmDialog({ title, message, onConfirm, onCancel }) {
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape' && !pending) onCancel() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onCancel, pending])

  const handleConfirm = async () => {
    if (pending) return
    setPending(true)
    try {
      await onConfirm()
    } finally {
      // pending 상태는 컴포넌트 unmount 시점까지만 유지되면 충분 (대부분 onConfirm 이후 부모가 닫음)
      setPending(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={() => { if (!pending) onCancel() }}>
      <div className="modal modal-sm" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-title">
            <Icon name="warning" className="text-warning" />
            {title}
          </div>
          <button
            onClick={onCancel}
            disabled={pending}
            className="p-4 hover:bg-surface-hover rounded-base tooltip disabled:opacity-50"
            data-tooltip="Close"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{message}</div>
        <div className="modal-footer">
          <button onClick={onCancel} disabled={pending} className="btn btn-content btn-ghost">
            Cancel
          </button>
          <button onClick={handleConfirm} disabled={pending} className="btn btn-content btn-danger">
            {pending && <Icon name="progress_activity" className="animate-spin" />}
            {pending ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
