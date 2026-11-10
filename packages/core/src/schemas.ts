import { z } from "zod";

export const Ecosystem = z.enum(["npm", "pypi"]);
export type Ecosystem = z.infer<typeof Ecosystem>;

export const Verdict = z.enum(["allow", "warn", "hold"]);
export type Verdict = z.infer<typeof Verdict>;

export const InstallTarget = z.object({
  ecosystem: Ecosystem,
  name: z.string().min(1),
  versionSpec: z.string().optional(),
});
export type InstallTarget = z.infer<typeof InstallTarget>;

export const RuleHit = z.object({
  id: z.string(),
  weight: z.number().int().nonnegative(),
  detail: z.string(),
});
export type RuleHit = z.infer<typeof RuleHit>;
