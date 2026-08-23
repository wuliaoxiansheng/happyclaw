import type { MessageSourceKind, StreamEvent } from './types.js';

/** Framed host/runner output shared without coupling the parser to a launcher. */
export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  proactiveFinalCandidate?: string;
  newSessionId?: string;
  error?: string;
  providerFailure?: boolean;
  providerRateLimitResetsAt?: number;
  providerFailureNotice?: string;
  providerRateLimitScope?: 'account' | 'model';
  providerRateLimitModel?: string;
  providerFailureTerminal?: boolean;
  providerFailureRetrying?: boolean;
  providerFailureMaintenance?: boolean;
  streamEvent?: StreamEvent;
  readonly inputTurnId?: string;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?: Exclude<MessageSourceKind, 'user_command'>;
  finalizationReason?: 'completed' | 'interrupted' | 'error' | 'truncated';
  pendingBgTasks?: number;
  inputTurnCompleted?: boolean;
  queryIdle?: boolean;
  ipcReceipts?: RuntimeIpcReceipt[];
  activeIpcReceipts?: RuntimeIpcReceipt[];
}

export interface RuntimeIpcReceipt {
  deliveryId: string;
  chatJid: string;
  coveredCursors?: RuntimeIpcCursor[];
  cursor: RuntimeIpcCursor;
}

export interface RuntimeIpcCursor {
  timestamp: string;
  id: string;
  sourceJid?: string;
}
