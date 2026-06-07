const JSON_HEADERS = { "Content-Type": "application/json" };

export async function checkHealth(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function assertServerRunning(serverUrl: string): Promise<void> {
  if (!(await checkHealth(serverUrl))) {
    console.error(`Server not running at ${serverUrl}`);
    console.error(`Start it with: mac dev`);
    process.exit(1);
  }
}

export async function post(serverUrl: string, path: string, payload: unknown): Promise<void> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`Accepted: ${JSON.stringify(data)}`);
    console.log(`Check server logs for progress.`);
  } else {
    console.error(`Failed (${res.status}): ${JSON.stringify(data)}`);
    process.exit(1);
  }
}
