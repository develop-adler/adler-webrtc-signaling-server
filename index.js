import { on } from "events";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";

let wss = new WebSocketServer({
    port: 4000
});

let socketsPerPath = new Map(); // {path : {string : WebSocket}}
let peerIdsPerPath = new Map(); // {path : {string}}

wss.on("connection", async (socket, request) => {
    let url = new URL(request.url, `ws://${request.headers.host}`);
    let pathparts = url.pathname.split("/").filter(part => part !== "");
    if (pathparts.length !== 1) { socket.close(); return; }
    let path = pathparts[0];

    if (!socketsPerPath.has(path)) { socketsPerPath.set(path, new Map()); }
    if (!peerIdsPerPath.has(path)) { peerIdsPerPath.set(path, new Set()); }
    let sockets = socketsPerPath.get(path); // {string : WebSocket}
    let peerIds = peerIdsPerPath.get(path); // {string} <- added when joined
    // when a new peer joins, peerIds is the ids that the peer should initiate

    let id;
    do { id = nanoid(); } while (sockets.has(id));

    sockets.set(id, socket);

    // health checking
    let isAlive = true;
    socket.on("pong", () => { isAlive = true; });
    let interval = setInterval(() => {
        if (isAlive === false) { socket.terminate(); }
        isAlive = false;
        socket.ping();
    }, 5000);
    socket.on("close", () => clearInterval(interval));

    // aborting on close
    let ac = new AbortController();
    socket.on("close", () => ac.abort());

    try {
        for await (let [data] of on(socket, "message", { signal: ac.signal })) {
            console.log("received data: %s", data);
            let message = null;
            try {
                message = JSON.parse(data);
            } catch {
                continue;
            }
            console.log("parsed message: %s", message);

            if (message.type === "join") {
                peerIds.add(id);
                socket.send(JSON.stringify({ type: "join", id, peerIds: Array.from(peerIds).filter(peerId => peerId !== id) }));
                for (let peerId of peerIds) {
                    if (sockets.get(peerId) === socket) { continue; }
                    sockets.get(peerId).send(JSON.stringify({ type: "add", id }));
                }
            } else if (message.type === "signal" && typeof message.to === "string" && peerIds.has(message.to) && typeof message.data === "string") {
                let dest = sockets.get(message.to);
                dest.send(JSON.stringify({ type: "signal", from: id, data: message.data }));
            }
        }
    } catch (error) {
        if (error.name === "AbortError") {
            peerIds.delete(id);
            sockets.delete(id);
            for (let peerId of peerIds) {
                sockets.get(peerId).send(JSON.stringify({ type: "remove", id }));
            }
        } else {
            throw error;
        }
    }
});
