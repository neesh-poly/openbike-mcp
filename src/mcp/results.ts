import { DomainError, type SafeError } from "../contracts";

export interface McpSuccessResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
}

export interface McpFailureResult {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

export function successResult(
  output: Record<string, unknown>,
  maxBytes: number,
): McpSuccessResult {
  const encoded = JSON.stringify(output);
  // MCP structured results are also serialized as text for older/content-only
  // clients. Account for both copies when enforcing the public response cap.
  const result: McpSuccessResult = {
    content: [{ type: "text", text: encoded }],
    structuredContent: output,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxBytes) {
    throw new DomainError(
      "INTERNAL_ERROR",
      "The bounded result could not be serialized within the response budget.",
      true,
    );
  }
  return result;
}

export function failureResult(
  error: unknown,
  requestId: string,
): McpFailureResult {
  const safe: SafeError =
    error instanceof DomainError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          request_id: requestId,
        }
      : {
          code: "INTERNAL_ERROR",
          message: "The service could not complete the request.",
          retryable: true,
          request_id: requestId,
        };

  return {
    content: [{ type: "text", text: JSON.stringify({ error: safe }) }],
    isError: true,
  };
}
