const actionsContainer = document.querySelector("#device-actions");
const stateElement = document.querySelector("#device-state");
const resultElement = document.querySelector("#action-result");
const logBody = document.querySelector("#log-body");
const refreshLogsButton = document.querySelector("#refresh-logs");
const adapterBadge = document.querySelector("#adapter-badge");
const safetyTitle = document.querySelector("#safety-title");
const safetyDetail = document.querySelector("#safety-detail");

let activeDevice = null;
let activeMode = "mock";

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return body;
}

async function loadDevice() {
  const status = await requestJson("/api/status");
  activeMode = status.mode;
  const isNature = activeMode === "nature";
  adapterBadge.textContent = isNature ? "Nature" : "Mock";
  safetyTitle.textContent = isNature ? "実機操作モード" : "実機には接続していません";
  safetyDetail.textContent = isNature
    ? "localhost限定／許可操作：リビング照明 OFFのみ"
    : "Nature API 未接続／localhost限定／Mock操作のみ";

  const { devices } = await requestJson("/api/devices");
  activeDevice = devices[0] ?? null;
  actionsContainer.replaceChildren();

  if (!activeDevice) {
    stateElement.textContent = "登録済みデバイスがありません";
    return;
  }

  stateElement.textContent = isNature ? "Nature状態：未操作" : "Mock状態：未操作";
  for (const action of activeDevice.actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.dataset.action = action.name;
    button.className = action.name === "off" ? "danger" : "primary";
    button.addEventListener("click", () => runAction(action.name));
    actionsContainer.append(button);
  }
}

async function runAction(action) {
  if (!activeDevice) return;

  setButtonsDisabled(true);
  resultElement.textContent = `${action.toUpperCase()} を${activeMode === "nature" ? "Nature" : "Mock"}へ送信中…`;

  try {
    const result = await requestJson("/api/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-Action-Source": "local-web",
      },
      body: JSON.stringify({
        device: activeDevice.id,
        action,
        parameters: {},
      }),
    });

    if (result.adapter === "nature") {
      stateElement.textContent = "Nature応答：OFFコマンド受理（実機状態は目視確認）";
    } else {
      stateElement.textContent = `Mock状態：${result.adapter_state.power.toUpperCase()}（実機状態ではありません）`;
    }
    resultElement.textContent = `成功 · ${result.command_id}`;
    await loadLogs();
  } catch (error) {
    resultElement.textContent = `失敗 · ${error.message}`;
  } finally {
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  for (const button of actionsContainer.querySelectorAll("button")) {
    button.disabled = disabled;
  }
}

async function loadLogs() {
  const { entries } = await requestJson("/api/logs?limit=20");
  logBody.replaceChildren();

  if (entries.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "操作ログはまだありません";
    row.append(cell);
    logBody.append(row);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("tr");
    const values = [
      new Date(entry.timestamp).toLocaleTimeString("ja-JP"),
      `${entry.device}.${entry.action}`,
      entry.status,
      entry.adapter ?? "—",
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    logBody.append(row);
  }
}

refreshLogsButton.addEventListener("click", () => {
  loadLogs().catch((error) => {
    resultElement.textContent = `ログ取得失敗 · ${error.message}`;
  });
});

Promise.all([loadDevice(), loadLogs()]).catch((error) => {
  resultElement.textContent = `初期化失敗 · ${error.message}`;
});
