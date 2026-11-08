import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev/preview middleware for the Lab 3 failure gallery and timing experiments.
 *   ?lag=150     delay this response by 150 ms (simulated network latency)
 *   ?status=503  answer with that HTTP status instead of the file
 * The game never relies on it in production; it only makes failures reproducible.
 */
function networkFaults(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const status = Number(url.searchParams.get("status") ?? 0);
    const lag = Number(url.searchParams.get("lag") ?? 0);
    const respond = () => {
      if (status) {
        res.statusCode = status;
        res.end(`simulated ${status}`);
        return;
      }
      next();
    };
    if (lag > 0) setTimeout(respond, lag);
    else respond();
  };
  return {
    name: "network-faults",
    // block bodies on purpose: a hook that RETURNS a function is treated by Vite as a "post" hook
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [networkFaults()],
  server: {
    // in development the API and the socket live on the Node server (port 8080)
    proxy: {
      "/api": "http://localhost:8080",
      "/health": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
