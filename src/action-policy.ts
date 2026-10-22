import { findActionDefinition, listActionDefinitions } from "./action-catalog.ts";
import { listNatureDirectActionIds, natureBindingFor } from "./nature-profiles.ts";
import type { NatureBindings } from "./config.ts";

export class ActionPolicy {
  readonly allowedActionIds: Set<string>;
  readonly mode: "catalog-bound-direct" | "explicit";
  constructor(allowedActionIds?: Iterable<string>, mode?: "catalog-bound-direct" | "explicit") {
    this.allowedActionIds = new Set(allowedActionIds ?? catalogBoundDirectActions());
    this.mode = mode ?? (allowedActionIds === undefined ? "catalog-bound-direct" : "explicit");
  }
  static forNature(bindings: NatureBindings): ActionPolicy {
    const locallyBound = catalogBoundDirectActions().filter((actionId) => {
      const definition = findActionDefinition(actionId, "nature"); const binding = natureBindingFor(actionId);
      if (!definition || !binding || !bindings.appliances[definition.device]) return false;
      return binding.kind !== "signal" || Boolean(bindings.signals[actionId]);
    });
    return new ActionPolicy(locallyBound, "catalog-bound-direct");
  }
  allows(actionId: string): boolean { return this.allowedActionIds.has(actionId); }
  list(): string[] { return [...this.allowedActionIds].sort(); }
}

function catalogBoundDirectActions(): string[] {
  const catalog = new Set(listActionDefinitions("nature").map((action) => action.id));
  return listNatureDirectActionIds().filter((actionId) => catalog.has(actionId));
}
