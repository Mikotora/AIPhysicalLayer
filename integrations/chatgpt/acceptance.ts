export type ExpectedToolCall = {
  operation: "capabilities" | "state" | "action";
  actionId?: string;
  parameters?: Record<string, unknown>;
  newIntent?: boolean;
};

export type ConversationAcceptanceCase = {
  id: string;
  messages: string[];
  expectedCalls: ExpectedToolCall[];
  expectedAnswer: string;
};

export const CHATGPT_ACCEPTANCE_CASES: readonly ConversationAcceptanceCase[] = [
  {
    id: "living-room-temperature",
    messages: ["リビング今何度？"],
    expectedCalls: [{ operation: "state" }],
    expectedAnswer: "environment.living_room.temperature の値と単位をStateから回答する",
  },
  {
    id: "living-room-humidity-follow-up",
    messages: ["リビング今何度？", "湿度は？"],
    expectedCalls: [{ operation: "state" }, { operation: "state" }],
    expectedAnswer: "environment.living_room.humidity の値と単位を新しいStateから回答する",
  },
  {
    id: "living-room-light-state",
    messages: ["リビングの照明どうなってる？"],
    expectedCalls: [{ operation: "state" }],
    expectedAnswer: "light.living_room.fields.power がobservedなら現在状態として回答する",
  },
  {
    id: "television-power-unknown",
    messages: ["テレビ今ついてる？"],
    expectedCalls: [{ operation: "state" }],
    expectedAnswer: "media.tv.fields.power がunknownなら推測せず不明と回答する",
  },
  {
    id: "living-room-light-on",
    messages: ["リビングの電気つけて"],
    expectedCalls: [{ operation: "action", actionId: "light.living_room.on", parameters: {}, newIntent: true }],
    expectedAnswer: "Action APIの成否だけを報告し、未観測なら物理結果を断定しない",
  },
  {
    id: "living-room-air-conditioner-cool-24",
    messages: ["エアコンを冷房24℃にして"],
    expectedCalls: [
      { operation: "capabilities" },
      { operation: "action", actionId: "climate.living_room.set_mode", parameters: { mode: "cool" }, newIntent: true },
      { operation: "action", actionId: "climate.living_room.set_temperature", parameters: { value: 24 }, newIntent: true },
    ],
    expectedAnswer: "capability範囲を確認し、モードと温度を順番に実行して各結果を報告する",
  },
  {
    id: "television-volume-down",
    messages: ["テレビの音量ひとつ下げて"],
    expectedCalls: [{ operation: "action", actionId: "media.tv.volume.down", parameters: {}, newIntent: true }],
    expectedAnswer: "音量の現在値は推測せず、Action APIの成否を報告する",
  },
  {
    id: "explicit-repeat-is-a-new-intent",
    messages: ["テレビの音量ひとつ下げて", "もう一度"],
    expectedCalls: [
      { operation: "action", actionId: "media.tv.volume.down", parameters: {}, newIntent: true },
      { operation: "action", actionId: "media.tv.volume.down", parameters: {}, newIntent: true },
    ],
    expectedAnswer: "明示的な再依頼は別intentとして別Idempotency-Keyで一回ずつ実行する",
  },
] as const;
