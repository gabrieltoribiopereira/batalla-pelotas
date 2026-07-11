/**
 * Batalla de Pelotas — servidor multijugador
 * Sirve el juego por HTTP y gestiona salas por WebSocket:
 * propuestas de disposición, sorteo, apuestas por jugador y reparto de premios.
 *
 * Uso:  npm install && npm start  →  http://localhost:8080
 * El combate lo simula el cliente anfitrión y se retransmite al resto.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const STARTING_COINS = 100;
const ROUND_INCOME = 10;   // monedas que recibe cada jugador al empezar una ronda
const WEAPONS = ["sword", "bow", "shuriken", "shield", "wrench"];
const MIN_FIGHTERS = 2;
const MAX_FIGHTERS = 6;
const MAX_ROOM_PLAYERS = 8;

/* ---------- HTTP: static files ---------- */
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".md": "text/plain; charset=utf-8",
};

const server = http.createServer((req, res) => {
    let file = decodeURIComponent(req.url.split("?")[0]);
    if (file === "/") file = "/index.html";
    const fp = path.join(__dirname, path.normalize(file));
    if (!fp.startsWith(__dirname)) {
        res.writeHead(403);
        return res.end();
    }
    fs.readFile(fp, (err, data) => {
        if (err) {
            res.writeHead(404);
            return res.end("not found");
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
        res.end(data);
    });
});

/* ---------- Rooms ---------- */
const rooms = new Map(); // code -> room
let nextId = 1;

function makeCode() {
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sin I/O para evitar confusiones
    let code;
    do {
        code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
    } while (rooms.has(code));
    return code;
}

function validRoster(r) {
    return Array.isArray(r) &&
        r.length >= MIN_FIGHTERS && r.length <= MAX_FIGHTERS &&
        r.every(w => WEAPONS.includes(w));
}

function randomRoster() {
    const n = MIN_FIGHTERS + Math.floor(Math.random() * (MAX_FIGHTERS - MIN_FIGHTERS + 1));
    return Array.from({ length: n }, () => WEAPONS[Math.floor(Math.random() * WEAPONS.length)]);
}

function publicPlayers(room) {
    return room.players.map(p => ({
        id: p.id,
        name: p.name,
        coins: p.coins,
        hasProposal: !!p.proposal,
        bet: p.bet ? { target: p.bet.target, amount: p.bet.amount } : null,
    }));
}

function broadcast(room, msg, exceptWs) {
    const str = JSON.stringify(msg);
    for (const p of room.players) {
        if (p.ws.readyState === 1 && p.ws !== exceptWs) p.ws.send(str);
    }
}

function syncRoom(room) {
    broadcast(room, {
        t: "room",
        players: publicPlayers(room),
        hostId: room.hostId,
        phase: room.phase,
        roster: room.roster,
        rosterBy: room.rosterBy,
    });
}

/* ---------- WebSocket protocol ---------- */
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
    let me = null;
    let room = null;

    const send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

    ws.on("message", (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (typeof m !== "object" || m === null) return;

        /* --- join / create --- */
        if (m.t === "create" || m.t === "join") {
            if (room) return;
            const name = String(m.name || "").trim().slice(0, 16) || "Jugador";
            if (m.t === "create") {
                room = { code: makeCode(), players: [], hostId: null, phase: "proposals", roster: null, rosterBy: null };
                rooms.set(room.code, room);
            } else {
                room = rooms.get(String(m.code || "").trim().toUpperCase());
                if (!room) { send({ t: "error", msg: "Sala no encontrada" }); room = null; return; }
                if (room.players.length >= MAX_ROOM_PLAYERS) { send({ t: "error", msg: "La sala está llena" }); room = null; return; }
            }
            me = { id: nextId++, name, coins: STARTING_COINS, ws, proposal: null, bet: null, locked: null };
            room.players.push(me);
            if (!room.hostId) room.hostId = me.id;
            send({
                t: "joined",
                code: room.code,
                selfId: me.id,
                hostId: room.hostId,
                phase: room.phase,
                players: publicPlayers(room),
                roster: room.roster,
                rosterBy: room.rosterBy,
            });
            syncRoom(room);
            return;
        }

        if (!room || !me) return;
        const isHost = me.id === room.hostId;

        switch (m.t) {
            /* Cada jugador puede proponer una disposición (o ninguna = aleatoria) */
            case "propose":
                if (room.phase === "battle") return;
                me.proposal = validRoster(m.roster) ? m.roster.slice() : null;
                syncRoom(room);
                break;

            /* El anfitrión sortea: una propuesta al azar, o aleatoria si no hay */
            case "roll": {
                if (!isHost || room.phase === "battle") return;
                const proposers = room.players.filter(p => p.proposal);
                if (proposers.length) {
                    const chosen = proposers[Math.floor(Math.random() * proposers.length)];
                    room.roster = chosen.proposal.slice();
                    room.rosterBy = chosen.name;
                } else {
                    room.roster = randomRoster();
                    room.rosterBy = null;
                }
                room.phase = "betting";
                for (const p of room.players) p.bet = null;
                syncRoom(room);
                break;
            }

            /* Apuesta del jugador: bola + cantidad */
            case "bet": {
                if (room.phase !== "betting" || !room.roster) return;
                const target = Number.isInteger(m.target) && m.target >= 0 && m.target < room.roster.length
                    ? m.target : null;
                const amount = Math.max(0, Math.min(Math.floor(Number(m.amount) || 0), me.coins + ROUND_INCOME));
                me.bet = target === null ? null : { target, amount };
                syncRoom(room);
                break;
            }

            /* El anfitrión arranca: ingreso de ronda, bloqueo de apuestas */
            case "begin": {
                if (!isHost || room.phase !== "betting" || !room.roster) return;
                for (const p of room.players) {
                    p.coins += ROUND_INCOME;
                    if (p.bet && p.bet.amount > 0) {
                        const amount = Math.min(p.bet.amount, p.coins);
                        p.coins -= amount;
                        p.locked = { target: p.bet.target, amount, multiplier: room.roster.length };
                    } else {
                        p.locked = null;
                    }
                }
                room.phase = "battle";
                broadcast(room, {
                    t: "gameStart",
                    roster: room.roster,
                    rosterBy: room.rosterBy,
                    players: publicPlayers(room),
                    hostId: room.hostId,
                });
                break;
            }

            /* Retransmisión del estado de la simulación del anfitrión */
            case "state":
                if (isHost && room.phase === "battle") {
                    broadcast(room, { t: "state", s: m.s }, ws);
                }
                break;

            /* Fin del combate: el servidor liquida las apuestas */
            case "result": {
                if (!isHost || room.phase !== "battle") return;
                const winner = Number.isInteger(m.winner) ? m.winner : null;
                const lines = [];
                for (const p of room.players) {
                    if (!p.locked) continue;
                    const { target, amount, multiplier } = p.locked;
                    if (winner !== null && winner === target) {
                        const payout = amount * multiplier;
                        p.coins += payout;
                        lines.push({ name: p.name, text: `¡apuesta ganada! +${payout} (x${multiplier})`, kind: "win" });
                    } else if (winner === null) {
                        p.coins += amount; // empate: apuesta devuelta
                        lines.push({ name: p.name, text: `empate, apuesta devuelta (+${amount})`, kind: "draw" });
                    } else {
                        lines.push({ name: p.name, text: `apuesta perdida −${amount}`, kind: "lose" });
                    }
                    p.locked = null;
                }
                room.phase = "result";
                broadcast(room, { t: "result", winner, lines, players: publicPlayers(room) });
                break;
            }

            /* Volver a la sala para otra ronda */
            case "toLobby":
                if (!isHost || room.phase === "battle") return;
                room.phase = "proposals";
                room.roster = null;
                room.rosterBy = null;
                for (const p of room.players) p.bet = null;
                syncRoom(room);
                break;
        }
    });

    ws.on("close", () => {
        if (!room || !me) return;
        room.players = room.players.filter(p => p !== me);
        if (room.players.length === 0) {
            rooms.delete(room.code);
            return;
        }
        if (room.hostId === me.id) {
            room.hostId = room.players[0].id;
            if (room.phase === "battle") {
                // El anfitrión simulaba el combate: se cancela y se devuelven las apuestas
                for (const p of room.players) {
                    if (p.locked) { p.coins += p.locked.amount; p.locked = null; }
                }
                room.phase = "proposals";
                room.roster = null;
                room.rosterBy = null;
                broadcast(room, { t: "aborted", msg: "El anfitrión se ha ido; combate cancelado y apuestas devueltas" });
            }
        }
        syncRoom(room);
    });
});

server.listen(PORT, () => {
    console.log(`⚔️  Batalla de Pelotas multijugador en http://localhost:${PORT}`);
    console.log(`   Tus amigos en la misma red: http://<tu-ip-local>:${PORT}`);
});
