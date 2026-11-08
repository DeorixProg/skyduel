// `npm run dev`: Node server (with --watch) and Vite dev server side by side.
import { spawn } from "node:child_process";

const run = (args) => spawn("npm", args, { stdio: "inherit", shell: true });
const children = [run(["run", "dev", "-w", "server"]), run(["run", "dev", "-w", "client"])];
const stop = () => {
  for (const c of children) c.kill("SIGINT");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
