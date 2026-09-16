import type {
  Agent,
  Conversation,
  CreateWorkflowRequest,
  HubEvent,
  HubHealth,
  HubMessage,
  HubSnapshot,
  HubTask,
  HumanIntervention,
  TokenUsage,
  UsageAgentSummary,
} from './types'

const API_BASE = (import.meta.env.VITE_HUB_API_BASE ?? '/api').replace(/\/$/, '')
let csrfToken = readCookie('a446_csrf') || window.sessionStorage.getItem('a446.csrf') || ''

export class HubApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(!['GET', 'HEAD'].includes(init?.method ?? 'GET') && csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...init?.headers,
    },
  })
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new HubApiError(body.error ?? `Hub request failed (${response.status})`, response.status)
  return body
}

export async function login(username: string, password: string) {
  const result = await request<{ user: { id: string; username: string; role: 'admin' | 'operator' }; csrfToken: string }>('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  csrfToken = result.csrfToken
  window.sessionStorage.setItem('a446.csrf', csrfToken)
  return result.user
}

export async function logout() {
  await request<{ ok: boolean }>('/v1/auth/logout', { method: 'POST' })
  csrfToken = ''
  window.sessionStorage.removeItem('a446.csrf')
}

export function artifactDownloadUrl(downloadUrl: string) {
  return `${API_BASE}${downloadUrl}`
}

function readCookie(name: string) {
  const prefix = `${name}=`
  return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? ''
}

export async function getHubSnapshot(): Promise<HubSnapshot> {
  const [health, agents, tasks, conversations, messages, interventions, usage, events] = await Promise.all([
    request<HubHealth>('/health'),
    request<{ agents: Agent[] }>('/v1/agents'),
    request<{ tasks: HubTask[] }>('/v1/tasks'),
    request<{ conversations: Conversation[] }>('/v1/conversations'),
    request<{ messages: HubMessage[] }>('/v1/messages'),
    request<{ interventions: HumanIntervention[] }>('/v1/interventions?status=pending'),
    request<{ totals: TokenUsage | null; byAgent: UsageAgentSummary[] }>('/v1/usage'),
    request<{ events: HubEvent[] }>('/v1/events?limit=120'),
  ])
  return {
    health,
    agents: agents.agents,
    tasks: tasks.tasks,
    conversations: conversations.conversations,
    messages: messages.messages,
    interventions: interventions.interventions,
    usage,
    events: events.events,
  }
}

export function createWorkflow(input: CreateWorkflowRequest) {
  return request<{ task: HubTask }>('/v1/workflows', { method: 'POST', body: JSON.stringify(input) })
}

export function sendConversationMessage(rootTaskId: string, text: string, mentions: string[] = []) {
  return request<{ message: HubMessage }>('/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ rootTaskId, text, mentions }),
  })
}

export function sendHubCommand(command: Record<string, unknown>) {
  return request<{ ok: boolean; task?: HubTask; agent?: Agent }>('/v1/commands', {
    method: 'POST',
    body: JSON.stringify(command),
  })
}

export function resolveIntervention(interventionId: string, decision: 'approve' | 'reject' | 'respond', response = '') {
  return request<{ ok: boolean; intervention: HumanIntervention; task?: HubTask }>(`/v1/interventions/${encodeURIComponent(interventionId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ decision, response }),
  })
}
