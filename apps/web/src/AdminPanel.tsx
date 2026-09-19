import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  createOperator,
  createWorkerCredential,
  HubApiError,
  listAdminUsers,
  listWorkerCredentials,
  revokeUserSessions,
  revokeWorkerCredential,
  rotateWorkerCredential,
  setUserStatus,
} from './hub-api'
import type { ConnectionMode, WebUser, WorkerCredential } from './types'

interface AdminPanelProps {
  connectionMode: ConnectionMode
  onNotice: (message: string) => void
  onUnauthorized: () => void
}

interface OneTimeSecret {
  credential: WorkerCredential
  token: string
}

export default function AdminPanel({ connectionMode, onNotice, onUnauthorized }: AdminPanelProps) {
  const [users, setUsers] = useState<WebUser[]>([])
  const [credentials, setCredentials] = useState<WorkerCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [workingKey, setWorkingKey] = useState('')
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [agentId, setAgentId] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [oneTimeSecret, setOneTimeSecret] = useState<OneTimeSecret | null>(null)
  const refreshInFlight = useRef(false)
  const canWrite = connectionMode === 'live'

  const handleError = useCallback((caught: unknown, fallback: string) => {
    if (caught instanceof HubApiError && caught.status === 401) {
      onUnauthorized()
      return
    }
    setError(formatApiError(caught, fallback))
  }, [onUnauthorized])

  const loadData = useCallback(async (signal?: AbortSignal) => {
    if (refreshInFlight.current || connectionMode !== 'live') return
    refreshInFlight.current = true
    setLoading(true)
    try {
      const [nextUsers, nextCredentials] = await Promise.all([
        listAdminUsers(signal),
        listWorkerCredentials(signal),
      ])
      setUsers(nextUsers)
      setCredentials(nextCredentials)
      setError('')
    } catch (caught) {
      if (!isAbortError(caught)) handleError(caught, '系统管理数据加载失败')
    } finally {
      refreshInFlight.current = false
      setLoading(false)
    }
  }, [connectionMode, handleError])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => void loadData(controller.signal), 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadData])

  async function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canWrite || !username.trim() || password.length < 12) return
    setWorkingKey('create-user')
    setError('')
    try {
      await createOperator(username.trim(), password)
      setUsername('')
      setPassword('')
      onNotice('Operator 已创建')
      await loadData()
    } catch (caught) {
      handleError(caught, 'Operator 创建失败')
    } finally {
      setPassword('')
      setWorkingKey('')
    }
  }

  async function changeUserStatus(user: WebUser) {
    if (!canWrite || user.role !== 'operator') return
    const nextStatus = user.status === 'disabled' ? 'active' : 'disabled'
    if (nextStatus === 'disabled' && !window.confirm(`停用 ${user.username} 并撤销其全部会话？`)) return
    setWorkingKey(`user-status:${user.id}`)
    try {
      const next = await setUserStatus(user.id, nextStatus)
      setUsers((current) => current.map((item) => item.id === next.id ? next : item))
      onNotice(nextStatus === 'active' ? '用户已启用' : '用户已停用，现有会话已撤销')
    } catch (caught) {
      handleError(caught, '用户状态更新失败')
    } finally {
      setWorkingKey('')
    }
  }

  async function revokeSessions(user: WebUser) {
    if (!canWrite || !window.confirm(`撤销 ${user.username} 的全部现有会话？`)) return
    setWorkingKey(`user-sessions:${user.id}`)
    try {
      const result = await revokeUserSessions(user.id)
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, activeSessionCount: 0 } : item))
      onNotice(`已撤销 ${result.revokedSessions} 个会话`)
    } catch (caught) {
      handleError(caught, '会话撤销失败')
    } finally {
      setWorkingKey('')
    }
  }

  async function submitWorker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedAgentId = agentId.trim()
    const normalizedDeviceId = deviceId.trim() || normalizedAgentId
    const validation = validateIdentityId(normalizedAgentId, 'Agent ID') || validateIdentityId(normalizedDeviceId, 'Device ID')
    if (!canWrite || validation) {
      if (validation) setError(validation)
      return
    }
    setWorkingKey('create-worker')
    setError('')
    try {
      const result = await createWorkerCredential(normalizedAgentId, normalizedDeviceId)
      if (!result.token) throw new Error('服务端未返回一次性 Worker Token')
      setOneTimeSecret(result)
      setAgentId('')
      setDeviceId('')
      onNotice('Worker 凭据已创建；请立即保存一次性 Token')
      await loadData()
    } catch (caught) {
      handleError(caught, 'Worker 凭据创建失败')
    } finally {
      setWorkingKey('')
    }
  }

  async function rotateCredential(credential: WorkerCredential) {
    if (!canWrite || !window.confirm(`轮换 ${credential.agentId} 的凭据？旧 Token 将立即失效。`)) return
    setWorkingKey(`worker-rotate:${credential.credentialId}`)
    try {
      const result = await rotateWorkerCredential(credential.credentialId)
      if (!result.token) throw new Error('服务端未返回一次性 Worker Token')
      setOneTimeSecret(result)
      onNotice('Worker 凭据已轮换，旧 Token 已失效')
      await loadData()
    } catch (caught) {
      handleError(caught, 'Worker 凭据轮换失败')
    } finally {
      setWorkingKey('')
    }
  }

  async function revokeCredential(credential: WorkerCredential) {
    if (!canWrite || !window.confirm(`撤销 ${credential.agentId} 的凭据并断开旧连接？`)) return
    setWorkingKey(`worker-revoke:${credential.credentialId}`)
    try {
      const next = await revokeWorkerCredential(credential.credentialId)
      setCredentials((current) => current.map((item) => item.credentialId === credential.credentialId ? next : item))
      onNotice('Worker 凭据已撤销')
    } catch (caught) {
      handleError(caught, 'Worker 凭据撤销失败')
    } finally {
      setWorkingKey('')
    }
  }

  return (
    <main className="admin-panel">
      <header className="admin-header">
        <div><span>仅管理员</span><h1>系统管理</h1><p>维护普通用户和独立 Worker 凭据。权限仍由服务端 RBAC 强制。</p></div>
        <button type="button" disabled={!canWrite || loading} onClick={() => void loadData()}>{loading ? '同步中…' : '刷新'}</button>
      </header>

      {connectionMode !== 'live' && <div className="admin-readonly">Hub 当前为非实时状态，系统管理已切换为只读。</div>}
      {error && <div className="admin-error">{error}</div>}

      <div className="admin-grid">
        <section className="admin-section">
          <div className="admin-section-title"><div><span>Identity</span><h2>Web 用户</h2></div><b>{users.length}</b></div>
          <form className="admin-create-form" onSubmit={submitUser}>
            <label>用户名<input autoComplete="off" maxLength={64} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="operator-01" /></label>
            <label>初始密码<input autoComplete="new-password" minLength={12} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 个字符" /></label>
            <button type="submit" disabled={!canWrite || workingKey === 'create-user' || !username.trim() || password.length < 12}>{workingKey === 'create-user' ? '创建中…' : '创建 Operator'}</button>
            <small>HTTP 只允许创建 operator；密码仅随本次 HTTPS 请求提交，不在浏览器持久化。</small>
          </form>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>用户</th><th>状态</th><th>会话</th><th>最近登录</th><th>操作</th></tr></thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td><strong>{user.username}</strong><small>{user.role} · {formatAdminDate(user.createdAt)}</small></td>
                    <td><span className={`admin-status ${user.status ?? 'active'}`}>{user.status === 'disabled' ? '已停用' : '正常'}</span></td>
                    <td>{user.activeSessionCount ?? 0}</td>
                    <td>{user.lastLoginAt ? formatAdminDate(user.lastLoginAt) : '尚无'}</td>
                    <td><div className="row-actions">
                      <button type="button" disabled={!canWrite || user.role !== 'operator' || Boolean(workingKey)} onClick={() => void changeUserStatus(user)}>{user.status === 'disabled' ? '启用' : '停用'}</button>
                      <button type="button" disabled={!canWrite || Boolean(workingKey)} onClick={() => void revokeSessions(user)}>撤销会话</button>
                    </div></td>
                  </tr>
                ))}
                {!loading && users.length === 0 && <tr><td colSpan={5} className="table-empty">还没有可管理用户</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-section">
          <div className="admin-section-title"><div><span>Worker access</span><h2>Worker 凭据</h2></div><b>{credentials.filter((item) => item.status === 'active').length} active</b></div>
          <form className="admin-create-form worker-form" onSubmit={submitWorker}>
            <label>Agent ID<input maxLength={128} value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="laptop-01-executor-01" /></label>
            <label>Device ID<input maxLength={128} value={deviceId} onChange={(event) => setDeviceId(event.target.value)} placeholder="留空则与 Agent ID 相同" /></label>
            <button type="submit" disabled={!canWrite || workingKey === 'create-worker' || !agentId.trim()}>{workingKey === 'create-worker' ? '签发中…' : '签发凭据'}</button>
            <small>每个 Agent ID 只能有一个 active 凭据；已有凭据请使用轮换。</small>
          </form>
          <div className="credential-list">
            {credentials.map((credential) => (
              <article className="credential-card" key={credential.credentialId}>
                <div><strong>{credential.agentId}</strong><span>{credential.deviceId}</span><small>创建 {formatAdminDate(credential.createdAt)} · 最后使用 {formatAdminDate(credential.lastUsedAt)}</small></div>
                <span className={`admin-status ${credential.status}`}>{credential.status === 'active' ? 'active' : 'revoked'}</span>
                <div className="row-actions">
                  <button type="button" disabled={!canWrite || credential.status !== 'active' || Boolean(workingKey)} onClick={() => void rotateCredential(credential)}>轮换</button>
                  <button className="danger" type="button" disabled={!canWrite || credential.status !== 'active' || Boolean(workingKey)} onClick={() => void revokeCredential(credential)}>撤销</button>
                </div>
              </article>
            ))}
            {!loading && credentials.length === 0 && <div className="table-empty">还没有 Worker 凭据</div>}
          </div>
        </section>
      </div>

      {oneTimeSecret && <OneTimeTokenDialog secret={oneTimeSecret} onClose={() => setOneTimeSecret(null)} onNotice={onNotice} />}
    </main>
  )
}

function OneTimeTokenDialog({ secret, onClose, onNotice }: { secret: OneTimeSecret; onClose: () => void; onNotice: (message: string) => void }) {
  const config = JSON.stringify({
    agentId: secret.credential.agentId,
    deviceId: secret.credential.deviceId,
    hubUrl: 'wss://YOUR_A446_HOST/worker',
    authTokenEnv: 'A446_WORKER_TOKEN',
    authRequired: true,
  }, null, 2)

  async function copy(value: string, label: string) {
    try {
      await copyText(value)
      onNotice(`${label}已复制`)
    } catch {
      onNotice('复制失败，请手动选择并复制')
    }
  }

  return (
    <div className="modal-backdrop token-backdrop" role="presentation">
      <section className="token-dialog" role="dialog" aria-modal="true" aria-labelledby="one-time-token-title">
        <span>仅显示一次</span>
        <h2 id="one-time-token-title">保存 Worker Token</h2>
        <p>关闭后无法再次取回明文。请只保存到对应 Worker 主机的安全环境变量，不要粘贴到仓库、聊天、URL 或日志。</p>
        <code>{secret.token}</code>
        <div className="token-actions">
          <button type="button" onClick={() => void copy(secret.token, 'Token')}>复制 Token</button>
          <button type="button" onClick={() => void copy(`$env:A446_WORKER_TOKEN = '${secret.token}'`, 'PowerShell 环境变量')}>复制环境变量</button>
          <button type="button" onClick={() => void copy(config, '最小配置')}>复制最小配置</button>
        </div>
        <button className="token-close" type="button" onClick={onClose}>我已安全保存，关闭</button>
      </section>
    </div>
  )
}

function validateIdentityId(value: string, label: string) {
  if (!value) return `${label} 不能为空`
  if (value.length > 128) return `${label} 不能超过 128 个字符`
  if ([...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })) return `${label} 不能包含控制字符`
  return ''
}

function formatAdminDate(value?: string | null) {
  if (!value) return '尚无'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '未知'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatApiError(error: unknown, fallback: string) {
  if (error instanceof HubApiError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : fallback
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const area = document.createElement('textarea')
  area.value = value
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('Clipboard copy failed')
}
