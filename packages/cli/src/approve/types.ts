import type { ApprovalProof } from "../config.js";

export interface PendingApproval {
  id: string;
  /** sha256 of cwd + command */
  h: string;
  n: string;
  exp: number;
  pkg: string;
  ecosystem: "npm" | "pypi";
  name: string;
  version?: string;
  score: number;
  why: string[];
  intent?: { drift: string; reason: string };
}

export type ApprovalOutcome =
  | { kind: "approved"; via: "key" | "passkey"; detail: string; proof?: ApprovalProof }
  | { kind: "rejected"; via: "key" | "passkey"; detail: string }
  | { kind: "timeout"; detail: string }
  | { kind: "unavailable"; detail: string };

export interface Approver {
  readonly via: "key" | "passkey";
  /** quick check: paired and reachable right now */
  ready(): Promise<{ ok: boolean; detail: string }>;
  /** resolve with a verified decision; reject/return timeout when aborted or expired */
  request(req: PendingApproval, signal: AbortSignal, onStatus?: (msg: string) => void): Promise<ApprovalOutcome>;
}
