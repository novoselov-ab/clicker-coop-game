const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3010);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 40);

const CROPS = [
  { id: "chickens", name: "Chickens", icon: "CH", baseCost: 15, baseYield: 0.25 },
  { id: "cows", name: "Cows", icon: "CW", baseCost: 120, baseYield: 2 },
  { id: "goats", name: "Goats", icon: "GT", baseCost: 750, baseYield: 9 },
  { id: "orchards", name: "Orchards", icon: "OR", baseCost: 3800, baseYield: 42 },
  { id: "tractors", name: "Tractors", icon: "TR", baseCost: 18000, baseYield: 190 }
];

const ACTIONS = {
  cooperate: {
    label: "Share Feed",
    actorMultiplier: 0.14,
    targetMultiplier: 0.22,
    trust: 2,
    message: "shared feed with"
  },
  defect: {
    label: "Raid Silo",
    actorMultiplier: 0.18,
    targetMultiplier: -0.34,
    trust: -3,
    message: "raided the silo of"
  }
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const players = new Map();
const sockets = new Map();
const events = [];

function now() {
  return Date.now();
}

function cleanName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 18);
}

function newPlayer(socket, name) {
  const id = socket.id;
  const safeName = cleanName(name) || `Farmer ${id.slice(0, 4)}`;
  const player = {
    id,
    name: safeName,
    grain: 5,
    totalEarned: 5,
    trust: 0,
    clicks: 0,
    buildings: Object.fromEntries(CROPS.map((crop) => [crop.id, 0])),
    cooldowns: {},
    joinedAt: now(),
    lastSeen: now()
  };
  players.set(id, player);
  sockets.set(id, socket);
  pushEvent(`${safeName} opened a fresh farm.`);
  return player;
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    grain: Math.floor(player.grain),
    totalEarned: Math.floor(player.totalEarned),
    grainPerSecond: production(player),
    baseGrainPerSecond: baseProduction(player),
    trustBoost: trustBoost(player),
    gdpBoost: gdpBoost(),
    trust: player.trust,
    clicks: player.clicks,
    buildings: player.buildings,
    joinedAt: player.joinedAt,
    lastSeen: player.lastSeen
  };
}

function production(player) {
  return Number((baseProduction(player) * trustBoost(player) * gdpBoost()).toFixed(2));
}

function baseProduction(player) {
  const base = CROPS.reduce((sum, crop) => {
    return sum + player.buildings[crop.id] * crop.baseYield;
  }, 0);
  return Number(base.toFixed(2));
}

function trustBoost(player) {
  return Math.max(0.7, 1 + player.trust * 0.015);
}

function globalGdp() {
  return Array.from(players.values()).reduce((sum, player) => sum + player.totalEarned, 0);
}

function gdpBoost() {
  return Number((1 + Math.min(0.6, Math.log10(Math.max(10, globalGdp())) * 0.045)).toFixed(3));
}

function cropCost(player, crop) {
  const owned = player.buildings[crop.id] || 0;
  return Math.floor(crop.baseCost * Math.pow(1.17, owned));
}

function marketFor(player) {
  return CROPS.map((crop) => ({
    ...crop,
    cost: cropCost(player, crop),
    owned: player.buildings[crop.id] || 0
  }));
}

function snapshot(forId) {
  const requester = players.get(forId);
  const playerList = Array.from(players.values())
    .sort((a, b) => b.totalEarned - a.totalEarned)
    .map(publicPlayer);

  return {
    self: requester ? publicPlayer(requester) : null,
    players: playerList,
    market: requester ? marketFor(requester) : [],
    events: events.slice(0, 12),
    actions: ACTIONS,
    cooldowns: requester ? cooldownsFor(requester) : {},
    economy: {
      gdp: Math.floor(globalGdp()),
      boost: gdpBoost()
    },
    serverTime: now(),
    limits: { maxPlayers: MAX_PLAYERS }
  };
}

function cooldownsFor(player) {
  return Object.fromEntries(
    Object.entries(player.cooldowns).filter(([, readyAt]) => readyAt > now())
  );
}

function pushEvent(text, type = "neutral") {
  events.unshift({ id: `${Date.now()}-${Math.random()}`, text, type, at: now() });
  events.splice(24);
}

function emitAll() {
  for (const [id, socket] of sockets.entries()) {
    socket.emit("state", snapshot(id));
  }
}

function gain(player, amount) {
  const value = Math.max(0, amount);
  player.grain += value;
  player.totalEarned += value;
}

function spend(player, amount) {
  player.grain = Math.max(0, player.grain - amount);
}

function interactionValue(actor, target, multiplier) {
  const economy = Math.max(production(actor), production(target), 8);
  return Math.max(5, Math.floor(economy * 20 * Math.abs(multiplier)));
}

function interactionPreview(actor, target, type) {
  const action = ACTIONS[type];
  const value = interactionValue(actor, target, action.actorMultiplier);

  if (type === "cooperate") {
    return {
      actorGain: value,
      targetGain: Math.floor(value * 1.45),
      targetLoss: 0,
      actorTrust: action.trust,
      targetTrust: 1
    };
  }

  return {
    actorGain: Math.floor(value * 0.55),
    targetGain: 0,
    targetLoss: value,
    actorTrust: action.trust,
    targetTrust: -1
  };
}

io.on("connection", (socket) => {
  socket.on("join", (rawName, ack) => {
    if (players.size >= MAX_PLAYERS) {
      ack?.({ ok: false, error: "Farm county is full. Try again soon." });
      return;
    }
    const player = newPlayer(socket, rawName);
    ack?.({ ok: true, id: player.id });
    emitAll();
  });

  socket.on("click", () => {
    const player = players.get(socket.id);
    if (!player) return;
    const amount = 1 + Math.floor(Math.max(0, player.trust) / 12);
    player.clicks += 1;
    player.lastSeen = now();
    gain(player, amount);
    socket.emit("state", snapshot(socket.id));
  });

  socket.on("buy", (cropId) => {
    const player = players.get(socket.id);
    const crop = CROPS.find((item) => item.id === cropId);
    if (!player || !crop) return;
    const cost = cropCost(player, crop);
    if (player.grain < cost) return;
    spend(player, cost);
    player.buildings[crop.id] += 1;
    player.lastSeen = now();
    pushEvent(`${player.name} bought ${crop.icon} ${crop.name.toLowerCase()}.`, "buy");
    emitAll();
  });

  socket.on("interact", ({ targetId, type }) => {
    const actor = players.get(socket.id);
    const target = players.get(targetId);
    const action = ACTIONS[type];
    if (!actor || !target || !action || actor.id === target.id) return;

    const cooldownKey = `${target.id}:${type}`;
    const readyAt = actor.cooldowns[cooldownKey] || 0;
    if (readyAt > now()) {
      socket.emit("notice", `That action is cooling down for ${Math.ceil((readyAt - now()) / 1000)}s.`);
      return;
    }

    const preview = interactionPreview(actor, target, type);
    if (type === "cooperate") {
      gain(actor, preview.actorGain);
      gain(target, preview.targetGain);
    } else {
      gain(actor, preview.actorGain);
      spend(target, preview.targetLoss);
    }

    actor.trust += action.trust;
    target.trust += type === "cooperate" ? 1 : -1;
    actor.cooldowns[cooldownKey] = now() + 45_000;
    actor.lastSeen = now();
    target.lastSeen = now();
    const targetEffect = type === "cooperate" ? `+${preview.targetGain}` : `-${preview.targetLoss}`;
    pushEvent(
      `${actor.name} ${action.message} ${target.name}: actor +${preview.actorGain} grain, target ${targetEffect} grain, trust ${action.trust > 0 ? "+" : ""}${action.trust}.`,
      type === "cooperate" ? "share" : "raid"
    );
    emitAll();
  });

  socket.on("disconnect", () => {
    const player = players.get(socket.id);
    if (player) {
      pushEvent(`${player.name} left the market road.`);
      players.delete(socket.id);
      sockets.delete(socket.id);
      emitAll();
    }
  });
});

setInterval(() => {
  for (const player of players.values()) {
    gain(player, production(player));
  }
  emitAll();
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Farm Dilemma running on http://0.0.0.0:${PORT}`);
});
