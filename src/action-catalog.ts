import type { ActionParameters, ActionRequest } from "./types.ts";
import type { AdapterMode } from "./registry.ts";

export type ActionParameterDefinition = {
  name: string; type: "string" | "number" | "integer"; required: boolean;
  enum?: Array<string | number>; minimum?: number; maximum?: number; description?: string;
};
export type CommonActionDefinition = {
  id: string; device: string; action: string; label: string; modes: AdapterMode[];
  technicalAvailable: boolean; parameters: ActionParameterDefinition[];
};

const none: ActionParameterDefinition[] = [];
const action = (id: string, device: string, name: string, label: string, parameters = none): CommonActionDefinition => ({
  id, device, action: name, label, modes: ["mock", "nature"], technicalAvailable: true, parameters,
});
const oneEnum = (name: string, values: string[], description?: string): ActionParameterDefinition[] => [
  { name, type: "string", required: true, enum: values, description },
];

const ACTIONS: CommonActionDefinition[] = [
  action("light.living_room.on", "light.living_room", "on", "点灯"),
  action("light.living_room.off", "light.living_room", "off", "消灯"),
  action("light.living_room.full", "light.living_room", "full", "全灯"),
  action("light.living_room.favorite", "light.living_room", "favorite", "お気に入り"),
  action("light.living_room.night", "light.living_room", "night", "常夜灯"),
  action("light.living_room.brighten", "light.living_room", "brighten", "明るくする"),
  action("light.living_room.dim", "light.living_room", "dim", "暗くする"),
  action("light.living_room.warmer", "light.living_room", "warmer", "暖色にする"),
  action("light.living_room.cooler", "light.living_room", "cooler", "寒色にする"),
  action("light.living_room.mode.reading", "light.living_room", "mode.reading", "読書モード"),
  action("light.living_room.mode.dining", "light.living_room", "mode.dining", "食事モード"),
  action("light.living_room.mode.relaxing", "light.living_room", "mode.relaxing", "くつろぎモード"),
  action("light.room.cycle", "light.room", "cycle", "オン／オフ／常夜灯"),
  ...climateActions("climate.room", ["auto", "fan", "cool", "dry", "heat"], ["1", "2", "3", "4", "auto"], ["auto", "swing"]),
  ...climateActions("climate.living_room", ["fan", "cool", "dry", "heat"], ["1", "2", "3", "4", "5", "auto"], []),
  action("media.tv.power_toggle", "media.tv", "power_toggle", "電源"),
  action("media.tv.input.next", "media.tv", "input.next", "入力切替"),
  action("media.tv.input.select", "media.tv", "input.select", "放送入力", oneEnum("input", ["terrestrial", "bs", "cs"])),
  action("media.tv.channel.select", "media.tv", "channel.select", "チャンネル指定", [{ name: "channel", type: "integer", required: true, minimum: 1, maximum: 12 }]),
  action("media.tv.channel.next", "media.tv", "channel.next", "次のチャンネル"),
  action("media.tv.channel.previous", "media.tv", "channel.previous", "前のチャンネル"),
  action("media.tv.volume.up", "media.tv", "volume.up", "音量を上げる"),
  action("media.tv.volume.down", "media.tv", "volume.down", "音量を下げる"),
  action("media.tv.mute_toggle", "media.tv", "mute_toggle", "消音"),
  action("media.tv.color.blue", "media.tv", "color.blue", "青ボタン"),
  action("media.tv.color.red", "media.tv", "color.red", "赤ボタン"),
  action("media.tv.color.green", "media.tv", "color.green", "緑ボタン"),
  action("media.tv.color.yellow", "media.tv", "color.yellow", "黄ボタン"),
  action("media.tv.navigate", "media.tv", "navigate", "画面操作", oneEnum("key", ["left", "up", "right", "down", "ok", "back", "menu", "exit"])),
  action("media.tv.playback", "media.tv", "playback", "再生・録画操作", oneEnum("key", ["rewind", "play", "record", "fast_forward", "previous", "pause", "stop", "next", "recordings", "timer", "subtitle", "submenu"])),
  action("media.tv.function", "media.tv", "function", "テレビ機能", oneEnum("key", ["schedule", "audio", "display", "data"])),
  action("appliance.generic.dehumidify.high", "appliance.generic", "dehumidify.high", "除湿 強"),
  action("appliance.generic.dehumidify.normal", "appliance.generic", "dehumidify.normal", "除湿 標準"),
  action("appliance.generic.dehumidify.low", "appliance.generic", "dehumidify.low", "除湿 弱"),
  action("appliance.generic.laundry", "appliance.generic", "laundry", "ランドリー"),
  action("appliance.generic.high_power", "appliance.generic", "high_power", "ハイパワー"),
  action("appliance.generic.heat_sterilize", "appliance.generic", "heat_sterilize", "加熱除菌運転"),
  action("appliance.generic.filter_clean", "appliance.generic", "filter_clean", "フィルターお掃除"),
];

function climateActions(device: string, modes: string[], fans: string[], directions: string[]): CommonActionDefinition[] {
  const values = [
    action(`${device}.on`, device, "on", "運転開始"), action(`${device}.off`, device, "off", "運転停止"),
    action(`${device}.set_mode`, device, "set_mode", "運転モード設定", oneEnum("mode", modes)),
    action(`${device}.set_temperature`, device, "set_temperature", "設定温度", [{ name: "value", type: "number", required: true, description: "現在モードでNatureが返す許容値" }]),
    action(`${device}.set_fan_speed`, device, "set_fan_speed", "風量設定", oneEnum("value", fans)),
  ];
  if (directions.length) values.push(
    action(`${device}.set_vertical_direction`, device, "set_vertical_direction", "上下風向", oneEnum("value", directions)),
    action(`${device}.set_horizontal_direction`, device, "set_horizontal_direction", "左右風向", oneEnum("value", directions)),
  );
  return values;
}

export function listActionDefinitions(mode: AdapterMode): CommonActionDefinition[] { return structuredClone(ACTIONS.filter((item) => item.modes.includes(mode))); }
export function findActionDefinition(actionId: string, mode: AdapterMode): CommonActionDefinition | undefined {
  const found = ACTIONS.find((item) => item.id === actionId && item.modes.includes(mode)); return found ? structuredClone(found) : undefined;
}
export function findActionByRequest(request: ActionRequest, mode: AdapterMode): CommonActionDefinition | undefined {
  const found = ACTIONS.find((item) => item.device === request.device && item.action === request.action && item.modes.includes(mode)); return found ? structuredClone(found) : undefined;
}
export function validateActionParameters(definition: CommonActionDefinition, parameters: ActionParameters): string | undefined {
  const expected = new Set(definition.parameters.map((rule) => rule.name));
  const unknown = Object.keys(parameters).find((name) => !expected.has(name)); if (unknown) return `unknown parameter: ${unknown}`;
  for (const rule of definition.parameters) {
    const value = parameters[rule.name];
    if (value === undefined) { if (rule.required) return `missing parameter: ${rule.name}`; continue; }
    if (rule.type === "string" && typeof value !== "string") return `${rule.name} must be a string`;
    if ((rule.type === "number" || rule.type === "integer") && typeof value !== "number") return `${rule.name} must be a number`;
    if (rule.type === "integer" && !Number.isInteger(value)) return `${rule.name} must be an integer`;
    if (rule.enum && !rule.enum.includes(value as string | number)) return `${rule.name} is not supported`;
    if (typeof value === "number" && rule.minimum !== undefined && value < rule.minimum) return `${rule.name} is below the minimum`;
    if (typeof value === "number" && rule.maximum !== undefined && value > rule.maximum) return `${rule.name} is above the maximum`;
  }
}
export function toActionRequest(definition: CommonActionDefinition, parameters: ActionParameters = {}): ActionRequest { return { device: definition.device, action: definition.action, parameters }; }
export function listAiCallableActions(mode: AdapterMode = "nature"): CommonActionDefinition[] { return listActionDefinitions(mode).filter((item) => item.id === "light.living_room.off"); }
