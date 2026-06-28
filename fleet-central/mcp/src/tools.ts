import { type ZodRawShape, z } from 'zod'
import type { QueryClient, QueryResult } from './query-client'

export interface ToolDef {
  name: string
  description: string
  inputSchema: ZodRawShape
  handler: (client: QueryClient, args: Record<string, unknown>) => Promise<QueryResult>
}

// Common filters shared by every tool except fleet_get_event. Mirrors the #2a
// contract: ISO or epoch-ms times (default last 24h), exact-match facets, paging.
const common: ZodRawShape = {
  from: z.string().optional().describe('Start time (ISO-8601 or epoch-ms). Default: 24h ago.'),
  to: z.string().optional().describe('End time (ISO-8601 or epoch-ms). Default: now.'),
  device_id: z.string().optional(),
  session_id: z.string().optional(),
  install_id: z.string().optional(),
  channel: z.string().optional(),
  os: z.string().optional(),
  limit: z.number().int().optional().describe('Max rows (<=1000).'),
  offset: z.number().int().optional(),
}

export const TOOLS: ToolDef[] = [
  {
    name: 'fleet_meta',
    description:
      'Start here. Returns the available event types (+counts), device ids, channels, oses, and the captured time range. Use it to discover what to query before calling the other tools.',
    inputSchema: {},
    handler: (c) => c.meta(),
  },
  {
    name: 'fleet_usage',
    description:
      'Fleet usage: the most-visited hosts and a navigation time series. Use to answer "what is used most" / "how much browsing over time".',
    inputSchema: {
      ...common,
      top: z.number().int().optional().describe('How many top hosts to return.'),
      bucket: z.enum(['hour', 'day']).optional().describe('Time-series bucket. Default: hour.'),
    },
    handler: (c, a) => c.usage(a),
  },
  {
    name: 'fleet_agent_activity',
    description:
      'Agent tool activity: per-tool execution counts, error rate, p50/p95 latency, plus MCP scope request counts. Use to answer "which agent tool fails most / is slowest".',
    inputSchema: { ...common },
    handler: (c, a) => c.agentActivity(a),
  },
  {
    name: 'fleet_health',
    description:
      'Network health: HTTP status families (2xx..5xx/failed), top failing hosts, slowest requests, and total error count. Use to answer "what is failing / slow".',
    inputSchema: { ...common },
    handler: (c, a) => c.health(a),
  },
  {
    name: 'fleet_search_events',
    description:
      'Raw event search across the captured telemetry. Filter by type/host and a free-text query; supports paging. Use to drill into specific events.',
    inputSchema: {
      ...common,
      type: z.string().optional().describe('Event type, e.g. network.request, navigation, agent.action.'),
      host: z.string().optional(),
      q: z.string().optional().describe('Free-text match (e.g. a URL fragment).'),
    },
    handler: (c, a) => c.searchEvents(a),
  },
  {
    name: 'fleet_get_event',
    description: 'Fetch the full detail of a single event by its event_id (from fleet_search_events).',
    inputSchema: { id: z.string().describe('The event_id to fetch.') },
    handler: (c, a) => c.getEvent(String(a.id)),
  },
]
