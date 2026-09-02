const CONTROL_AND_BIDI_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu;

const SENSITIVE_KEY =
  /(?:^|[_-])(?:authorization|cookie|password|secret|token|api[_-]?key|prompt|query|latitude|longitude|lat|lon|lng|coordinate|coordinates)(?:$|[_-])/iu;

export const sanitizeProviderText = (value: string, maxLength = 500): string => {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength must be a positive integer");
  }

  const normalized = value
    .normalize("NFC")
    .replace(CONTROL_AND_BIDI_CHARACTERS, "")
    .replace(/\s+/gu, " ")
    .trim();

  const characters = [...normalized];
  if (characters.length <= maxLength) return normalized;
  if (maxLength === 1) return "…";
  return `${characters.slice(0, maxLength - 1).join("")}…`;
};

export interface TelemetryRedactionOptions {
  maxDepth?: number;
  maxArrayLength?: number;
  maxStringLength?: number;
}

export const redactTelemetryValue = (
  value: unknown,
  options: TelemetryRedactionOptions = {},
): unknown => {
  const maxDepth = options.maxDepth ?? 6;
  const maxArrayLength = options.maxArrayLength ?? 50;
  const maxStringLength = options.maxStringLength ?? 500;
  const seen = new WeakSet<object>();

  const visit = (entry: unknown, depth: number): unknown => {
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number") return Number.isFinite(entry) ? entry : null;
    if (typeof entry === "string") {
      return sanitizeProviderText(entry, maxStringLength);
    }
    if (typeof entry === "bigint") return entry.toString();
    if (typeof entry === "undefined" || typeof entry === "function") {
      return undefined;
    }
    if (depth >= maxDepth) return "[Truncated]";
    if (typeof entry !== "object") return String(entry);
    if (seen.has(entry)) return "[Circular]";
    seen.add(entry);

    if (entry instanceof Error) {
      return { name: sanitizeProviderText(entry.name, 100) };
    }

    if (Array.isArray(entry)) {
      const output = entry
        .slice(0, maxArrayLength)
        .map((item) => visit(item, depth + 1));
      if (entry.length > maxArrayLength) output.push("[Truncated]");
      return output;
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(entry)) {
      output[key] = SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : visit(item, depth + 1);
    }
    return output;
  };

  return visit(value, 0);
};
