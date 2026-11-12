import { CONNECTION_ENV_PREFILL } from '@/lib/model-providers';

export interface DefaultProviderEnvRow {
  key: string;
  value: string;
}

/**
 * The rows a new third-party connection's environment starts with. Each can
 * be changed or deleted; the model keys are not among them, since the launch
 * derives those from the connection's models and roles.
 */
export function buildDefaultProviderEnv(): DefaultProviderEnvRow[] {
  return Object.entries(CONNECTION_ENV_PREFILL).map(([key, value]) => ({
    key,
    value,
  }));
}
