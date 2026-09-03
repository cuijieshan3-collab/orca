import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AI_VAULT_TRANSCRIPT_SEARCH_MAX_REQUESTS,
  aiVaultTranscriptSearchRequestKey,
  type AiVaultTranscriptSearchMatch,
  type AiVaultTranscriptSearchRequest
} from '../../../../shared/ai-vault-transcript-search'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { canUseLocalAiVaultSessionPathActions } from './ai-vault-session-path-actions'

export type AiVaultTranscriptMatchInfo = {
  matchCount: number
  snippet: string
  /** The search term that produced the snippet, so rows can highlight it. */
  query: string
}

export type AiVaultTranscriptDeepSearchPanel = {
  deepSearchStatus: 'idle' | 'running' | 'done'
  deepSearchQuery: string
  deepSearchTruncated: boolean
  deepSearchMatchCount: number
  /** Sessions that contain the term; empty keeps the normal filtered list. */
  matchedSessions: readonly AiVaultSession[]
  transcriptMatchById: ReadonlyMap<string, AiVaultTranscriptMatchInfo> | null
  onDeepSearch: () => void
  clearDeepSearch: () => void
}

type DeepSearchStatus = 'idle' | 'running' | 'done'

type DeepSearchState = {
  status: DeepSearchStatus
  /** Keyed by aiVaultTranscriptSearchRequestKey(agent, filePath). */
  matchByKey: ReadonlyMap<string, AiVaultTranscriptMatchInfo>
  query: string
  truncated: boolean
}

const IDLE_STATE: DeepSearchState = {
  status: 'idle',
  matchByKey: new Map(),
  query: '',
  truncated: false
}
const NO_MATCHES: readonly AiVaultSession[] = []

/** Runs the on-demand full-transcript search behind the vault's "deep search"
 *  affordance. Requests are narrowed to local sessions: transcript bodies only
 *  exist on the machine that ran the agent, and the desktop IPC handler reads
 *  local files only. Results are joined back to rows by (agent, filePath). */
export function useAiVaultTranscriptDeepSearch() {
  const [state, setState] = useState<DeepSearchState>(IDLE_STATE)
  // Guards against a stale response landing after a newer query or a clear.
  const runIdRef = useRef(0)

  const localSearchRequests = useCallback((sessions: readonly AiVaultSession[]) => {
    const requests: AiVaultTranscriptSearchRequest[] = []
    let candidates = 0
    for (const session of sessions) {
      if (!canUseLocalAiVaultSessionPathActions(session.executionHostId)) {
        continue
      }
      candidates += 1
      if (requests.length >= AI_VAULT_TRANSCRIPT_SEARCH_MAX_REQUESTS) {
        continue
      }
      requests.push({
        agent: session.agent,
        filePath: session.filePath,
        ...(session.sessionId ? { sessionId: session.sessionId } : {})
      })
    }
    return {
      requests,
      // Eligible local sessions past the cap were never asked for; the UI must
      // say "partial" instead of presenting a complete-looking result.
      truncated: candidates > requests.length
    }
  }, [])

  const runDeepSearch = useCallback(
    async (query: string, sessions: readonly AiVaultSession[]) => {
      const { requests, truncated: requestsTruncated } = localSearchRequests(sessions)
      const runId = runIdRef.current + 1
      runIdRef.current = runId
      setState({
        status: requests.length > 0 ? 'running' : 'done',
        matchByKey: new Map(),
        query,
        truncated: requestsTruncated
      })
      if (requests.length === 0) {
        return
      }
      let matches: AiVaultTranscriptSearchMatch[] = []
      let issues: { agent: string; path: string; message: string }[] = []
      let truncated = requestsTruncated
      try {
        const result = await window.api.aiVault.searchTranscripts({ query, requests })
        if (runIdRef.current !== runId) {
          return
        }
        matches = result.matches
        issues = result.issues
        truncated = truncated || result.truncated
      } catch {
        // Why: a failed deep search must not break the vault panel; the query
        // still filters metadata, and the idle state keeps the UI honest.
        if (runIdRef.current !== runId) {
          return
        }
        setState(IDLE_STATE)
        return
      }
      const matchByKey = new Map<string, AiVaultTranscriptMatchInfo>()
      for (const match of matches) {
        matchByKey.set(
          aiVaultTranscriptSearchRequestKey({
            agent: match.agent,
            filePath: match.filePath
          }),
          { matchCount: match.matchCount, snippet: match.snippet, query }
        )
      }
      setState({ status: 'done', matchByKey, query, truncated: truncated || issues.length > 0 })
    },
    [localSearchRequests]
  )

  const clearDeepSearch = useCallback(() => {
    runIdRef.current += 1
    setState(IDLE_STATE)
  }, [])

  const matchBySessionId = useMemo(() => {
    const byKey = state.matchByKey
    return (sessions: readonly AiVaultSession[]): Map<string, AiVaultTranscriptMatchInfo> => {
      const bySessionId = new Map<string, AiVaultTranscriptMatchInfo>()
      if (byKey.size === 0) {
        return bySessionId
      }
      for (const session of sessions) {
        const info = byKey.get(
          aiVaultTranscriptSearchRequestKey({
            agent: session.agent,
            filePath: session.filePath
          })
        )
        if (info) {
          bySessionId.set(session.id, info)
        }
      }
      return bySessionId
    }
  }, [state.matchByKey])

  return {
    deepSearchStatus: state.status,
    deepSearchQuery: state.query,
    deepSearchTruncated: state.truncated,
    deepSearchMatchCount: state.matchByKey.size,
    runDeepSearch,
    clearDeepSearch,
    matchBySessionId
  }
}

/** Panel-level glue: wires the deep-search hook to the vault's metadata query.
 *  Lives here so AiVaultPanel stays a one-frame component. While a search is
 *  active the panel shows ONLY the matched sessions (a results view), so the
 *  group memo must key off the derived list and a query keystroke must not
 *  rebuild the virtualized groups every render. */
export function useAiVaultTranscriptDeepSearchPanel(params: {
  query: string
  sessions: readonly AiVaultSession[]
}): AiVaultTranscriptDeepSearchPanel {
  const { query, sessions } = params
  const {
    deepSearchStatus,
    deepSearchQuery,
    deepSearchTruncated,
    deepSearchMatchCount,
    runDeepSearch,
    clearDeepSearch,
    matchBySessionId
  } = useAiVaultTranscriptDeepSearch()
  const onDeepSearch = useCallback(
    () => void runDeepSearch(query, sessions),
    [query, runDeepSearch, sessions]
  )
  // Why: query equality alone cannot prove the current input was searched.
  // Clearing the field and retyping the same term would otherwise resurrect the
  // old results and hide the search button. Once the input moves off the
  // searched text, drop the results entirely (the in-flight run's response is
  // ignored via the run-id bump inside clearDeepSearch).
  useEffect(() => {
    if (deepSearchQuery !== query) {
      clearDeepSearch()
    }
  }, [clearDeepSearch, deepSearchQuery, query])
  // Deep search hits surface even when the metadata filter misses them — that
  // is the point. A stale result from a superseded query must not show.
  const transcriptMatchById = useMemo(
    () =>
      deepSearchStatus === 'done' && deepSearchQuery === query ? matchBySessionId(sessions) : null,
    [deepSearchQuery, deepSearchStatus, matchBySessionId, query, sessions]
  )
  const matchedSessions = useMemo(
    () =>
      transcriptMatchById && transcriptMatchById.size > 0
        ? sessions.filter((session) => transcriptMatchById.has(session.id))
        : NO_MATCHES,
    [sessions, transcriptMatchById]
  )
  return {
    deepSearchStatus,
    deepSearchQuery,
    deepSearchTruncated,
    deepSearchMatchCount,
    matchedSessions,
    transcriptMatchById,
    onDeepSearch,
    clearDeepSearch
  }
}
