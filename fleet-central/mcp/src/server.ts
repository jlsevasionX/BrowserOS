import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { QueryClient } from './query-client'
import { TOOLS } from './tools'

const INSTRUCTIONS =
  'Read-only access to fleet telemetry. Call fleet_meta first to discover what is available, ' +
  'then use the insight tools (fleet_usage, fleet_agent_activity, fleet_health) and ' +
  'fleet_search_events / fleet_get_event to drill in. All times default to the last 24h.'

export function createMcpServer(client: QueryClient): McpServer {
  const server = new McpServer(
    { name: 'fleet_mcp', title: 'Fleet telemetry MCP server', version: '0.0.1' },
    { instructions: INSTRUCTIONS },
  )

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(client, args ?? {})
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          return { content: [{ type: 'text' as const, text }], isError: true }
        }
      },
    )
  }

  return server
}
