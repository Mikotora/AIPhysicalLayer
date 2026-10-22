export const NATURE_BINDING_BOOTSTRAP: Record<string, { nickname: string; type: string }> = {
  "appliance.generic": { nickname: "部屋のエアコン追加ボタン", type: "IR" }, "climate.room": { nickname: "部屋のエアコン", type: "AC" },
  "light.room": { nickname: "部屋の照明", type: "IR" }, "climate.living_room": { nickname: "リビングのエアコン", type: "AC" },
  "media.tv": { nickname: "テレビ", type: "TV" }, "light.living_room": { nickname: "リビングの照明", type: "LIGHT" },
};
export type NatureActionBinding = { kind: "light_button"; button: string } | { kind: "tv_button"; button: string | ((parameters: Record<string, unknown>) => string) } | { kind: "signal" } | { kind: "aircon" };
export const NATURE_SIGNAL_NAMES: Record<string, string> = {
  "light.room.cycle": "オン/オフ/常夜灯", "light.living_room.mode.reading": "読書モード", "light.living_room.mode.dining": "食事モード", "light.living_room.mode.relaxing": "くつろぎモード",
  "appliance.generic.dehumidify.high": "除湿強", "appliance.generic.dehumidify.normal": "除湿標準", "appliance.generic.dehumidify.low": "除湿弱",
  "appliance.generic.laundry": "ランドリー", "appliance.generic.high_power": "ハイパワー", "appliance.generic.heat_sterilize": "加熱除菌運転", "appliance.generic.filter_clean": "フィルターお掃除",
};
const lightButtons: Record<string, string> = {
  "light.living_room.on": "on", "light.living_room.off": "off", "light.living_room.full": "on-100", "light.living_room.favorite": "on-favorite", "light.living_room.night": "night",
  "light.living_room.brighten": "bright-up", "light.living_room.dim": "bright-down", "light.living_room.warmer": "colortemp-down", "light.living_room.cooler": "colortemp-up",
};
const tvButtons: Record<string, string | ((p: Record<string, unknown>) => string)> = {
  "media.tv.power_toggle": "power", "media.tv.input.next": "select-input-src",
  "media.tv.input.select": (p) => ({ terrestrial: "input-terrestrial", bs: "input-bs", cs: "input-cs" }[String(p.input)]!),
  "media.tv.channel.select": (p) => `ch-${p.channel}`, "media.tv.channel.next": "ch-up", "media.tv.channel.previous": "ch-down",
  "media.tv.volume.up": "vol-up", "media.tv.volume.down": "vol-down", "media.tv.mute_toggle": "mute", "media.tv.navigate": (p) => String(p.key),
  "media.tv.color.blue": "blue", "media.tv.color.red": "red", "media.tv.color.green": "green", "media.tv.color.yellow": "yellow",
  "media.tv.playback": (p) => ({ rewind: "fast-rewind", fast_forward: "fast-forward", previous: "prev", recordings: "rec-list", ...Object.fromEntries(["play","record","pause","stop","next","timer","subtitle","submenu"].map((x) => [x,x])) }[String(p.key)]!),
  "media.tv.function": (p) => ({ schedule: "tv-schedule", audio: "select-audio", display: "display", data: "d" }[String(p.key)]!),
};
const airconActions = new Set([
  "climate.room.on", "climate.room.off", "climate.room.set_mode", "climate.room.set_temperature", "climate.room.set_fan_speed",
  "climate.room.set_vertical_direction", "climate.room.set_horizontal_direction",
  "climate.living_room.on", "climate.living_room.off", "climate.living_room.set_mode", "climate.living_room.set_temperature", "climate.living_room.set_fan_speed",
]);
export function natureBindingFor(actionId: string): NatureActionBinding | undefined {
  if (NATURE_SIGNAL_NAMES[actionId]) return { kind: "signal" };
  if (lightButtons[actionId]) return { kind: "light_button", button: lightButtons[actionId] };
  if (tvButtons[actionId]) return { kind: "tv_button", button: tvButtons[actionId] };
  if (airconActions.has(actionId)) return { kind: "aircon" };
}
export function listNatureDirectActionIds(): string[] {
  return [...Object.keys(NATURE_SIGNAL_NAMES), ...Object.keys(lightButtons), ...Object.keys(tvButtons), ...airconActions].sort();
}
