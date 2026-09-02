export interface LocalProcessTreeUsage {
  supported: boolean;
  measurement_scope: "vitest_and_workerd_process_tree";
  user_cpu_ms: number | null;
  system_cpu_ms: number | null;
  total_cpu_ms: number | null;
  peak_rss_bytes: number | null;
  caveat: string;
}

const numberFrom = (input: string, expression: RegExp): number | null => {
  const match = expression.exec(input);
  if (match?.[1] === undefined) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
};

export const parseLocalProcessTreeUsage = (
  input: string,
  platform: NodeJS.Platform,
): LocalProcessTreeUsage => {
  const caveat =
    "Includes Node, pnpm, Vitest, Vite, and workerd overhead; it is not per-invocation CPU or Durable Object isolate memory and is not compared with Cloudflare's isolate limit.";

  if (platform === "darwin") {
    const userSeconds = numberFrom(input, /([\d.]+)\s+user/);
    const systemSeconds = numberFrom(input, /([\d.]+)\s+sys/);
    const peakRssBytes = numberFrom(
      input,
      /^\s*(\d+)\s+maximum resident set size/m,
    );
    const supported =
      userSeconds !== null && systemSeconds !== null && peakRssBytes !== null;
    return {
      supported,
      measurement_scope: "vitest_and_workerd_process_tree",
      user_cpu_ms: userSeconds === null ? null : Math.round(userSeconds * 1_000),
      system_cpu_ms:
        systemSeconds === null ? null : Math.round(systemSeconds * 1_000),
      total_cpu_ms:
        userSeconds === null || systemSeconds === null
          ? null
          : Math.round((userSeconds + systemSeconds) * 1_000),
      peak_rss_bytes: peakRssBytes,
      caveat,
    };
  }

  if (platform === "linux") {
    const userSeconds = numberFrom(input, /User time \(seconds\):\s*([\d.]+)/);
    const systemSeconds = numberFrom(
      input,
      /System time \(seconds\):\s*([\d.]+)/,
    );
    const peakRssKilobytes = numberFrom(
      input,
      /Maximum resident set size \(kbytes\):\s*(\d+)/,
    );
    const supported =
      userSeconds !== null &&
      systemSeconds !== null &&
      peakRssKilobytes !== null;
    return {
      supported,
      measurement_scope: "vitest_and_workerd_process_tree",
      user_cpu_ms: userSeconds === null ? null : Math.round(userSeconds * 1_000),
      system_cpu_ms:
        systemSeconds === null ? null : Math.round(systemSeconds * 1_000),
      total_cpu_ms:
        userSeconds === null || systemSeconds === null
          ? null
          : Math.round((userSeconds + systemSeconds) * 1_000),
      peak_rss_bytes:
        peakRssKilobytes === null ? null : peakRssKilobytes * 1_024,
      caveat,
    };
  }

  return {
    supported: false,
    measurement_scope: "vitest_and_workerd_process_tree",
    user_cpu_ms: null,
    system_cpu_ms: null,
    total_cpu_ms: null,
    peak_rss_bytes: null,
    caveat: `${caveat} Automatic resource parsing is unsupported on ${platform}.`,
  };
};
