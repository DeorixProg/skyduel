// "error" without a listener: run `node scripts/crash-demo.ts` (crash) or `... fixed` (survives).
import { Room } from "../src/rooms.ts";

const room = new Room({ id: "demo", name: "demo", maxPlayers: 2, arena: "" });
if (process.argv[2] === "fixed")
  room.on("error", (err: Error) => console.error("room error logged:", err.message));
setInterval(() => console.log("server tick… still alive"), 200).unref();
setTimeout(() => room.emit("error", new Error("match log disk full")), 300);
setTimeout(() => console.log("other rooms keep playing"), 600);
