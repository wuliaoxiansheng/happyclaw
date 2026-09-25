import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

const directDispatcher = new Agent();

/**
 * Default to direct transport rather than the process-wide proxy, but honor
 * an account-local dispatcher. Overriding it here silently disables the
 * account's proxy setting and bypasses its connection lifecycle.
 */
export function fetchWeChatDirect(
  input: string | URL | Request,
  init?: UndiciRequestInit,
): Promise<Response> {
  return undiciFetch(input as string | URL, {
    ...init,
    dispatcher: init?.dispatcher ?? directDispatcher,
  }) as unknown as Promise<Response>;
}
