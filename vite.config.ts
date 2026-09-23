import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_EVENTS_PER_REQUEST = 120;

const performanceLogCollector = (): Plugin => {
  let writeQueue = Promise.resolve();
  let outputDirectory = "";

  return {
    name: "performance-log-collector",
    apply: "serve",
    configureServer(server) {
      outputDirectory = path.resolve(server.config.root, ".performance-logs");
      server.middlewares.use("/__perf-log", (request, response) => {
        if (request.method === "GET") {
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ enabled: true, outputDirectory }));
          return;
        }
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.setHeader("allow", "GET, POST");
          response.end();
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let rejected = false;
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_REQUEST_BYTES) {
            rejected = true;
            response.statusCode = 413;
            response.end();
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        request.on("end", () => {
          if (rejected) return;
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              sessionId?: unknown;
              events?: unknown;
            };
            if (typeof payload.sessionId !== "string" || !Array.isArray(payload.events)) {
              response.statusCode = 400;
              response.end();
              return;
            }

            const events = payload.events.slice(0, MAX_EVENTS_PER_REQUEST).filter((event) => (
              event !== null && typeof event === "object" && !Array.isArray(event)
            ));
            const receivedAt = new Date().toISOString();
            const remoteAddress = request.socket.remoteAddress;
            const lines = events.map((event) => JSON.stringify({
              ...event,
              receivedAt,
              remoteAddress,
              sessionId: payload.sessionId,
            })).join("\n");

            if (lines.length > 0) {
              const date = receivedAt.slice(0, 10);
              const outputFile = path.join(outputDirectory, `performance-${date}.jsonl`);
              writeQueue = writeQueue
                .then(() => mkdir(outputDirectory, { recursive: true }))
                .then(() => appendFile(outputFile, `${lines}\n`, "utf8"))
                .catch((error: unknown) => server.config.logger.error(`[performance-log-collector] ${String(error)}`));
            }
            response.statusCode = 204;
            response.end();
          } catch {
            response.statusCode = 400;
            response.end();
          }
        });
      });
    },
  };
};

export default defineConfig({
  plugins: [performanceLogCollector()],
  build: {
    rollupOptions: {
      input: {
        game: path.resolve(import.meta.dirname, "index.html"),
        characterPreview: path.resolve(import.meta.dirname, "character-preview.html"),
      },
    },
  },
});
