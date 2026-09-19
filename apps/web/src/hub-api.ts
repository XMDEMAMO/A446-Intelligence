import type {
  Agent,
  Conversation,
  ConversationDetail,
  CreateWorkflowRequest,
  HubHealth,
  HubMessage,
  HubOverview,
  HubTask,
  HumanIntervention,
  TokenUsage,
  UsageAgentSummary,
  WebUser,
  WebUserStatus,
  WorkerCredential,
} from './types'

const API_BASE = (import.meta.env.VITE_HUB_API_BASE ?? '/api').replace(/\/$/, '')
const DEFAULT_TIMEOUT_MS = 8_000
let csrfToken = readCookie('a446_csrf') || window.sessionStorage.getItem('a446.csrf') || ''

interface ErrorBody {
  error?: string
  code?: string
  details?: Record<string, unknown>
  retryAfterMs?: number
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number
}

export class HubApiError extends Error {
  status: number
  code: string
  details: Record<string, unknown> | null
  retryAfterMs: number | null

  constructor(message: string, status: number, code = 'REQUEST_FAILED', details: Record<string, unknown> | null = null, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'HubApiError'
    this.status = status
    this.code = code
    this.details = details
    this.retryAfterMs = retryAfterMs
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal, ...init } = options
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort()
  externalSignal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const method = init.method ?? 'GET'
  if (!['GET', 'HEAD'].includes(method) && csrfToken && !headers.has('x-csrf-token')) headers.set('x-csrf-token', csrfToken)

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      method,
      credentials: 'include',
      headers,
      signal: controller.signal,
    })
    const text = await response.text()
    let body: (T & ErrorBody) | ErrorBody = {}
    if (text) {
      try {
        body = JSON.parse(text) as T & ErrorBody
      } catch {
        body = { error: `Hub returned an invalid response (${response.status})`, code: 'INVALID_RESPONSE' }
      }
    }
    if (!response.ok) {
      const retryHeader = Number(response.headers.get('retry-after'))
      const retryAfterMs = Number.isFinite(body.retryAfterMs)
        ? Number(body.retryAfterMs)
        : Number.isFinite(retryHeader) && retryHeader > 0
          ? retryHeader * 1_000
          : null
      throw new HubApiError(
        body.error ?? `Hub request failed (${response.status})`,
        response.status,
        body.code ?? `HTTP_${response.status}`,
        body.details ?? null,
        retryAfterMs,
      )
    }
    return body as T
  } catch (error) {
    if (error instanceof HubApiError) throw error
    if (timedOut) throw new HubApiError('请求超时，请检查 Hub 连接。', 0, 'REQUEST_TIMEOUT')
    throw error
  } finally {
    window.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function login(username: string, password: string, signal?: AbortSignal) {
  const result = await request<{ user: WebUser; csrfToken: string; expiresAt?: string }>('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    signal,
  })
  csrfToken = result.csrfToken
  window.sessionStorage.setItem('a446.csrf', csrfToken)
  return normalizeUser(result.user)
}

export async function getCurrentUser(signal?: AbortSignal) {
  const result = await request<{ user: WebUser }>('/v1/auth/me', { signal })
  return normalizeUser(result.user)
}

export async function logout(signal?: AbortSignal) {
  await request<{ ok: boolean }>('/v1/auth/logout', { method: 'POST', signal })
  clearLocalSession()
}

export function clearLocalSession() {
  csrfToken = ''
  window.sessionStorage.removeItem('a446.csrf')
}

export function artifactDownloadUrl(downloadUrl: string) {
  return `${API_BASE}${downloadUrl}`
}

export async function getHubOverview(signal?: AbortSignal): Promise<HubOverview> {
  return grouped(signal, async (groupSignal) => {
    const [health, agents, conversations, usage] = await Promise.all([
      request<HubHealth>('/health', { signal: groupSignal }),
      request<{ agents: Agent[] }>('/v1/agents', { signal: groupSignal }),
      request<{ conversations: Conversation[] }>('/v1/conversations', { signal: groupSignal }),
      request<{ totals: TokenUsage | null; byAgent: UsageAgentSummary[] }>('/v1/usage', { signal: groupSignal }),
    ])
    return {
      health,
      agents: agents.agents,
      conversations: conversations.conversations,
      usage,
    }
  })
}

export async function getConversationDetail(rootTaskId: string, signal?: AbortSignal): Promise<ConversationDetail> {
  const root = encodeURIComponent(rootTaskId)
  return grouped(signal, async (groupSignal) => {
    const [tasks, messages, interventions] = await Promise.all([
      request<{ tasks: HubTask[] }>(`/v1/tasks?rootTaskId=${root}&view=summary`, { signal: groupSignal }),
      request<{ messages: HubMessage[] }>(`/v1/messages?rootTaskId=${root}&view=summary`, { signal: groupSignal }),
      request<{ interventions: HumanIntervention[] }>(`/v1/interventions?status=pending&rootTaskId=${root}`, { signal: groupSignal }),
    ])
    return {
      rootTaskId,
      tasks: tasks.tasks.filter((task) => (task.rootTaskId ?? task.taskId) === rootTaskId),
      messages: messages.messages.filter((message) => message.rootTaskId === rootTaskId),
      interventions: interventions.interventions.filter((item) => item.rootTaskId === rootTaskId && ['pending', 'required'].includes(item.status)),
    }
  })
}

export async function getMessageDetail(messageId: string, signal?: AbortSignal) {
  const result = await request<{ message: HubMessage }>(`/v1/messages/${encodeURIComponent(messageId)}`, { signal })
  return result.message
}

export async function getTaskDetail(taskId: string, signal?: AbortSignal) {
  const result = await request<{ task: HubTask }>(`/v1/tasks/${encodeURIComponent(taskId)}`, { signal })
  return result.task
}

export function createWorkflow(input: CreateWorkflowRequest, signal?: AbortSignal) {
  return request<{ task: HubTask }>('/v1/workflows', { method: 'POST', body: JSON.stringify(input), signal })
}

export function sendConversationMessage(rootTaskId: string, text: string, mentions: string[] = [], signal?: AbortSignal) {
  return request<{ message: HubMessage }>('/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ rootTaskId, text, mentions }),
    signal,
  })
}

export function sendHubCommand(command: Record<string, unknown>, signal?: AbortSignal) {
  return request<{ ok: boolean; task?: HubTask; agent?: Agent }>('/v1/commands', {
    method: 'POST',
    body: JSON.stringify(command),
    signal,
  })
}

export function resolveIntervention(interventionId: string, decision: 'approve' | 'reject' | 'respond', response = '', signal?: AbortSignal) {
  return request<{ ok: boolean; intervention: HumanIntervention; task?: HubTask }>(`/v1/interventions/${encodeURIComponent(interventionId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ decision, response }),
    signal,
  })
}

export async function listAdminUsers(signal?: AbortSignal) {
  const result = await request<{ users: WebUser[] }>('/v1/admin/users', { signal })
  return result.users.map(normalizeUser)
}

export async function createOperator(username: string, password: string, signal?: AbortSignal) {
  const result = await request<{ user: WebUser }>('/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username, password, role: 'operator' }),
    signal,
  })
  return normalizeUser(result.user)
}

export async function setUserStatus(userId: string, status: WebUserStatus, signal?: AbortSignal) {
  const result = await request<{ user: WebUser }>(`/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
    signal,
  })
  return normalizeUser(result.user)
}

export function revokeUserSessions(userId: string, signal?: AbortSignal) {
  return request<{ ok: boolean; revokedSessions: number }>(`/v1/admin/users/${encodeURIComponent(userId)}/revoke-sessions`, {
    method: 'POST',
    body: JSON.stringify({}),
    signal,
  })
}

export async function listWorkerCredentials(signal?: AbortSignal) {
  const result = await request<{ credentials?: WorkerCredential[]; workers?: WorkerCredential[] }>('/v1/admin/workers', { signal })
  return result.credentials ?? result.workers ?? []
}

export async function createWorkerCredential(agentId: string, deviceId: string, signal?: AbortSignal) {
  const result = await request<{ credential: WorkerCredential & { token?: string }; token?: string }>('/v1/admin/workers', {
    method: 'POST',
    body: JSON.stringify({ agentId, deviceId }),
    signal,
  })
  return splitCredentialToken(result)
}

export async function rotateWorkerCredential(credentialId: string, signal?: AbortSignal) {
  const result = await request<{ credential: WorkerCredential & { token?: string }; token?: string }>(`/v1/admin/workers/${encodeURIComponent(credentialId)}/rotate`, {
    method: 'POST',
    body: JSON.stringify({}),
    signal,
  })
  return splitCredentialToken(result)
}

export async function revokeWorkerCredential(credentialId: string, signal?: AbortSignal) {
  const result = await request<{ credential: WorkerCredential }>(`/v1/admin/workers/${encodeURIComponent(credentialId)}`, {
    method: 'DELETE',
    signal,
  })
  return result.credential
}

function normalizeUser(user: WebUser & { userId?: string }): WebUser {
  return {
    ...user,
    id: user.id ?? user.userId ?? `user:${user.username}`,
  }
}

function splitCredentialToken(result: { credential: WorkerCredential & { token?: string }; token?: string }) {
  const { token: nestedToken, ...credential } = result.credential
  return { credential, token: result.token ?? nestedToken ?? '' }
}

function readCookie(name: string) {
  const prefix = `${name}=`
  return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? ''
}

async function grouped<T>(externalSignal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  externalSignal?.addEventListener('abort', abortFromCaller, { once: true })
  try {
    return await operation(controller.signal)
  } catch (error) {
    controller.abort()
    throw error
  } finally {
    externalSignal?.removeEventListener('abort', abortFromCaller)
  }
}
