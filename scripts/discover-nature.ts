async function main(): Promise<void> {
  const token = process.env.NATURE_ACCESS_TOKEN?.trim();
  if (!token) {
    console.error("NATURE_ACCESS_TOKEN is required");
    process.exitCode = 1;
    return;
  }

  try {
    const response = await fetch("https://api.nature.global/1/appliances", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      console.error(`Nature appliance discovery failed (HTTP ${response.status})`);
      process.exitCode = 1;
      return;
    }

    const appliances = await response.json() as Array<Record<string, unknown>>;
    const safeLights = appliances
      .filter((appliance) => appliance.type === "LIGHT")
      .map((appliance) => {
        const light = appliance.light as { buttons?: Array<Record<string, unknown>> } | null;
        const device = appliance.device as Record<string, unknown> | null;
        return {
          nickname: appliance.nickname,
          type: appliance.type,
          controller_name: device?.name,
          buttons: (light?.buttons ?? []).map((button) => ({
            name: button.name,
            label: button.label,
          })),
        };
      });
    console.log(JSON.stringify(safeLights, null, 2));
    console.log("Nature internal IDs were intentionally omitted; use refresh-nature-bindings.ts to store them locally without displaying them");
  } catch {
    console.error("Nature appliance discovery request failed");
    process.exitCode = 1;
  }
}

void main();
