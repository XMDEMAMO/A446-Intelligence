import type {
  Agent,
  Conversation,
  CreateWorkflowRequest,
  HubEvent,
  HubHealth,
  HubMessage,
  HubSnapshot,
  HubTask,
  TokenUsage,
  UsageAgentSummary,
} from './types'

const API_BASE = (import.meta.env.VITE_HUB_API_BASE ?? '/api').replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Hub request failed (${response.status})`)
  return body
}

export async function getHubSnapshot(): Promise<HubSnapshot> {
  const [health, agents, tasks, conversations, messages, usage, events] = await Promise.all([
    request<HubHealth>('/health'),
    request<{ agents: Agent[] }>('/v1/agents'),
    request<{ tasks: HubTask[] }>('/v1/tasks'),
    request<{ conversations: Conversation[] }>('/v1/conversations'),
    request<{ messages: HubMessage[] }>('/v1/messages'),
    request<{ totals: TokenUsage | null; byAgent: UsageAgentSummary[] }>('/v1/usage'),
    request<{ events: HubEvent[] }>('/v1/events?limit=120'),
  ])
  return {
    health,
    agents: agents.agents,
    tasks: tasks.tasks,
    conversations: conversations.conversations,
    messages: messages.messages,
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
