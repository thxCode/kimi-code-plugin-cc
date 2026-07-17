/**
 * Hand-written TypeScript declarations for the ACP (Agent Client Protocol)
 * surface spoken by `kimi acp` — JSON-RPC 2.0, one message per NDJSON line
 * over stdio — as probed against Kimi Code CLI v0.26.0. Replaces the codex
 * plugin's generated app-server types.
 */

/* JSON-RPC 2.0 base message shapes */

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Client -> server request, or server -> client request (both carry id + method). */
export interface JsonRpcRequestMessage {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
}

export interface JsonRpcNotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

export interface JsonRpcSuccessResponseMessage {
  jsonrpc: "2.0";
  id: number | string;
  result?: any;
}

export interface JsonRpcErrorResponseMessage {
  jsonrpc: "2.0";
  id: number | string | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponseMessage = JsonRpcSuccessResponseMessage | JsonRpcErrorResponseMessage;
export type JsonRpcMessage = JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage;

/* initialize */

export interface ClientInfo {
  title?: string | null;
  name: string;
  version: string;
}

export interface FileSystemClientCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
}

export interface ClientCapabilities {
  fs: FileSystemClientCapabilities;
  terminal: boolean;
}

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
  clientInfo?: ClientInfo;
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
}

export interface SessionCapabilities {
  list?: Record<string, unknown>;
  resume?: Record<string, unknown>;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
  sessionCapabilities?: SessionCapabilities;
}

export interface AuthMethod {
  id: string;
  type: string;
  name: string;
  description?: string | null;
  [key: string]: unknown;
}

export interface AgentInfo {
  name: string;
  version: string;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  authMethods: AuthMethod[];
  agentInfo?: AgentInfo;
  /** Present when the peer is the shared broker rather than `kimi acp` itself. */
  userAgent?: string;
}

/* session configuration (session/new, session/load, session/set_config_option) */

export interface ConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

/** `type: "select"` with `id` of "model" | "thinking" | "mode" observed from kimi acp. */
export interface ConfigOption {
  type: string;
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options?: ConfigSelectOption[];
}

export interface SessionNewParams {
  cwd: string;
  mcpServers: unknown[];
}

export interface SessionNewResult {
  sessionId: string;
  configOptions?: ConfigOption[];
}

export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: unknown[];
}

export interface SessionLoadResult {
  configOptions?: ConfigOption[];
}

export interface SessionSetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string;
}

export interface SessionSetConfigOptionResult {
  configOptions?: ConfigOption[];
}

/* session/prompt + session/cancel */

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface GenericContentBlock {
  type: string;
  [key: string]: unknown;
}

export type ContentBlock = TextContentBlock | GenericContentBlock;

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

/** "end_turn" and "cancelled" observed from kimi acp; remaining values follow the ACP spec. */
export type StopReason = "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal" | (string & {});

/** The session/prompt response resolves the whole turn; streaming arrives via session/update. */
export interface SessionPromptResult {
  stopReason: StopReason;
}

/** session/cancel is a notification (no id); the in-flight prompt resolves with "cancelled". */
export interface SessionCancelParams {
  sessionId: string;
}

/* session/update notification variants */

export type ToolCallKind =
  | "execute"
  | "edit"
  | "read"
  | "search"
  | "fetch"
  | "delete"
  | "move"
  | "think"
  | "other"
  | (string & {});

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | (string & {});

/** content is a delta; accumulate text across chunks. */
export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
}

/** content is a delta; accumulate text across chunks. */
export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
}

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title?: string;
  kind?: ToolCallKind;
  status?: ToolCallStatus;
  content?: unknown[];
  locations?: unknown[];
  rawInput?: unknown;
}

export interface ToolCallProgressUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  title?: string | null;
  kind?: ToolCallKind | null;
  status?: ToolCallStatus | null;
  content?: unknown[] | null;
  locations?: unknown[] | null;
  rawOutput?: unknown;
}

export interface PlanEntry {
  content?: string;
  priority?: string;
  status?: string;
  [key: string]: unknown;
}

export interface PlanUpdate {
  sessionUpdate: "plan";
  entries?: PlanEntry[];
}

export interface AvailableCommand {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands?: AvailableCommand[];
}

export interface ConfigOptionUpdate {
  sessionUpdate: "config_option_update";
  configOptions?: ConfigOption[];
}

/** Catch-all for session/update variants not enumerated above. */
export interface GenericSessionUpdate {
  sessionUpdate: string;
  [key: string]: any;
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallProgressUpdate
  | PlanUpdate
  | AvailableCommandsUpdate
  | ConfigOptionUpdate
  | GenericSessionUpdate;

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

export interface SessionUpdateNotification {
  jsonrpc?: "2.0";
  method: "session/update";
  params: SessionUpdateParams;
}

export interface GenericAcpNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: any;
}

export type AcpNotification = SessionUpdateNotification | GenericAcpNotification;
export type AcpNotificationHandler = (message: AcpNotification) => void;

/* session/request_permission (server -> client request) */

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always" | (string & {});

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: PermissionOptionKind;
}

export interface RequestPermissionToolCall {
  toolCallId?: string;
  title?: string;
  kind?: ToolCallKind;
  status?: ToolCallStatus;
  [key: string]: unknown;
}

export interface SessionRequestPermissionParams {
  sessionId: string;
  toolCall: RequestPermissionToolCall;
  options: PermissionOption[];
}

export interface RequestPermissionSelectedOutcome {
  outcome: "selected";
  optionId: string;
}

export interface RequestPermissionCancelledOutcome {
  outcome: "cancelled";
}

export type RequestPermissionOutcome = RequestPermissionSelectedOutcome | RequestPermissionCancelledOutcome;

export interface SessionRequestPermissionResult {
  outcome: RequestPermissionOutcome;
}

export interface SessionRequestPermissionRequest {
  jsonrpc?: "2.0";
  id: number | string;
  method: "session/request_permission";
  params: SessionRequestPermissionParams;
}

/** Any other server -> client request should be answered with error -32601. */
export type AcpServerRequest = SessionRequestPermissionRequest | JsonRpcRequestMessage;
export type AcpServerRequestHandler = (message: AcpServerRequest) => void;

/* client method map + options */

export interface AcpMethodMap {
  initialize: { params: InitializeParams; result: InitializeResult };
  "session/new": { params: SessionNewParams; result: SessionNewResult };
  "session/load": { params: SessionLoadParams; result: SessionLoadResult };
  "session/prompt": { params: SessionPromptParams; result: SessionPromptResult };
  "session/set_config_option": { params: SessionSetConfigOptionParams; result: SessionSetConfigOptionResult };
}

export type AcpMethod = keyof AcpMethodMap;
export type AcpRequestParams<M extends AcpMethod> = AcpMethodMap[M]["params"];
export type AcpResponse<M extends AcpMethod> = AcpMethodMap[M]["result"];

/**
 * "write" picks the first "allow*" option; "read-only" rejects tool calls whose
 * kind mutates the workspace (edit/delete/move) and allows the rest. An object
 * maps toolCall.kind ("execute", "edit", ... or "*") to an explicit verdict.
 */
export type PermissionPolicy = "read-only" | "write" | Record<string, "allow" | "reject">;

export interface KimiAcpClientOptions {
  env?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
  clientCapabilities?: ClientCapabilities;
  brokerEndpoint?: string;
  disableBroker?: boolean;
  reuseExistingBroker?: boolean;
  permissionPolicy?: PermissionPolicy;
}
