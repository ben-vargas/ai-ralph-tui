/**
 * ABOUTME: WebSocket client for connecting to remote ralph-tui instances.
 * Manages connection lifecycle, authentication, and reconnection on tab selection.
 * Connection strategy: reconnect on tab selection only, no auto-reconnect on startup.
 */

import type { AuthMessage, AuthResponseMessage, PingMessage, WSMessage } from './types.js';

/**
 * Connection status for a remote instance.
 * Forms a state machine: disconnected -> connecting -> connected -> disconnected (on error)
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

/**
 * Represents a tab for an instance (local or remote)
 */
export interface InstanceTab {
  /** Unique identifier for the tab */
  id: string;

  /** Display label (alias for remotes, "Local" for local) */
  label: string;

  /** Whether this is the local instance */
  isLocal: boolean;

  /** Connection status (always 'connected' for local) */
  status: ConnectionStatus;

  /** Remote alias (undefined for local) */
  alias?: string;

  /** Host for remote connections */
  host?: string;

  /** Port for remote connections */
  port?: number;

  /** Last error message (if status is disconnected due to error) */
  lastError?: string;
}

/**
 * Events emitted by RemoteClient
 */
export type RemoteClientEvent =
  | { type: 'connecting' }
  | { type: 'connected' }
  | { type: 'disconnected'; error?: string }
  | { type: 'message'; message: WSMessage };

/**
 * Callback for remote client events
 */
export type RemoteClientEventHandler = (event: RemoteClientEvent) => void;

/**
 * WebSocket client for connecting to a remote ralph-tui instance.
 * Handles authentication and message passing.
 */
export class RemoteClient {
  private ws: WebSocket | null = null;
  private host: string;
  private port: number;
  private token: string;
  private eventHandler: RemoteClientEventHandler;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private _status: ConnectionStatus = 'disconnected';

  constructor(
    host: string,
    port: number,
    token: string,
    eventHandler: RemoteClientEventHandler
  ) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.eventHandler = eventHandler;
  }

  /**
   * Current connection status
   */
  get status(): ConnectionStatus {
    return this._status;
  }

  /**
   * Connect to the remote instance.
   * Authenticates immediately after connection.
   */
  async connect(): Promise<void> {
    if (this._status === 'connecting' || this._status === 'connected') {
      return;
    }

    this._status = 'connecting';
    this.eventHandler({ type: 'connecting' });

    return new Promise<void>((resolve, reject) => {
      try {
        const url = `ws://${this.host}:${this.port}`;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          this.authenticate();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data as string) as WSMessage;
            this.handleMessage(message, resolve, reject);
          } catch {
            // Ignore invalid messages
          }
        };

        this.ws.onerror = () => {
          this._status = 'disconnected';
          this.eventHandler({ type: 'disconnected', error: 'Connection error' });
          reject(new Error('Connection error'));
        };

        this.ws.onclose = () => {
          this.cleanup();
          if (this._status === 'connected') {
            this._status = 'disconnected';
            this.eventHandler({ type: 'disconnected', error: 'Connection closed' });
          }
        };
      } catch (error) {
        this._status = 'disconnected';
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.eventHandler({ type: 'disconnected', error: errorMessage });
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the remote instance.
   */
  disconnect(): void {
    this.cleanup();
    this._status = 'disconnected';
    this.eventHandler({ type: 'disconnected' });
  }

  /**
   * Send a message to the remote instance.
   */
  send(message: WSMessage): void {
    if (this.ws && this._status === 'connected') {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send authentication message
   */
  private authenticate(): void {
    const authMessage: AuthMessage = {
      type: 'auth',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      token: this.token,
    };
    this.ws?.send(JSON.stringify(authMessage));
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(
    message: WSMessage,
    resolveConnect: () => void,
    rejectConnect: (error: Error) => void
  ): void {
    switch (message.type) {
      case 'auth_response': {
        const authResponse = message as AuthResponseMessage;
        if (authResponse.success) {
          this._status = 'connected';
          this.eventHandler({ type: 'connected' });
          this.startPingInterval();
          resolveConnect();
        } else {
          this._status = 'disconnected';
          const error = authResponse.error ?? 'Authentication failed';
          this.eventHandler({ type: 'disconnected', error });
          this.cleanup();
          rejectConnect(new Error(error));
        }
        break;
      }

      case 'pong': {
        // Heartbeat acknowledged
        break;
      }

      default: {
        this.eventHandler({ type: 'message', message });
      }
    }
  }

  /**
   * Start sending periodic ping messages
   */
  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this._status === 'connected' && this.ws) {
        const pingMessage: PingMessage = {
          type: 'ping',
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        };
        this.ws.send(JSON.stringify(pingMessage));
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Stop the ping interval
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    this.stopPingInterval();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }
}

/**
 * Create the local instance tab
 */
export function createLocalTab(): InstanceTab {
  return {
    id: 'local',
    label: 'Local',
    isLocal: true,
    status: 'connected',
  };
}

/**
 * Create a remote instance tab from configuration
 */
export function createRemoteTab(
  alias: string,
  host: string,
  port: number
): InstanceTab {
  return {
    id: `remote-${alias}`,
    label: alias,
    isLocal: false,
    status: 'disconnected',
    alias,
    host,
    port,
  };
}
