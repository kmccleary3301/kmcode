import type {
  ProviderModelRoleBinding,
  ProviderModelRolesResult,
  ServerProviderModel,
} from "@t3tools/contracts";
import { memo } from "react";
import { ArrowUpRightIcon, EllipsisIcon, LoaderCircleIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getDisplayModelName } from "./providerIconUtils";
import { OMP_ROLE_META, ompRoleLabel, thinkingLevelsForModel } from "./ompModelRoles";

const MODEL_DEFAULT_THINKING = "__model_default__";

/** `/Users/me/.omp/agent/config.yml` → `~/.omp/agent/config.yml` (display only). */
function abbreviateHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/u, "~");
}

function RoleRow(props: {
  readonly binding: ProviderModelRoleBinding;
  readonly model: ServerProviderModel | undefined;
  readonly busy: boolean;
  readonly onChangeModel: () => void;
  readonly onSetThinking: (level: string | null) => void;
  readonly onClear: () => void;
  readonly onUse: (() => void) | undefined;
}) {
  const { binding } = props;
  const meta = OMP_ROLE_META[binding.role];
  const label = meta?.label ?? binding.role;
  const fallbackCount = (binding.selector?.split(",").length ?? 1) - 1;
  const modelLabel = props.model
    ? getDisplayModelName(props.model)
    : (binding.model ?? (binding.aliasOf ? `Same as ${ompRoleLabel(binding.aliasOf)}` : null));
  const detail = [
    props.model?.subProvider ?? binding.model?.split("/")[0],
    fallbackCount > 0 ? `+${fallbackCount} fallback${fallbackCount > 1 ? "s" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const roleName = (
    <div className="w-24 min-w-0 shrink-0">
      <div className="truncate text-xs font-medium leading-tight">{label}</div>
      <div className="truncate font-mono text-3xs leading-tight text-muted-foreground">
        {meta ? binding.role : "custom"}
      </div>
    </div>
  );
  const modelButton = (
    <button
      type="button"
      onClick={props.onChangeModel}
      className="flex min-w-0 flex-1 cursor-pointer flex-col items-start rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
      aria-label={`Change model for ${label}`}
    >
      {modelLabel ? (
        <>
          <span className="w-full truncate text-xs leading-tight">{modelLabel}</span>
          <span className="w-full truncate text-2xs leading-tight text-muted-foreground">
            {detail}
          </span>
        </>
      ) : (
        <span className="text-xs leading-tight text-muted-foreground">
          {meta?.fallback ? `Uses ${ompRoleLabel(meta.fallback)}` : "Not set"}
        </span>
      )}
    </button>
  );

  return (
    <div
      className="flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
      data-model-role={binding.role}
      // Returning from the rebind list remounts the panel at the top; keep the
      // role being written in view.
      ref={props.busy ? (element) => element?.scrollIntoView({ block: "nearest" }) : undefined}
    >
      {meta ? (
        <Tooltip>
          <TooltipTrigger render={roleName} />
          <TooltipPopup side="top" align="start">
            {meta.description}
          </TooltipPopup>
        </Tooltip>
      ) : (
        roleName
      )}

      {binding.selector ? (
        <Tooltip>
          <TooltipTrigger render={modelButton} />
          <TooltipPopup side="top" align="start">
            <span className="font-mono">{binding.selector}</span>
          </TooltipPopup>
        </Tooltip>
      ) : (
        modelButton
      )}

      {binding.model ? (
        <Select
          value={binding.thinkingLevel ?? MODEL_DEFAULT_THINKING}
          onValueChange={(value) =>
            props.onSetThinking(
              typeof value === "string" && value !== MODEL_DEFAULT_THINKING ? value : null,
            )
          }
          disabled={props.busy}
        >
          <SelectTrigger
            size="xs"
            variant="ghost"
            className="w-auto min-w-0 shrink-0"
            aria-label={`Thinking level for ${label}`}
          >
            <SelectValue>
              {binding.thinkingLevel ?? <span className="text-muted-foreground">Default</span>}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={MODEL_DEFAULT_THINKING}>Model default</SelectItem>
            {thinkingLevelsForModel(props.model).map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}

      <span className="flex w-6 shrink-0 justify-center">
        {props.busy ? (
          <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost-muted" aria-label={`${label} actions`} />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={props.onChangeModel}>Change model…</MenuItem>
              {props.onUse ? (
                <MenuItem onClick={props.onUse}>
                  <ArrowUpRightIcon />
                  Use in composer
                </MenuItem>
              ) : null}
              {binding.selector ? (
                <>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={props.onClear}>
                    <XIcon />
                    Clear binding
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        )}
      </span>
    </div>
  );
}

/** OMP's `modelRoles`: which model each harness job (subagents, commits, plan mode...) uses. */
export const ModelPickerRolesPanel = memo(function ModelPickerRolesPanel(props: {
  readonly harnessName: string;
  readonly roles: ProviderModelRolesResult | null;
  readonly error: string | null;
  readonly busyRole: string | null;
  readonly modelsBySlug: Readonly<Record<string, ServerProviderModel>>;
  readonly onChangeModel: (binding: ProviderModelRoleBinding) => void;
  readonly onSetThinking: (binding: ProviderModelRoleBinding, level: string | null) => void;
  readonly onClear: (binding: ProviderModelRoleBinding) => void;
  readonly onUse: (model: string) => void;
}) {
  if (props.roles === null) {
    return (
      <div className="flex min-h-32 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {props.error ?? (
          <span className="inline-flex items-center gap-2">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            Reading {props.harnessName} roles…
          </span>
        )}
      </div>
    );
  }
  const renderRow = (binding: ProviderModelRoleBinding) => {
    const model = binding.model === null ? undefined : props.modelsBySlug[binding.model];
    const boundModel = model?.slug;
    return (
      <RoleRow
        key={binding.role}
        binding={binding}
        model={model}
        busy={props.busyRole === binding.role}
        onChangeModel={() => props.onChangeModel(binding)}
        onSetThinking={(level) => props.onSetThinking(binding, level)}
        onClear={() => props.onClear(binding)}
        onUse={boundModel === undefined ? undefined : () => props.onUse(boundModel)}
      />
    );
  };
  const custom = props.roles.roles.filter((binding) => !binding.builtIn);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-model-picker-roles="true">
      <div className="flex items-baseline justify-between gap-3 px-3 pt-2.5 pb-1.5">
        <div className="text-xs font-medium">{props.harnessName} roles</div>
        <Tooltip>
          <TooltipTrigger
            render={<div className="min-w-0 truncate text-2xs text-muted-foreground" />}
          >
            {abbreviateHome(props.roles.configPath)} · new sessions
          </TooltipTrigger>
          <TooltipPopup side="top" align="end">
            <span className="font-mono">{props.roles.configPath}</span>
          </TooltipPopup>
        </Tooltip>
      </div>
      {props.error ? (
        <div className="mx-3 mb-1 rounded-md bg-destructive/8 px-2 py-1.5 text-xs text-destructive-foreground">
          {props.error}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
        {props.roles.roles.filter((binding) => binding.builtIn).map(renderRow)}
        {custom.length > 0 ? (
          <div className="px-2 pt-3 pb-1 text-2xs font-medium text-muted-foreground">
            Custom roles
          </div>
        ) : null}
        {custom.map(renderRow)}
      </div>
    </div>
  );
});
