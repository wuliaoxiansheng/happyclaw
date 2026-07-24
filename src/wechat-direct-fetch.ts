import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';

const directDispatcher = new Agent();

type FetchInitWithDispatcher = RequestInit & {
  dispatcher?: Dispatcher;
};

/**
 * WeChat iLink/CDN endpoints must be reached directly. The host process may run
 * with NODE_USE_ENV_PROXY=1, so relying on NO_PROXY being read at runtime is not
 * sufficient; an explicit dispatcher bypasses the global proxy dispatcher.
 */
export function fetchWeChatDirect(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return undiciFetch(input as string | URL, {
    ...init,
    dispatcher: directDispatcher,
  } as UndiciRequestInit & FetchInitWithDispatcher) as unknown as Promise<Response>;
}
