/** Deterministic role/perspective → provider/model routing (FEAT-015). */
import { AgentProvider, type AgentProvider as AgentProviderType } from '../domain/schema.js';
import type { AgentRouteConfig, HarnessConfig } from '../config.js';

export type RoutableRole = 'generator' | 'reviewer' | 'planning' | 'ui-design';

export interface AgentRoute {
  provider: AgentProviderType;
  model: string | null;
}

export class AgentRouteResolutionError extends Error {
  constructor(readonly role: RoutableRole, readonly perspective: string | null, detail: string) {
    super(`Invalid agent route for ${role}${perspective ? `/${perspective}` : ''}: ${detail}`);
    this.name = 'AgentRouteResolutionError';
  }
}

function parseRoute(raw: unknown, role: RoutableRole, perspective: string | null): AgentRoute {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentRouteResolutionError(role, perspective, 'route must be an object');
  }
  const candidate = raw as Partial<AgentRouteConfig> & { model?: unknown };
  const provider = AgentProvider.safeParse(candidate.provider);
  if (!provider.success) {
    throw new AgentRouteResolutionError(role, perspective, `unknown or missing provider: ${String(candidate.provider)}`);
  }
  if (candidate.model !== undefined && typeof candidate.model !== 'string') {
    throw new AgentRouteResolutionError(role, perspective, 'model must be a string when present');
  }
  return { provider: provider.data, model: candidate.model ?? null };
}

function hasOwn(record: object | undefined, key: string): boolean {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key);
}

/** Resolve exactly one route; precedence is domain-owned and independent of execution order. */
export function resolveAgentRoute(
  config: HarnessConfig,
  role: RoutableRole,
  perspective: string | null = null,
): AgentRoute {
  if (role === 'reviewer') {
    const perspectiveRoutes = config.routes?.perspectives;
    if (perspective && hasOwn(perspectiveRoutes, perspective)) {
      return parseRoute(perspectiveRoutes![perspective], role, perspective);
    }
    if (config.routes?.reviewer !== undefined) return parseRoute(config.routes.reviewer, role, perspective);
    return parseRoute({ provider: 'claude', model: config.models?.reviewer }, role, perspective);
  }
  if (role === 'planning' && config.routes?.planning !== undefined) {
    return parseRoute(config.routes.planning, role, null);
  }
  if (role === 'ui-design') {
    if (config.routes?.uiDesign !== undefined) return parseRoute(config.routes.uiDesign, role, null);
    if (config.routes?.planning !== undefined) return parseRoute(config.routes.planning, role, null);
  }
  if (role === 'generator' && config.routes?.generator !== undefined) {
    return parseRoute(config.routes.generator, role, null);
  }
  return parseRoute({ provider: config.generator, model: config.models?.generator }, role, null);
}

/** One source for ownership guard, assignment, PR attribution and live generator execution. */
export function resolvedGeneratorProvider(config: HarnessConfig): AgentProviderType {
  return resolveAgentRoute(config, 'generator').provider;
}
