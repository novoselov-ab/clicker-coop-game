const socket = io();

const join = document.querySelector("#join");
const game = document.querySelector("#game");
const form = document.querySelector("#joinForm");
const joinError = document.querySelector("#joinError");
const harvest = document.querySelector("#harvest");
const market = document.querySelector("#market");
const players = document.querySelector("#players");
const events = document.querySelector("#events");
const notice = document.querySelector("#notice");
const farmView = document.querySelector("#farmView");
const floaters = document.querySelector("#floaters");

let state = null;
let joined = false;
let previousGrain = null;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = new FormData(form).get("name");
  socket.emit("join", name, (response) => {
    if (!response?.ok) {
      joinError.textContent = response?.error || "Could not join.";
      return;
    }
    joined = true;
    join.classList.add("hidden");
    game.classList.remove("hidden");
  });
});

harvest.addEventListener("click", () => {
  if (!joined) return;
  harvest.classList.remove("pulse");
  void harvest.offsetWidth;
  harvest.classList.add("pulse");
  socket.emit("click");
});

socket.on("state", (nextState) => {
  const nextGrain = nextState?.self?.grain;
  if (joined && previousGrain !== null && nextGrain > previousGrain) {
    showGain(nextGrain - previousGrain);
  }
  previousGrain = nextGrain ?? previousGrain;
  state = nextState;
  render();
});

socket.on("notice", (message) => {
  notice.textContent = message;
  notice.classList.remove("hidden");
  window.setTimeout(() => notice.classList.add("hidden"), 2200);
});

function render() {
  if (!state?.self) return;
  document.querySelector("#farmName").textContent = `${state.self.name}'s Farm`;
  document.querySelector("#grain").textContent = fmt(state.self.grain);
  document.querySelector("#gps").textContent = fmt(state.self.grainPerSecond);
  document.querySelector("#trust").textContent = signed(state.self.trust);
  document.querySelector("#trustEffect").textContent = `${state.self.trustBoost.toFixed(2)}x output`;
  document.querySelector("#gdp").textContent = fmt(state.economy.gdp);
  document.querySelector("#gdpEffect").textContent = `${state.economy.boost.toFixed(2)}x output`;
  document.querySelector("#playerCount").textContent = `${state.players.length}/${state.limits.maxPlayers}`;
  renderFarm();
  renderMarket();
  renderPlayers();
  renderEvents();
}

function renderMarket() {
  market.innerHTML = state.market
    .map((crop) => {
      const disabled = state.self.grain < crop.cost ? "disabled" : "";
      return `
        <button class="crop" type="button" data-crop="${crop.id}" ${disabled}>
          <span class="crop-icon">${crop.icon}</span>
          <span>
            <strong>${crop.name}</strong>
            <small>${crop.owned} owned | +${fmt(crop.baseYield)} grain/sec</small>
          </span>
          <b>${fmt(crop.cost)}</b>
        </button>
      `;
    })
    .join("");

  market.querySelectorAll("[data-crop]").forEach((button) => {
    button.addEventListener("click", () => socket.emit("buy", button.dataset.crop));
  });
}

function renderFarm() {
  const pieces = [];
  const order = ["chickens", "cows", "goats", "orchards", "tractors"];
  const labels = {
    chickens: "CH",
    cows: "CW",
    goats: "GT",
    orchards: "OR",
    tractors: "TR"
  };

  order.forEach((id) => {
    const owned = state.self.buildings[id] || 0;
    const visible = Math.min(owned, 10);
    for (let index = 0; index < visible; index += 1) {
      pieces.push(`<span class="farm-piece ${id}" style="--i:${pieces.length}">${labels[id]}</span>`);
    }
  });

  farmView.innerHTML = pieces.length
    ? pieces.join("")
    : `<span class="empty-farm">Buy animals and tools to fill this farm.</span>`;
}

function renderPlayers() {
  players.innerHTML = state.players
    .map((player, index) => {
      const isSelf = player.id === state.self.id;
      const cooperate = previewInteraction(player, "cooperate");
      const defect = previewInteraction(player, "defect");
      const shareCooldown = cooldownRemaining(player.id, "cooperate");
      const raidCooldown = cooldownRemaining(player.id, "defect");
      const controls = isSelf
        ? `<span class="you">you</span>`
        : `
          <button class="action-card share" type="button" data-action="cooperate" data-id="${player.id}" ${shareCooldown > 0 ? "disabled" : ""} title="Both farms gain grain. Your trust rises.">
            <strong>${shareCooldown > 0 ? `Wait ${shareCooldown}s` : "Share"}</strong>
            <small>You +${fmt(cooperate.actorGain)} | Them +${fmt(cooperate.targetGain)} | Trust +${cooperate.actorTrust}</small>
          </button>
          <button class="action-card raid" type="button" data-action="defect" data-id="${player.id}" ${raidCooldown > 0 ? "disabled" : ""} title="You steal some grain, but more is destroyed. Their grain and your trust drop.">
            <strong>${raidCooldown > 0 ? `Wait ${raidCooldown}s` : "Raid"}</strong>
            <small>You +${fmt(defect.actorGain)} | Them -${fmt(defect.targetLoss)} | Trust ${defect.actorTrust}</small>
          </button>
        `;
      return `
        <article class="player ${isSelf ? "self" : ""}">
          <div class="rank">${index + 1}</div>
          <div>
            <strong>${escapeHtml(player.name)}</strong>
            <small>${fmt(player.grain)} grain | ${fmt(player.grainPerSecond)}/sec | trust ${signed(player.trust)}</small>
          </div>
          <div class="player-actions">${controls}</div>
        </article>
      `;
    })
    .join("");

  players.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      socket.emit("interact", {
        targetId: button.dataset.id,
        type: button.dataset.action
      });
    });
  });
}

function renderEvents() {
  events.innerHTML = state.events
    .map((event) => {
      return `<p class="${event.type || "neutral"}"><span>${timeAgo(event.at)}</span>${escapeHtml(event.text)}</p>`;
    })
    .join("");
}

function cooldownRemaining(targetId, type) {
  const readyAt = state.cooldowns?.[`${targetId}:${type}`] || 0;
  return Math.max(0, Math.ceil((readyAt - state.serverTime) / 1000));
}

function previewInteraction(target, type) {
  const selfOutput = state.self.grainPerSecond || 0;
  const targetOutput = target.grainPerSecond || 0;
  const economy = Math.max(selfOutput, targetOutput, 8);

  if (type === "cooperate") {
    const actorGain = Math.max(5, Math.floor(economy * 20 * 0.14));
    return {
      actorGain,
      targetGain: Math.floor(actorGain * 1.45),
      targetLoss: 0,
      actorTrust: 2
    };
  }

  const base = Math.max(5, Math.floor(economy * 20 * 0.18));
  return {
    actorGain: Math.floor(base * 0.55),
    targetGain: 0,
    targetLoss: base,
    actorTrust: -3
  };
}

function fmt(value) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 10 ? 1 : 0
  }).format(value);
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showGain(amount) {
  const floater = document.createElement("div");
  floater.className = "floater";
  floater.textContent = `+${fmt(amount)} grain`;
  floaters.appendChild(floater);

  const grainStat = document.querySelector(".grain-stat");
  grainStat.classList.remove("gain-pulse");
  void grainStat.offsetWidth;
  grainStat.classList.add("gain-pulse");

  window.setTimeout(() => floater.remove(), 1100);
}
