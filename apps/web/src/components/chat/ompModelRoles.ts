import type { ProviderModelRoleBinding, ServerProviderModel } from "@t3tools/contracts";

export interface OmpRoleMeta {
  readonly label: string;
  readonly description: string;
  /** Role OMP resolves when this one is unbound. */
  readonly fallback?: string;
}

/** Built-in OMP roles (`config/model-roles.ts`), labelled the way OMP's own UI names them. */
export const OMP_ROLE_META: Partial<Record<string, OmpRoleMeta>> = {
  default: { label: "Default", description: "Main session model" },
  smol: { label: "Fast", description: "Quick, cheap work and compaction" },
  slow: { label: "Thinking", description: "Deep-reasoning tier" },
  plan: { label: "Architect", description: "Plan mode" },
  task: { label: "Subtask", description: "Delegated subagent workers" },
  advisor: { label: "Advisor", description: "Turn-by-turn watchdog", fallback: "slow" },
  vision: { label: "Vision", description: "Image inspection when the model can't see" },
  designer: { label: "Designer", description: "UI and visual review agent" },
  commit: { label: "Commit", description: "Commit messages and titles" },
  tiny: { label: "Tiny", description: "Classifiers, titles, memory", fallback: "smol" },
};

/** Thinking suffixes OMP accepts on a role selector. */
export const OMP_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function ompRoleLabel(role: string): string {
  return OMP_ROLE_META[role]?.label ?? role;
}

/** Roles bound to each `provider/modelId`, in role display order. */
export function rolesByModel(
  roles: ReadonlyArray<ProviderModelRoleBinding>,
): Readonly<Record<string, ReadonlyArray<string>>> {
  const out: Record<string, Array<string>> = {};
  for (const binding of roles) {
    if (binding.model === null) continue;
    (out[binding.model] ??= []).push(binding.role);
  }
  return out;
}

/** Thinking levels the model advertises, falling back to OMP's full set. */
export function thinkingLevelsForModel(
  model: ServerProviderModel | undefined,
): ReadonlyArray<string> {
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (option) => option.id === "thinkingLevel",
  );
  if (descriptor?.type === "select") {
    const levels = descriptor.options
      .map((option) => option.id)
      .filter((id) => id !== "off" && id !== "none");
    if (levels.length > 0) return levels;
  }
  return OMP_THINKING_LEVELS;
}
