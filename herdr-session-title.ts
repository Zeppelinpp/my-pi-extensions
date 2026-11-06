import net from "node:net";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;

function reportSessionName(name: string | undefined): void {
  if (!socketPath || !paneId) return;

  const request = {
    id: `herdr:pi-session-title:${process.pid}:${Date.now()}`,
    method: "pane.report_metadata",
    params: {
      pane_id: paneId,
      source: "herdr:pi-session-title",
      agent: "pi",
      tokens: { thread_title: name ?? null },
    },
  };

  const socket = net.createConnection(socketPath);
  socket.setTimeout(1000, () => socket.destroy());
  socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
  socket.on("data", () => socket.destroy());
  socket.on("error", () => socket.destroy());
}

function showProjectTitle(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;

  const cwd = ctx.sessionManager.getCwd();
  ctx.ui.setTitle(`π - ${path.basename(cwd) || cwd}`);
}

export default function (pi: ExtensionAPI): void {
  if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId) return;

  let titleTimer: ReturnType<typeof setInterval> | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (titleTimer) clearInterval(titleTimer);

    showProjectTitle(ctx);
    reportSessionName(pi.getSessionName());
    titleTimer = setInterval(() => showProjectTitle(ctx), 1000);
    titleTimer.unref();
  });

  pi.on("session_info_changed", (event, ctx) => {
    showProjectTitle(ctx);
    reportSessionName(event.name);
  });

  pi.on("agent_start", (_event, ctx) => {
    showProjectTitle(ctx);
  });

  pi.on("session_shutdown", () => {
    if (titleTimer) clearInterval(titleTimer);
    titleTimer = undefined;
  });
}
