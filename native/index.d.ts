export interface AuthStatus {
  authenticated: boolean;
  requiresLogin: boolean;
  issuer?: string;
  accountId?: string;
  baseUrl?: string;
  model?: string;
  cacheNamespace?: string;
  expiresAt?: number;
}
export function status(): Promise<AuthStatus>;
export function login(): Promise<AuthStatus>;
export function startLogin(): Promise<{ handle: string; authorizationUrl: string }>;
export function completeLogin(handle: string, browser: boolean): Promise<AuthStatus>;
export function cancelLogin(handle: string): void;
export function logout(): Promise<{ localCleared: boolean; remoteRevoked: boolean }>;
export function authorizeRequest(method: string, url: string, namespace: string): Promise<{ authorization: string; dpop: string }>;
export function acceptNonce(url: string, nonce: string, namespace: string): Promise<void>;
