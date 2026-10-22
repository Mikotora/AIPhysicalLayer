export const COMMON_API_V1 = {
  contractVersion: "1.0",
  stability: "frozen",
  frozenAt: "2026-10-01",
  operations: {
    capabilities: {
      effect: "read",
      method: "GET",
      path: "/ai/v1/capabilities",
    },
    state: {
      effect: "read",
      method: "GET",
      path: "/ai/v1/state",
    },
    action: {
      effect: "write",
      method: "POST",
      path: "/ai/v1/actions",
      idempotencyHeader: "Idempotency-Key",
    },
  },
} as const;

export type CommonOperation = keyof typeof COMMON_API_V1.operations;

export type ClientToolBinding = {
  operation: CommonOperation;
  toolName: string;
  method: "GET" | "POST";
  path: string;
};

export type ConversationClientAdapter = {
  adapterId: string;
  protocol: string;
  contractVersion: typeof COMMON_API_V1.contractVersion;
  bindings: readonly ClientToolBinding[];
};
