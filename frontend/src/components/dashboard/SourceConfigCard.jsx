import { useEffect } from 'react'
import useTableSchema from '../../hooks/useTableSchema'
import Icon from '../common/Icon'

export default function SourceConfigCard({ job, servers }) {
  const server = servers.find(s => s.name === job.source?.server)
  const address = server ? `${server.host}:${server.port}` : job.source?.server || 'N/A'
  const tagId = job.source?.tagIdentifier
  const { columns: schemaColumns, fetchColumns } = useTableSchema()

  useEffect(() => {
    if (job.source?.server && job.source?.table) {
      fetchColumns(job.source.server, job.source.table)
    }
  }, [job.source?.server, job.source?.table, fetchColumns])

  const displayColumns = (() => {
    if (schemaColumns.length > 0) {
      if (job.source?.columns) {
        return schemaColumns.filter(c => job.source.columns.includes(c.name))
      }
      return schemaColumns
    }
    if (job.source?.columns) {
      return job.source.columns.map(name => ({ name, type: '' }))
    }
    return []
  })()

  let tagDisplay = 'None'
  if (tagId && tagId.mode !== 'none') {
    tagDisplay = `${tagId.mode}: ${tagId.value}`
  }

  return (
    <section className="bg-surface-container-lowest p-8 rounded-xl shadow-sm border border-outline-variant/15 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-1 h-full bg-primary" />
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-primary-container/10 flex items-center justify-center text-primary">
          <Icon name="database" />
        </div>
        <h3 className="text-xl font-bold tracking-tight">Source</h3>
      </div>
      <div className="grid grid-cols-2 gap-6 mb-6">
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-1 tracking-widest">Server</label>
          <p className="text-base font-medium text-on-surface">{address}</p>
        </div>
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-1 tracking-widest">Table</label>
          <p className="text-base font-medium text-on-surface">{job.source?.table || 'N/A'}</p>
        </div>
      </div>
      <div className="mb-6">
        <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Columns</label>
        <div className="flex flex-wrap gap-2">
          {displayColumns.length > 0 ? displayColumns.map(col => (
            <span key={col.name} className="px-3 py-1 bg-surface-container-high rounded text-sm font-medium text-on-surface-variant inline-flex items-center gap-1.5">
              {col.name}
              {col.type && <span className="text-[10px] text-outline">{col.type}</span>}
            </span>
          )) : (
            <span className="text-sm text-on-surface-variant">-</span>
          )}
        </div>
      </div>
      <div>
        <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-1 tracking-widest">Tag Identifier</label>
        <p className="text-sm text-on-surface">{tagDisplay}</p>
      </div>
    </section>
  )
}
