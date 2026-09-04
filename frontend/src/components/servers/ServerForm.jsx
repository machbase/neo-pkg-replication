import { useState, useEffect, useRef } from 'react'
import Icon from '../common/Icon'
import { koToEn } from '../../utils/korean'
import * as serversApi from '../../api/servers'

const inputClass = 'w-full'
const labelClass = 'block text-on-surface-secondary mb-2'

const TYPES = [
  { value: 'native', label: 'native' },
  { value: 'http', label: 'http' },
  { value: 'mqtt-api', label: 'mqtt-api' },
  { value: 'mqtt-publish', label: 'mqtt-publish' },
]

// backend에서 오는 profile keys 기준 (null 포함 전체 키). targetOnly는 저장 대상 아님.
const PROFILE_KEYS = ['name', 'type', 'host', 'port', 'database', 'user', 'password', 'token', 'protocol', 'qos', 'retain']

function pickProfile(src) {
  const out = {}
  for (const k of PROFILE_KEYS) out[k] = src?.[k] ?? null
  return out
}

export default function ServerForm({ server, onSave, onClose }) {
  const isEdit = Boolean(server)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null) // { ok, message }
  const initialized = useRef(false)

  const [form, setForm] = useState(() => {
    const base = pickProfile(server || {})
    base.type = server?.type || 'native'
    base.name = server?.name || ''
    base.password = ''
    base.token = ''
    base.database = server?.database || 'MACHBASEDB'
    return base
  })

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // create 모드: 최초 마운트 시 native default 로드. 이후 type 변경 시마다 default 로드.
  // edit 모드: 기존 server 값을 우선 사용하고 누락 필드만 default로 보충.
  useEffect(() => {
    let cancelled = false
    serversApi.getServerDefault(form.type)
      .then((data) => {
        if (cancelled) return
        const defaults = pickProfile(data?.profile || {})
        setForm((prev) => {
          if (isEdit && !initialized.current) {
            // 최초 1회: 기존 서버 값을 defaults 위에 오버레이
            initialized.current = true
            const base = { ...defaults, ...pickProfile(server) }
            return { ...base, password: '', token: '' }
          }
          if (!isEdit && !initialized.current) {
            initialized.current = true
            return { ...defaults, name: prev.name || '' }
          }
          // type 변경 케이스: 이름은 유지하고 나머지는 새 type 의 default 로 덮어쓰기
          return { ...defaults, name: prev.name || '', type: prev.type }
        })
      })
      .catch(() => { /* noop — 기본값 없으면 비어있는 폼 사용 */ })
    return () => { cancelled = true }
  }, [form.type, isEdit, server])

  const onField = (key) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((p) => ({ ...p, [key]: v }))
  }

  // 저장 payload: null/빈값 필드 + targetOnly 제거. 한국어 password/token은 이미 onChange에서 변환됨.
  const buildPayload = () => {
    const payload = { name: form.name, type: form.type, host: form.host, port: Number(form.port) }
    if (form.type !== 'mqtt-publish') payload.database = form.database || 'MACHBASEDB'
    if (form.type === 'native') {
      payload.user = form.user
      payload.password = form.password
    } else if (form.type === 'http') {
      payload.protocol = form.protocol || 'http'
      payload.token = form.token
    } else if (form.type === 'mqtt-api') {
      payload.token = form.token
      if (form.qos !== null && form.qos !== '') payload.qos = Number(form.qos)
    } else if (form.type === 'mqtt-publish') {
      payload.token = form.token
      if (form.qos !== null && form.qos !== '') payload.qos = Number(form.qos)
      payload.retain = Boolean(form.retain)
      if (form.user) payload.user = form.user
      if (form.password) payload.password = form.password
    }
    // edit 모드에서 비밀값 빈 값이면 기존 유지 — 키 자체 제거
    if (isEdit) {
      if ('password' in payload && !payload.password) delete payload.password
      if ('token' in payload && !payload.token) delete payload.token
    }
    return payload
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setSaving(true)
    try {
      await onSave(buildPayload())
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // 저장 전 테스트는 profile 전체를 전송. name 비어있어도 허용됨.
      const profile = buildPayload()
      // 저장 payload 에서 password/token 이 제거됐더라도 테스트에는 기존 값이 필요할 수 있음
      // edit 모드 + 비밀값 미입력 → 저장된 서버로 테스트
      if (isEdit && ((form.type === 'native' && !form.password) || (form.type !== 'native' && !form.token && !form.password))) {
        const r = await serversApi.testServer({ name: server.name })
        setTestResult({ ok: true, message: formatTestMessage(r) })
      } else {
        if (!profile.password) profile.password = form.password || ''
        if (!profile.token) profile.token = form.token || ''
        const r = await serversApi.testServer({ profile })
        setTestResult({ ok: true, message: formatTestMessage(r) })
      }
    } catch (err) {
      setTestResult({ ok: false, message: err.reason || err.message || 'Connection test failed' })
    } finally {
      setTesting(false)
    }
  }

  const formatTestMessage = (r) => {
    const probe = r?.probe || 'connect'
    const targetOnly = r?.targetOnly ? ' · target only' : ''
    return `Connected (${probe}${targetOnly})`
  }

  const showField = (name) => {
    const t = form.type
    // https 미지원 — protocol 셀렉트 숨기고 http로 고정 (buildPayload에서 default 'http')
    if (name === 'protocol') return false
    if (name === 'token') return t === 'http' || t === 'mqtt-api' || t === 'mqtt-publish'
    if (name === 'user') return t === 'native' || t === 'mqtt-publish'
    if (name === 'password') return t === 'native' || t === 'mqtt-publish'
    if (name === 'qos') return t === 'mqtt-api' || t === 'mqtt-publish'
    if (name === 'retain') return t === 'mqtt-publish'
    return true
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal-md" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-title">
            <Icon name={isEdit ? 'edit' : 'add_circle'} className="text-primary" />
            {isEdit ? 'Edit Server' : 'Add Server'}
          </div>
          <button onClick={onClose} className="p-4 hover:bg-surface-hover rounded-base tooltip" data-tooltip="Close">
            <Icon name="close" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={labelClass}>Name</label>
                <input
                  type="text"
                  required
                  disabled={isEdit}
                  value={form.name || ''}
                  onChange={onField('name')}
                  className={`${inputClass} disabled:opacity-50`}
                  placeholder="e.g., src"
                />
              </div>
              <div>
                <label className={labelClass}>Type</label>
                <select
                  value={form.type}
                  onChange={onField('type')}
                  disabled={isEdit}
                  className={`${inputClass} disabled:opacity-50`}
                >
                  {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={labelClass}>IP</label>
                <input
                  type="text"
                  required
                  value={form.host || ''}
                  onChange={onField('host')}
                  className={inputClass}
                  placeholder="127.0.0.1"
                />
              </div>
              <div>
                <label className={labelClass}>Port</label>
                <input
                  type="number"
                  required
                  value={form.port ?? ''}
                  onChange={onField('port')}
                  className={inputClass}
                />
              </div>
            </div>

            {form.type !== 'mqtt-publish' && (
              <div>
                <label className={labelClass}>Database</label>
                <input
                  type="text"
                  required
                  value={form.database || 'MACHBASEDB'}
                  onChange={onField('database')}
                  className={inputClass}
                  placeholder="MACHBASEDB"
                />
              </div>
            )}

            {showField('protocol') && (
              <div>
                <label className={labelClass}>Protocol</label>
                <select
                  value={form.protocol || 'http'}
                  onChange={onField('protocol')}
                  className={inputClass}
                >
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
              </div>
            )}

            {(showField('user') || showField('password')) && (
              <div className="grid grid-cols-2 gap-3">
                {showField('user') && (
                  <div>
                    <label className={labelClass}>
                      ID{form.type === 'mqtt-publish' ? ' (optional)' : ''}
                    </label>
                    <input
                      type="text"
                      required={form.type === 'native'}
                      value={form.user || ''}
                      onChange={onField('user')}
                      className={inputClass}
                    />
                  </div>
                )}
                {showField('password') && (
                  <div>
                    <label className={labelClass}>
                      Password{form.type === 'mqtt-publish' ? ' (optional)' : ''}
                    </label>
                    <input
                      type="text"
                      required={form.type === 'native' && !isEdit}
                      value={form.password || ''}
                      onChange={(e) => setForm(p => ({ ...p, password: koToEn(e.target.value) }))}
                      className={`${inputClass} input-password`}
                      placeholder={isEdit ? 'Leave blank to keep current' : ''}
                    />
                  </div>
                )}
              </div>
            )}

            {showField('token') && (
              <div>
                <label className={labelClass}>Token</label>
                <input
                  type="text"
                  value={form.token || ''}
                  onChange={(e) => setForm(p => ({ ...p, token: koToEn(e.target.value) }))}
                  className={`${inputClass} input-password`}
                  placeholder={isEdit ? 'Leave blank to keep current' : ''}
                />
              </div>
            )}

            {(showField('qos') || showField('retain')) && (
              <div className="grid grid-cols-2 gap-3">
                {showField('qos') && (
                  <div>
                    <label className={labelClass}>QoS</label>
                    <select
                      value={form.qos ?? 1}
                      onChange={onField('qos')}
                      className={inputClass}
                    >
                      <option value={0}>0</option>
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                    </select>
                  </div>
                )}
                {showField('retain') && (
                  <div>
                    <label className={labelClass}>Retain</label>
                    <label className="flex items-center gap-2 mt-2">
                      <input
                        type="checkbox"
                        checked={Boolean(form.retain)}
                        onChange={onField('retain')}
                      />
                      <span className="text-on-surface-secondary">publish with retain flag</span>
                    </label>
                  </div>
                )}
              </div>
            )}

          </div>

          <div className="modal-footer">
            <div style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || saving}
                className="btn btn-content btn-ghost"
              >
                <Icon name={testing ? 'progress_activity' : 'cable'} className={testing ? 'animate-spin' : ''} />
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              {testResult && (
                <span
                  className="text-sm inline-flex items-center"
                  style={{
                    gap: 6,
                    color: `var(--color-${testResult.ok ? 'success' : 'error'})`,
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
                  {testResult.message}
                </span>
              )}
            </div>
            <button type="button" onClick={onClose} className="btn btn-content btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn btn-content btn-primary">
              {isEdit ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
