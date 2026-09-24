export interface LanTokenSelection {
  token: string
  source: 'query' | 'session' | 'none'
}

/** A newly supplied pairing token must replace a stale token from this browser session. */
export function selectLanAccessToken(search: string, storedToken?: string | null): LanTokenSelection {
  const params = new URLSearchParams(search)
  const queryToken = (params.get('lanToken') || params.get('token') || '').trim()
  if (queryToken) return { token: queryToken, source: 'query' }

  const sessionToken = storedToken?.trim() ?? ''
  if (sessionToken) return { token: sessionToken, source: 'session' }
  return { token: '', source: 'none' }
}
