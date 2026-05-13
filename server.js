const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3010);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 40);
const BOT_INTERVAL_MS = 7000;
const INTERACTION_COOLDOWN_MS = 30_000;
const INTERACTION_POWER_SECONDS = 120;
const MIN_INTERACTION_BASIS = 12;

const CROPS = [
  { id: "chickens", name: "Chickens", icon: "CH", asset: "/assets/icons/chickens.png", baseCost: 15, baseYield: 0.25 },
  { id: "cows", name: "Cows", icon: "CW", asset: "/assets/icons/cows.png", baseCost: 120, baseYield: 2 },
  { id: "goats", name: "Goats", icon: "GT", asset: "/assets/icons/goats.png", baseCost: 750, baseYield: 9 },
  { id: "orchards", name: "Orchards", icon: "OR", asset: "/assets/icons/orchards.png", baseCost: 3800, baseYield: 42 },
  { id: "tractors", name: "Tractors", icon: "TR", asset: "/assets/icons/tractors.png", baseCost: 18000, baseYield: 190 }
];

const ACTIONS = {
  cooperate: {
    label: "Share Feed",
    actorMultiplier: 0.07,
    targetMultiplier: 0.07,
    trust: 2,
    message: "shared feed with"
  },
  defect: {
    label: "Raid Silo",
    actorMultiplier: 0.22,
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

const BOTS = [
  { id: "bot-tit-for-tat", name: "Old Neighbor", strategy: "titForTat" },
  { id: "bot-copycat", name: "Mirror Jack", strategy: "copycat" },
  { id: "bot-grudger", name: "Long Memory", strategy: "grudger" },
  { id: "bot-random", name: "Psycho", strategy: "random" }
];

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
  const player = createPlayer(socket.id, cleanName(name) || `Farmer ${socket.id.slice(0, 4)}`);
  sockets.set(socket.id, socket);
  pushEvent(`${player.name} opened a fresh farm.`);
  return player;
}

function createPlayer(id, name, options = {}) {
  const player = {
    id,
    name,
    grain: options.grain ?? 0,
    totalEarned: options.totalEarned ?? 0,
    trust: 0,
    clicks: 0,
    buildings: Object.fromEntries(CROPS.map((crop) => [crop.id, 0])),
    interactionReadyAt: 0,
    memory: {},
    lastAction: null,
    bot: Boolean(options.bot),
    strategy: options.strategy || null,
    joinedAt: now(),
    lastSeen: now()
  };
  players.set(id, player);
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
    bot: player.bot,
    strategy: player.strategy,
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
    .sort((a, b) => production(b) - production(a) || b.grain - a.grain)
    .map(publicPlayer);

  return {
    self: requester ? publicPlayer(requester) : null,
    players: playerList,
    market: requester ? marketFor(requester) : [],
    events: events.slice(0, 12),
    actions: ACTIONS,
    interactionReadyAt: requester ? requester.interactionReadyAt : 0,
    economy: {
      gdp: Math.floor(globalGdp()),
      boost: gdpBoost()
    },
    serverTime: now(),
    limits: { maxPlayers: MAX_PLAYERS }
  };
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
  const rawValue = Math.floor(economy * 20 * Math.abs(multiplier));
  const actorPowerCap = Math.max(MIN_INTERACTION_BASIS, Math.floor(production(actor) * INTERACTION_POWER_SECONDS));
  return Math.min(rawValue, actorPowerCap);
}

function interactionPreview(actor, target, type) {
  const action = ACTIONS[type];
  const value = interactionValue(actor, target, action.actorMultiplier);

  if (type === "cooperate") {
    const shareGain = Math.max(3, value);
    return {
      actorGain: shareGain,
      targetGain: shareGain,
      targetLoss: 0,
      actorTrust: action.trust,
      targetTrust: 1
    };
  }

  return {
    actorGain: Math.max(5, Math.floor(value * 0.65)),
    targetGain: 0,
    targetLoss: Math.max(8, value),
    actorTrust: action.trust,
    targetTrust: -1
  };
}

function performInteraction(actor, target, type) {
  const action = ACTIONS[type];
  if (!actor || !target || !action || actor.id === target.id) {
    return { ok: false, error: "invalid" };
  }

  const readyAt = actor.interactionReadyAt || 0;
  if (readyAt > now()) {
    return { ok: false, error: "cooldown", readyAt };
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
  actor.interactionReadyAt = now() + INTERACTION_COOLDOWN_MS;
  actor.lastSeen = now();
  target.lastSeen = now();
  rememberInteraction(actor, target, type);

  const targetEffect = type === "cooperate" ? `+${preview.targetGain}` : `-${preview.targetLoss}`;
  pushEvent(
    `${actor.name} ${action.message} ${target.name}: actor +${preview.actorGain} grain, target ${targetEffect} grain, trust ${action.trust > 0 ? "+" : ""}${action.trust}.`,
    type === "cooperate" ? "share" : "raid"
  );

  return { ok: true };
}

function memoryFor(player, otherId) {
  player.memory[otherId] ||= {
    lastActionToTarget: null,
    lastActionFromTarget: null,
    wasRaided: false
  };
  return player.memory[otherId];
}

function rememberInteraction(actor, target, type) {
  actor.lastAction = type;
  const actorMemory = memoryFor(actor, target.id);
  actorMemory.lastActionToTarget = type;

  const targetMemory = memoryFor(target, actor.id);
  targetMemory.lastActionFromTarget = type;
  if (type === "defect") {
    targetMemory.wasRaided = true;
  }
}

function seedBots() {
  for (const bot of BOTS) {
    if (players.has(bot.id)) continue;
    createPlayer(bot.id, bot.name, {
      bot: true,
      strategy: bot.strategy,
      grain: 20,
      totalEarned: 20
    });
  }
  pushEvent("Strategy bots entered the market road.", "neutral");
}

function runBots() {
  let changed = false;
  for (const bot of Array.from(players.values()).filter((player) => player.bot)) {
    botHarvest(bot);
    botBuy(bot);
    changed = true;
    const target = chooseBotTarget(bot);
    if (!target) continue;

    const type = chooseBotAction(bot, target);
    const result = performInteraction(bot, target, type);
    changed ||= result.ok;
  }

  if (changed) emitAll();
}

function botHarvest(bot) {
  const clicks = 2 + Math.floor(Math.random() * 4);
  const amount = (1 + Math.floor(Math.max(0, bot.trust) / 12)) * clicks;
  bot.clicks += clicks;
  bot.lastSeen = now();
  gain(bot, amount);
}

function botBuy(bot) {
  const affordable = CROPS.map((crop) => ({ crop, cost: cropCost(bot, crop) }))
    .filter((item) => bot.grain >= item.cost)
    .sort((a, b) => b.cost - a.cost);

  if (!affordable.length) return;
  const { crop, cost } = affordable[0];
  spend(bot, cost);
  bot.buildings[crop.id] += 1;
  bot.lastSeen = now();
  pushEvent(`${bot.name} bought ${crop.name.toLowerCase()}.`, "buy");
}

function chooseBotTarget(bot) {
  const candidates = Array.from(players.values()).filter((player) => player.id !== bot.id);
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function chooseBotAction(bot, target) {
  const memory = memoryFor(bot, target.id);

  switch (bot.strategy) {
    case "titForTat":
      return memory.lastActionFromTarget === "defect" ? "defect" : "cooperate";
    case "copycat":
      return target.lastAction || "cooperate";
    case "grudger":
      return memory.wasRaided ? "defect" : "cooperate";
    case "alwaysRaid":
      return "defect";
    case "random":
      return Math.random() < 0.5 ? "cooperate" : "defect";
    case "alwaysShare":
    default:
      return "cooperate";
  }
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
    pushEvent(`${player.name} bought ${crop.name.toLowerCase()}.`, "buy");
    emitAll();
  });

  socket.on("interact", ({ targetId, type }) => {
    const actor = players.get(socket.id);
    const target = players.get(targetId);
    const result = performInteraction(actor, target, type);
    if (!result.ok && result.error === "cooldown") {
      socket.emit("notice", `That action is cooling down for ${Math.ceil((result.readyAt - now()) / 1000)}s.`);
      return;
    }

    if (result.ok) emitAll();
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

seedBots();
setInterval(runBots, BOT_INTERVAL_MS);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Farmer's Dilemma running on http://0.0.0.0:${PORT}`);
});
