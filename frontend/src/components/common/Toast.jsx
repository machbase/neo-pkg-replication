import { useApp } from '../../context/AppContext'
import Icon from './Icon'

const typeStyles = {
  success: 'bg-green-50 text-green-800 border-green-200',
  error: 'bg-red-50 text-red-800 border-red-200',
  info: 'bg-blue-50 text-blue-800 border-blue-200',
}

const typeIcons = {
  success: 'check_circle',
  error: 'error',
  info: 'info',
}

export default function Toast() {
  const { notifications, dismissNotification } = useApp()

  if (notifications.length === 0) return null

  return (
    <div className="fixed bottom-6 right-6 z-50 space-y-2">
      {notifications.map(n => (
        <div
          key={n.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg min-w-[300px] animate-slide-in ${typeStyles[n.type] || typeStyles.info}`}
        >
          <Icon name={typeIcons[n.type] || typeIcons.info} className="text-xl" />
          <span className="flex-1 text-sm font-medium">{n.message}</span>
          <button onClick={() => dismissNotification(n.id)} className="opacity-60 hover:opacity-100">
            <Icon name="close" className="text-lg" />
          </button>
        </div>
      ))}
    </div>
  )
}
