const DEFAULT_CONFIG = {
  owner: 'platypython',
  repo: 'openPronounce',
  branch: "main",
  projectsPath: "projects",
};

const CONFIG = {
  ...DEFAULT_CONFIG,
  ...(globalThis.OPEN_PRONOUNCE_CONFIG ?? {}),
};

const els = {
  projects: document.getElementById("projects"),
  loading: document.getElementById("loading"),
  error: document.getElementById("error"),
  empty: document.getElementById("empty"),
  searchInput: document.getElementById("searchInput"),
  countLabel: document.getElementById("countLabel"),
  repoLink: document.getElementById("repoLink"),
  audioStatus: document.getElementById("audioStatus"),
  audioStatusText: document.getElementById("audioStatusText"),
  audioEnableButton: document.getElementById("audioEnableButton"),
};

function inferGitHubRepoFromLocation() {
  const host = window.location.hostname;
  const path = window.location.pathname.replace(/^\/+/, "");

  if (!host.endsWith("github.io")) return null;

  const owner = host.split(".")[0] || null;
  const firstSegment = path.split("/").filter(Boolean)[0] ?? "";

  const repo = firstSegment.length > 0 ? firstSegment : `${owner}.github.io`;

  return owner && repo ? { owner, repo } : null;
}

function getRepoSpec() {
  if (CONFIG.owner && CONFIG.repo) return { owner: CONFIG.owner, repo: CONFIG.repo };

  const inferred = inferGitHubRepoFromLocation();
  if (inferred) return inferred;

  return null;
}

function apiUrl(path) {
  const spec = getRepoSpec();
  if (!spec) return null;

  const { owner, repo } = spec;
  const base = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
  url.searchParams.set("ref", CONFIG.branch);
  return url.toString();
}

function setError(message) {
  els.error.textContent = message;
  els.error.classList.remove("hidden");
}

function clearError() {
  els.error.textContent = "";
  els.error.classList.add("hidden");
}

function setLoading(isLoading) {
  els.loading.classList.toggle("hidden", !isLoading);
}

function normalize(str) {
  return (str ?? "").toString().trim().toLowerCase();
}

function fuzzyScore(queryRaw, targetRaw) {
  const query = normalize(queryRaw);
  const target = normalize(targetRaw);
  if (!query) return 0;
  if (!target) return -Infinity;

  let qi = 0;
  let score = 0;
  let streak = 0;

  for (let ti = 0; ti < target.length; ti += 1) {
    if (target[ti] === query[qi]) {
      qi += 1;
      streak += 1;
      score += 10 + streak * 2;

      if (qi >= query.length) break;
    } else {
      streak = 0;
      score -= 1;
    }
  }

  if (qi < query.length) return -Infinity;

  if (target.startsWith(query)) score += 30;
  if (target === query) score += 50;

  return score;
}

function sortByName(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (typeof text === "string") el.textContent = text;
  return el;
}

let audioContext = null;
let audioUnlocked = false;
let currentAudio = null;

function setAudioStatus(state, text, showButton) {
  els.audioStatus.dataset.state = state;
  els.audioStatusText.textContent = text;
  els.audioEnableButton.classList.toggle("hidden", !showButton);
}

async function unlockAudio() {
  if (audioUnlocked) return true;

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    setAudioStatus("bad", "Audio is not supported in this browser.", false);
    return false;
  }

  try {
    audioContext = audioContext ?? new AudioContextCtor();
    if (audioContext.state !== "running") {
      await audioContext.resume();
    }

    audioUnlocked = audioContext.state === "running";

    if (audioUnlocked) {
      setAudioStatus("good", "Audio ready.", false);
      return true;
    }

    setAudioStatus("bad", "Audio is still locked. Try tapping again.", true);
    return false;
  } catch {
    setAudioStatus("bad", "Audio could not be enabled (blocked).", true);
    return false;
  }
}

function initAudioStatus() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    setAudioStatus("bad", "Audio is not supported in this browser.", false);
    return;
  }

  setAudioStatus("bad", "Audio locked by browser. Tap “Enable audio”.", true);

  els.audioEnableButton.addEventListener("click", async () => {
    await unlockAudio();
  });
}

async function playMp3(url, onState) {
  if (!url) return;

  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  const audio = new Audio(url);
  currentAudio = audio;

  audio.addEventListener("ended", () => onState?.("stopped"), { once: true });
  audio.addEventListener("pause", () => onState?.("stopped"));

  try {
    onState?.("playing");
    await audio.play();
  } catch {
    onState?.("stopped");
    setAudioStatus("bad", "Playback blocked. Tap “Enable audio”, then try again.", true);
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API error (${res.status}): ${text || res.statusText}`);
  }

  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to fetch: ${url}`);
  return res.text();
}

async function loadProjectDirs() {
  const url = apiUrl(CONFIG.projectsPath);
  if (!url) {
    throw new Error(
      "Could not infer GitHub repo. Set window.OPEN_PRONOUNCE_CONFIG = { owner, repo } in the console (or hardcode in app.js)."
    );
  }

  const list = await fetchJson(url);
  if (!Array.isArray(list)) return [];

  return list.filter((item) => item?.type === "dir");
}

async function loadProjectFromDir(dirItem) {
  const dirListing = await fetchJson(dirItem.url);
  const files = Array.isArray(dirListing) ? dirListing : [];

  const wantMp3Name = `${dirItem.name}.mp3`;

  const mp3 =
    files.find((f) => f?.type === "file" && f?.name === wantMp3Name) ??
    files.find((f) => f?.type === "file" && f?.name?.toLowerCase().endsWith(".mp3"));

  const descFile = files.find((f) => f?.type === "file" && f?.name === "description.txt");
  const iconFile = files.find((f) => f?.type === "file" && f?.name === "icon.png");

  let description = "";
  if (descFile?.download_url) {
    try {
      description = (await fetchText(descFile.download_url)).trim();
    } catch {
      description = "";
    }
  }

  return {
    name: dirItem.name,
    description,
    mp3Url: mp3?.download_url ?? null,
    iconUrl: iconFile?.download_url ?? null,
    githubUrl: dirItem.html_url ?? null,
  };
}

function renderCard(project) {
  const card = createEl("article", "card");
  card.setAttribute("role", "listitem");
  card.dataset.name = project.name;

  const left = createEl("div", "card__left");

  const btn = createEl("button", "play", "▶");
  btn.type = "button";
  btn.setAttribute("aria-label", `Play pronunciation for ${project.name}`);

  const hasAudio = Boolean(project.mp3Url);
  if (!hasAudio) {
    btn.setAttribute("aria-disabled", "true");
    btn.disabled = true;
  }

  btn.addEventListener("click", async () => {
    await unlockAudio();
    await playMp3(project.mp3Url, (state) => {
      btn.textContent = state === "playing" ? "❚❚" : "▶";
    });
  });

  left.appendChild(btn);

  if (project.iconUrl) {
    const icon = document.createElement("img");
    icon.className = "icon";
    icon.alt = "";
    icon.loading = "lazy";
    icon.decoding = "async";
    icon.src = project.iconUrl;
    left.appendChild(icon);
  } else {
    const spacer = createEl("div", "icon");
    spacer.setAttribute("aria-hidden", "true");
    left.appendChild(spacer);
  }

  const right = createEl("div");

  const title = createEl("h3", "card__title", project.name);
  const desc = createEl(
    "p",
    "card__desc",
    project.description || "(No description yet — add description.txt)"
  );

  const meta = createEl("div", "card__meta");

  if (project.githubUrl) {
    const link = createEl("a", "card__link", "View on GitHub");
    link.href = project.githubUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    meta.appendChild(link);
  }

  if (!project.mp3Url) {
    meta.appendChild(createEl("span", null, "Missing MP3"));
  }

  right.appendChild(title);
  right.appendChild(desc);
  right.appendChild(meta);

  card.appendChild(left);
  card.appendChild(right);

  return card;
}

function applyFilterAndRender(allProjects) {
  const q = els.searchInput.value;

  const filtered = allProjects
    .map((p) => ({
      project: p,
      score: fuzzyScore(q, p.name) + fuzzyScore(q, p.description),
    }))
    .filter((x) => (normalize(q) ? Number.isFinite(x.score) : true))
    .map((x) => x.project)
    .sort(sortByName);

  els.projects.replaceChildren(...filtered.map(renderCard));

  els.countLabel.textContent = String(filtered.length);

  els.empty.classList.toggle("hidden", filtered.length !== 0);
}

async function main() {
  initAudioStatus();

  const spec = getRepoSpec();
  if (spec) {
    els.repoLink.href = `https://github.com/${spec.owner}/${spec.repo}`;
  } else {
    els.repoLink.href = "https://github.com";
  }

  els.searchInput.addEventListener("input", () => {
    if (globalThis.__ALL_PROJECTS__) {
      applyFilterAndRender(globalThis.__ALL_PROJECTS__);
    }
  });

  clearError();
  setLoading(true);

  try {
    const dirs = await loadProjectDirs();
    const projects = await Promise.all(dirs.map(loadProjectFromDir));

    const sorted = projects.sort(sortByName);
    globalThis.__ALL_PROJECTS__ = sorted;

    applyFilterAndRender(sorted);
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    setLoading(false);
  }
}

main();
