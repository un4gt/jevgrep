export interface AuthStatus {
  authenticated: boolean;
  requiresLogin: boolean;
  requiresModelSelection: boolean;
  issuer?: string;
  accountId?: string;
  username?: string;
  baseUrl?: string;
  model?: string;
  cacheNamespace?: string;
  expiresAt?: number;
}
export function status(): Promise<AuthStatus>;
export function login(): Promise<AuthStatus>;
export function startLogin(manual?: boolean): Promise<{ handle: string; authorizationUrl: string; expiresIn: number }>;
export function completeLogin(handle: string, browser: boolean): Promise<AuthStatus>;
export function completeManualLogin(handle: string, code: string): Promise<AuthStatus>;
export function cancelLogin(handle: string): void;
export function logout(): Promise<{ localCleared: boolean; remoteRevoked: boolean }>;
export interface EvaluationInput {
  stateJson: string;
  questions: { id: string; instructions: string }[];
}
export function beginEvaluation(namespace: string, input: EvaluationInput, timeoutMs?: number): string;
export function completeEvaluation(handle: string): Promise<{ status: number; body: string; retryAfter?: string }>;
export function cancelEvaluation(handle: string): void;
export function protocolTestBuild(): boolean;
export function configuredIssuer(): string;
export function availableModels(): Promise<{ id: string; kind: string }[]>;
export function selectModel(model: string): Promise<AuthStatus>;

export function beginOperation(namespace:string, operation:string, inputJson:string, timeoutMs?:number):string;
export function buildInfo(): { version:string; id:string; kind:"fixture"|"A"|"release"|"unregistered" };
