import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const GARMIN_API_BASE = "https://apis.garmin.com/wellness-wellness/v2";

interface Env {
  GARMIN_CONSUMER_KEY: string;
  GARMIN_CONSUMER_SECRET: string;
  GARMIN_USER_TOKEN: string;
  GARMIN_USER_TOKEN_SECRET: string;
}

function pct(str: string): string {
  return encodeURIComponent(str).replace(/!/g,"%21").replace(/'/g,"%27").replace(/\(/g,"%28").replace(/\)/g,"%29").replace(/\*/g,"%2A");
}

async function hmacSha1(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function nonce(n = 16): string {
  const c = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  let s = ""; for (let i = 0; i < n; i++) s += c[b[i] % c.length]; return s;
}

async function sign(env: Env, method: string, url: string, params: Record<string,string> = {}): Promise<string> {
  const u = new URL(url);
  const oauth: Record<string,string> = {
    oauth_consumer_key: env.GARMIN_CONSUMER_KEY,
    oauth_token: env.GARMIN_USER_TOKEN,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now()/1000).toString(),
    oauth_nonce: nonce(),
    oauth_version: "1.0",
  };
  const all: Record<string,string> = { ...oauth, ...params };
  for (const [k,v] of u.searchParams) all[k] = v;
  const sorted = Object.keys(all).sort().map(k => `${pct(k)}=${pct(all[k])}`).join("&");
  const base = `${method.toUpperCase()}&${pct(u.origin+u.pathname)}&${pct(sorted)}`;
  const key = `${pct(env.GARMIN_CONSUMER_SECRET)}&${pct(env.GARMIN_USER_TOKEN_SECRET)}`;
  const sig = await hmacSha1(key, base);
  const head = Object.keys(oauth).map(k => `${pct(k)}="${pct(oauth[k])}"`).join(", ");
  return `OAuth ${head}, oauth_signature="${pct(sig)}"`;
}

async function garmin(env: Env, path: string, params: Record<string,string> = {}): Promise<unknown> {
  const url = `${GARMIN_API_BASE}${path}`;
  const auth = await sign(env, "GET", url, params);
  const q = new URLSearchParams(params).toString();
  const res = await fetch(q ? `${url}?${q}` : url, { headers: { Authorization: auth, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Garmin ${res.status}: ${await res.text()}`);
  return res.json();
}

function createServer(env: Env) {
  const server = new McpServer({ name: "garmin-mcp", version: "1.0.0" });

  server.tool("get_daily_summary", "Garmin Wellness-Tageszusammenfassung für ein Datum (YYYY-MM-DD).",
    { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
    async ({ date }) => {
      const data = await garmin(env, "/usermetrics", { uploadStartTimeInSeconds: String(Math.floor(new Date(date).getTime()/1000)), durationInSeconds: "86400" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });

  server.tool("get_activities", "Garmin-Aktivitäten in einem Zeitraum (beide YYYY-MM-DD).",
    { start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
    async ({ start, end }) => {
      const data = await garmin(env, "/activities", { start: String(Math.floor(new Date(start).getTime()/1000)), end: String(Math.floor(new Date(end).getTime()/1000)) });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });

  server.tool("get_sleep", "Garmin-Schlafdaten für ein Datum (YYYY-MM-DD).",
    { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
    async ({ date }) => {
      const t = Math.floor(new Date(date).getTime()/1000);
      const data = await garmin(env, "/sleep", { start: String(t), end: String(t + 86400) });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler((req, e) => createServer(e))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
