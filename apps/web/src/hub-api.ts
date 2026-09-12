import type {
  CreateTaskRequest,
  HubEvent,
  HubHealth,
  HubSnapshot,
  HubTask,
  Agent,
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
  if (!response.ok) {
    throw new Error(body.error ?? `Hub request failed (${response.status})`)
  }
  return body
}

export async function getHubSnapshot(): Promise<HubSnapshot> {
  const [health, agents, tasks, events] = await Promise.all([
    request<HubHealth>('/health'),
    request<{ agents: Agent[] }>('/v1/agents'),
    request<{ tasks: HubTask[] }>('/v1/tasks'),
    request<{ events: HubEvent[] }>('/v1/events?limit=120'),
  ])

  return {
    health,
    agents: agents.agents,
    tasks: tasks.tasks,
    events: events.events,
  }
}

export function createHubTask(input: CreateTaskRequest) {
  return request<{ task: HubTask }>('/v1/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function sendHubCommand(command: Record<string, unknown>) {
  return request<{ ok: boolean; task?: HubTask; agent?: Agent }>('/v1/commands', {
    method: 'POST',
    body: JSON.stringify(command),
  })
}
\n