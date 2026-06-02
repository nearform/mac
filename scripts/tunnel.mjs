#!/usr/bin/env node
/**
 * Named local tunnel for the mac server — so GitHub can reach the
 * webhook and the ✅/❌ approval links are clickable from the browser, at a
 * STABLE url you only configure once.
 *
 * Usage:  pnpm tunnel            (subdomain "mac", port 4111)
 *         LL_TUNNEL_SUBDOMAIN=foo PORT=4111 pnpm tunnel
 *
 * Uses `localtunnel` (npm, no account/global install). The requested subdomain
 * is best-effort — if it's taken you get a random one (the script prints
 * whatever URL you actually got). Prefer ngrok/cloudflared with a reserved
 * domain if you want a guaranteed name.
 *
 * Caveat: localtunnel shows a one-time browser interstitial (asks for the
 * "tunnel password" = your public IP, shown in the script output) the first
 * time YOU open an approval link. GitHub's webhook POSTs are not affected.
 */
import localtunnel from "localtunnel";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Single source of truth: read the same .env the app uses, so
// LL_TUNNEL_SUBDOMAIN / PORT / MAC_PUBLIC_URL stay in one place. Node 22+.
// Real env vars already in process.env win (loadEnvFile doesn't overwrite).
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/server/.env");
try {
  process.loadEnvFile(envPath);
} catch {
  /* no .env — fall back to defaults below */
}

const port = Number(process.env.PORT ?? 4111);
const subdomain = process.env.LL_TUNNEL_SUBDOMAIN ?? "mac";

const tunnel = await localtunnel({ port, subdomain });

let publicIp = "(unknown — visit https://loca.lt/mytunnelpassword)";
try {
  publicIp = (await (await fetch("https://loca.lt/mytunnelpassword")).text()).trim();
} catch {
  /* best-effort */
}

const line = "─".repeat(64);
console.log(`\n${line}`);
console.log(`🌐 Tunnel up:  ${tunnel.url}  →  localhost:${port}`);
console.log(line);
console.log(`\nPaste into apps/server/.env:`);
console.log(`  MAC_PUBLIC_URL=${tunnel.url}`);
console.log(`\nGitHub App → Webhook URL:`);
console.log(`  ${tunnel.url}/webhooks/github`);
console.log(`\nApproval links open in your browser at:`);
console.log(`  ${tunnel.url}/approve?...`);
console.log(`  (one-time localtunnel interstitial password = your public IP: ${publicIp})`);
console.log(`\nCtrl-C to stop.\n${line}\n`);

tunnel.on("close", () => {
  console.log("[tunnel] closed");
  process.exit(0);
});
tunnel.on("error", (err) => {
  console.error("[tunnel] error:", err?.message ?? err);
  process.exit(1);
});

const shutdown = () => tunnel.close();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
