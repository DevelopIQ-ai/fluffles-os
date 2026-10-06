type AmalgmContext = {
  payload: unknown;
  event: unknown;
};

type AmalgmWorkflowConfig = {
  trigger: unknown;
  allowlist?: Record<string, boolean>;
  limits?: Record<string, number>;
  cells: unknown[];
};

type AmalgmCliOptions = {
  cwd?: string;
  timeoutMs?: number;
  command: string;
};

type AmalgmHttpOptions = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: (context: AmalgmContext) => unknown;
};

declare function workflow(config: AmalgmWorkflowConfig): unknown;
declare function event(name: string): unknown;
declare function cli(name: string, options: AmalgmCliOptions): unknown;
declare function code<T>(name: string, handler: (context: AmalgmContext) => T | Promise<T>): unknown;
declare function http(name: string, options: AmalgmHttpOptions): unknown;
