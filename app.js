"use strict";

/*
 * app.js —— 模板引擎（一般不需要改动）
 *
 * 所有内容都来自 config.js（window.TRIP_CONFIG）：
 *   站点、主角、日期、文案、照片、地图点位……
 * 本文件只负责把配置渲染成页面，并管理交互：
 *   解锁进度（localStorage）、骰子小游戏、音乐（WebAudio）。
 *
 * 内置调试参数（URL 上加 ?xxx=1）：
 *   preview=1             直接解锁全部站点
 *   reset=1               清空本地进度
 *   view=chapter&stop=2   直达某一站
 *   selftest=1            输出回归自检报告（#selftest-report）
 */

const CFG = window.TRIP_CONFIG;
if (!CFG || !Array.isArray(CFG.stops) || CFG.stops.length === 0) {
  throw new Error(
    "config.js 未正确加载或没有配置任何站点。请确认 config.js 与 index.html 放在同一目录。",
  );
}

/* ---------- 数据 ---------- */
const STOPS = CFG.stops;
const HERO = CFG.hero || {};
const PAGE = CFG.page || {};
const MAP_CFG = CFG.map || {};
const COPY = CFG.copy || {};
const DAY_DATES = CFG.dayDates || {};

const STORAGE_KEY = "trip-progress-" + (CFG.uid || "default");

const params = new URLSearchParams(window.location.search);
const isPreview = params.get("preview") === "1";
const shouldReset = params.get("reset") === "1";

/* 主题：config 里可选 seaside / forest / starry / newlywed / christmas；URL ?theme= 临时切换（调试用） */
const THEMES_ALLOWED = ["seaside", "forest", "starry", "newlywed", "christmas"];
const THEME_ID = THEMES_ALLOWED.includes(params.get("theme"))
  ? params.get("theme")
  : THEMES_ALLOWED.includes(CFG.theme)
    ? CFG.theme
    : "seaside";
try {
  document.body.dataset.theme = THEME_ID;
} catch (err) {
  /* ignore */
}

const $ = (id) => document.getElementById(id);
const screens = {
  cover: $("screen-cover"),
  map: $("screen-map"),
  chapter: $("screen-chapter"),
  finale: $("screen-finale"),
  memory: $("screen-memory"),
};

let state = {
  view: "cover",
  current: 0,
  unlocked: new Set([0]),
  finaleOpened: false,
  diceWon: {},
};

let lastMapIndex = 0;

/* ---------- 小工具 ---------- */

function pad(value) {
  return String(value).padStart(2, "0");
}

function dayLabel(day) {
  return DAY_DATES[day] ? `DAY ${day} · ${DAY_DATES[day]}` : `DAY ${day}`;
}

function text(id, value) {
  const el = $(id);
  if (el) el.textContent = value ?? "";
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/* 站图标：图片（m:/u:/路径/dataURL）或 emoji: 开头的字符 */
function iconHtml(icon) {
  if (typeof icon === "string" && icon.startsWith("emoji:")) {
    return `<span class="marker-emoji">${esc(icon.slice(6))}</span>`;
  }
  return `<img src="${esc(icon || "")}" alt="" />`;
}

/* ---------- 地图几何：点位缺失时自动排布，路线自动连线 ---------- */

function autoPositions(count) {
  const pos = [];
  const perRow = count <= 5 ? count : 4;
  const rows = Math.ceil(count / perRow);
  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / perRow);
    const col = row % 2 === 1 ? perRow - 1 - (i % perRow) : i % perRow; // 蛇形
    const rowSpan = rows <= 1 ? 0 : 100 / rows;
    pos.push({
      x: perRow <= 1 ? 50 : 10 + (col * 80) / Math.max(perRow - 1, 1),
      y: perRow <= 1 ? 18 + (i * 56) / Math.max(count - 1, 1) : 14 + rowSpan * (row + 0.5),
    });
  }
  return pos;
}

function resolvePositions() {
  const given = MAP_CFG.positions;
  if (Array.isArray(given) && given.length === STOPS.length) return given;
  return autoPositions(STOPS.length);
}

const MAP_POSITIONS = resolvePositions();

function routePath() {
  if (typeof MAP_CFG.routePath === "string" && MAP_CFG.routePath) {
    return MAP_CFG.routePath;
  }
  return MAP_POSITIONS.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

/* ---------- 进度存取 ---------- */

function loadState() {
  if (shouldReset) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      /* private mode */
    }
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      state.current = Math.min(Math.max(Number(saved.current) || 0, 0), STOPS.length - 1);
      state.unlocked = new Set(
        Array.isArray(saved.unlocked) ? saved.unlocked.map(Number).filter((n) => n >= 0) : [0],
      );
      state.finaleOpened = Boolean(saved.finaleOpened);
      if (state.unlocked.size === 0) state.unlocked.add(0);
    }
  } catch (err) {
    state.unlocked = new Set([0]);
  }

  if (isPreview) {
    state.unlocked = new Set(STOPS.map((_, index) => index));
  }
}

function saveState() {
  if (isPreview) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        current: state.current,
        unlocked: Array.from(state.unlocked),
        finaleOpened: state.finaleOpened,
      }),
    );
  } catch (err) {
    /* private mode */
  }
}

function isUnlocked(index) {
  return state.unlocked.has(index);
}

/* ---------- 视图切换 ---------- */

function showView(name) {
  Object.entries(screens).forEach(([key, el]) => {
    const active = key === name;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-hidden", String(!active));
  });
  state.view = name;
  if (name === "cover") MusicBox.playFor("cover");
  if (name === "map") MusicBox.playFor("map");
  if (name === "memory") MusicBox.playFor("memory");
  window.scrollTo(0, 0);
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

/* ---------- 静态渲染（只跑一次：元信息 / 封面 / 地图头 / 行程表 / 回忆册） ---------- */

function setMeta(selector, attr, value) {
  const el = document.head.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

function renderStatic() {
  if (PAGE.title) document.title = PAGE.title;
  setMeta('meta[name="description"]', "content", PAGE.description || "");
  setMeta('meta[property="og:title"]', "content", PAGE.title || "");
  setMeta('meta[property="og:description"]', "content", PAGE.description || "");
  if (PAGE.ogImage) setMeta('meta[property="og:image"]', "content", PAGE.ogImage);

  renderCover();
  renderMapChrome();
  renderItinerary();
  renderMemory();
}

function renderCover() {
  text("cover-kicker", `${HERO.datesLabel ? HERO.datesLabel + " · " : ""}${HERO.badge || ""}`);

  const titleEl = $("cover-title");
  const lines = (HERO.titleLines && HERO.titleLines.length) || 0;
  if (titleEl) {
    if (lines >= 2) {
      titleEl.innerHTML = `${esc(HERO.titleLines[0])}<span>${esc(HERO.titleLines[1])}</span>`;
    } else if (lines === 1) {
      titleEl.innerHTML = `<span>${esc(HERO.titleLines[0])}</span>`;
    } else {
      titleEl.innerHTML = `<span>${esc(HERO.name || "")}</span>`;
    }
  }

  const subEl = $("cover-sub");
  if (subEl) subEl.innerHTML = (HERO.subLines || []).map(esc).join("<br />");

  text("cover-couple-name", HERO.coupleName);
  text("cover-couple-note", HERO.coupleNote);

  const avatars = Array.isArray(HERO.avatars) ? HERO.avatars : [];
  const avatarsEl = $("cover-avatars");
  if (avatars.length > 0) {
    if (avatarsEl) {
      avatarsEl.innerHTML = avatars
        .slice(0, 2)
        .map((src) => `<img src="${esc(src)}" alt="" />`)
        .join("");
    }
  } else if (avatarsEl) {
    avatarsEl.remove();
  }

  const chipEl = $("cover-map-chip");
  if (chipEl) {
    const chip = COPY.mapChipNote || "每天的路线，会在地图上慢慢点亮";
    chipEl.innerHTML = `<span class="cover-pin" aria-hidden="true"></span>${esc(chip)}`;
  }

  // 封面大图：没有配置就用纯色渐变封面
  const media = $("cover-media");
  const coverImg = $("cover-img");
  if (HERO.coverImage && coverImg) {
    coverImg.src = HERO.coverImage;
    coverImg.alt = "";
  } else if (media) {
    media.remove();
    $("screen-cover").classList.add("is-plain");
  }

  text("cover-memory-link", (COPY.memoryLink || "旅程回忆册") + " →");
  text("map-memory-link", COPY.memoryLink || "旅程回忆册");
  text("memory-link", (COPY.memoryLink || "旅程回忆册") + " →");
}

function renderMapChrome() {
  text("map-eyebrow", COPY.mapEyebrow || "OUR TRIP");
  text("map-title", MAP_CFG.title || COPY.mapTitle || "旅程路线地图");
  text("itinerary-eyebrow", COPY.mapEyebrow || "OUR TRIP");
  text("itinerary-title", COPY.routeSectionTitle || "这几天的安排");

  const bg = MAP_CFG.background;
  const bgImg = $("map-bg");
  if (bg && bgImg) {
    bgImg.src = bg;
    bgImg.alt = "旅程地图";
  } else if (bgImg) {
    bgImg.remove();
    const wrap = document.querySelector(".map-wrap");
    if (wrap) wrap.classList.add("is-plain");
  }
}

function renderItinerary() {
  const wrap = $("itinerary-days");
  if (!wrap) return;
  const days = [...new Set(STOPS.map((s) => s.day))].sort((a, b) => a - b);
  wrap.innerHTML = days
    .map((day) => {
      const titles = STOPS.filter((s) => s.day === day).map((s) => esc(s.title));
      const arrow = '<span class="day-arrow">→</span>';
      return `<div class="day-block">
        <span class="day-badge">${esc(dayLabel(day))}</span>
        <div class="day-stops">${titles.join(arrow)}</div>
      </div>`;
    })
    .join("");
}

function renderMemory() {
  text("memory-title", COPY.memoryTitle || "旅程回忆册");
  const subEl = $("memory-sub");
  if (subEl) subEl.innerHTML = (COPY.memorySub || []).map(esc).join("<br />");

  // 徽章：旅程完成度
  const badge = $("memory-badge");
  if (badge) {
    const total = STOPS.length;
    const done = Math.min(state.unlocked.size, total);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const label =
      pct >= 100
        ? COPY.memoryBadgeDone || "旅程已全部点亮"
        : `已点亮 ${done} / ${total} 站`;
    badge.hidden = false;
    badge.innerHTML = `<span>${pct}%</span>${esc(label)}`;
  }

  // 回忆册：按天收录有照片 / 视频的每一站
  const scroll = $("memory-scroll");
  if (!scroll) return;
  const withMedia = STOPS.filter(
    (s) => (s.gallery && s.gallery.length) || (s.videos && s.videos.length),
  );
  if (withMedia.length === 0) {
    scroll.innerHTML = '<p class="memory-tail">还没有照片。<br />旅程结束后，回来看看这里。</p>';
    return;
  }
  scroll.innerHTML =
    withMedia
      .map((stop, sectionIndex) => {
        const cards = [];
        (stop.gallery || []).forEach((src, i) => {
          cards.push(`<figure class="photo-card">
            <img src="${esc(src)}" alt="${esc(stop.title)}照片 ${i + 1}" loading="lazy" />
            <figcaption>${esc((stop.galleryCaption && stop.galleryCaption[i]) || "")}</figcaption>
          </figure>`);
        });
        (stop.videos || []).forEach((video) => {
          cards.push(`<figure class="real-photo-card real-video-card">
            <video src="${esc(video.src)}" poster="${esc(video.poster || "")}" controls
              playsinline preload="none"></video>
            <figcaption>${esc(video.caption || "")}</figcaption>
          </figure>`);
        });
        return `<section class="memory-day" aria-label="第 ${stop.day} 天">
          <div class="memory-day-head">
            <span class="day-badge">${esc(dayLabel(stop.day))}</span>
            <h3>${esc(stop.title)}</h3>
            <p>${esc(stop.short || "")}</p>
          </div>
          <div class="photo-grid">${cards.join("")}</div>
        </section>${sectionIndex === withMedia.length - 1 ? "" : ""}`;
      })
      .join("") +
    `<p class="memory-tail">${(COPY.memoryTail || []).map(esc).join("<br />")}</p>`;
}

/* ---------- 地图 ---------- */

function renderMap() {
  const markers = $("map-markers");
  markers.innerHTML = "";

  STOPS.forEach((stop, index) => {
    const pos = MAP_POSITIONS[index];
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "map-marker";
    marker.dataset.index = String(index);
    marker.style.left = `${pos.x}%`;
    marker.style.top = `${pos.y}%`;
    marker.setAttribute("aria-label", `${stop.title}${isUnlocked(index) ? "" : "（未解锁）"}`);

    if (!isUnlocked(index)) marker.classList.add("is-locked");
    if (index === state.current) marker.classList.add("is-current");
    if (isUnlocked(index) && index < state.current) marker.classList.add("is-done");
    marker.classList.add(`day-${stop.day}`);
    // 标记样式：pin 图钉 / card 卡片（config.map.markerStyle）
    marker.classList.add(
      (MAP_CFG.markerStyle || "card") === "pin" ? "marker-pin" : "marker-card",
    );

    marker.innerHTML = `
      <span class="marker-day">${esc(dayLabel(stop.day))}</span>
      <span class="marker-icon">${iconHtml(stop.icon)}</span>
      <span class="marker-name">${esc(stop.title)}</span>
    `;

    marker.addEventListener("click", () => openStop(index));
    markers.appendChild(marker);
  });

  $("route-path").setAttribute("d", routePath());

  const couple = $("map-couple");
  const avatars = Array.isArray(HERO.avatars) ? HERO.avatars : [];
  const currentPos = MAP_POSITIONS[state.current];
  if (avatars.length > 0) {
    couple.style.display = "";
    couple.style.left = `${currentPos.x}%`;
    couple.style.top = `${currentPos.y}%`;
    couple.innerHTML = avatars
      .slice(0, 2)
      .map((src) => `<img src="${esc(src)}" alt="" />`)
      .join("");
    lastMapIndex = state.current;
  } else {
    couple.style.display = "none";
  }

  const stop = STOPS[state.current];
  text("map-day-label", `${esc(dayLabel(stop.day))} · 第 ${state.current + 1} 站`);
  text("map-current-title", stop.title);
  text("map-current-note", stop.short);
  text("map-progress", `已点亮 ${state.unlocked.size} / ${STOPS.length} 站`);
  text(
    "map-action-btn",
    stop.opensFinale && isUnlocked(STOPS.length - 1) ? "打开最后的惊喜" : `进入${stop.title}`,
  );
}

/* ---------- 章节 ---------- */

function renderChapter(index) {
  const stop = STOPS[index];
  const image = $("chapter-img");
  image.src = stop.image;
  image.alt = `${stop.title}场景`;
  text("chapter-index", `${pad(index + 1)} / ${pad(STOPS.length)}`);
  text("chapter-scene-day", `DAY ${stop.day}`);
  $("chapter-scene-day").dataset.day = String(stop.day);
  text("chapter-day", `DAY ${stop.day} · ${stop.title}`);
  text("chapter-title", stop.title);
  text("chapter-short", stop.short);

  const place = $("chapter-place");
  if (stop.place) {
    place.hidden = false;
    text("chapter-place", stop.place);
  } else {
    place.hidden = true;
  }

  const story = $("chapter-story");
  story.innerHTML = (stop.story || [])
    .map((line, i) => `<p style="--i:${i}">${esc(line)}</p>`)
    .join("");

  text("chapter-mood", stop.mood);

  const task = $("chapter-task");
  if (stop.task) {
    task.hidden = false;
    task.innerHTML = `<span class="task-icon">📷</span><span>${esc(stop.task)}</span>`;
  } else {
    task.hidden = true;
  }

  const hint = $("chapter-hint");
  if (stop.hint) {
    hint.hidden = false;
    hint.innerHTML = `<span class="hint-icon">🎟️</span><span>${esc(stop.hint)}</span>`;
  } else {
    hint.hidden = true;
  }

  text("chapter-next-btn", stop.action || "继续旅程");

  const diceCard = $("dice-card");
  if (stop.hint) {
    diceCard.hidden = false;
    renderDiceState(stop.id);
  } else {
    diceCard.hidden = true;
  }

  const gallery = $("real-gallery");
  const grid = $("real-photo-grid");
  const hasPhotos = stop.gallery && stop.gallery.length > 0;
  const hasVideos = stop.videos && stop.videos.length > 0;
  gallery.hidden = !(hasPhotos || hasVideos);
  grid.innerHTML = "";

  if (hasPhotos) {
    grid.innerHTML += stop.gallery
      .map(
        (src, i) => `
          <figure class="real-photo-card">
            <img src="${esc(src)}" alt="${esc(stop.title)}照片 ${i + 1}" loading="lazy" />
            <figcaption>${esc((stop.galleryCaption && stop.galleryCaption[i]) || "")}</figcaption>
          </figure>
        `,
      )
      .join("");
  }

  if (hasVideos) {
    grid.innerHTML += stop.videos
      .map(
        (video) => `
          <figure class="real-photo-card real-video-card">
            <video src="${esc(video.src)}" poster="${esc(video.poster || "")}" controls
              playsinline preload="none"></video>
            <figcaption>${esc(video.caption || "")}</figcaption>
          </figure>
        `,
      )
      .join("");
  }

  MusicBox.playFor("stop", stop);
}

/* ---------- 终章 ---------- */

function renderFinale() {
  const stop = STOPS[STOPS.length - 1];
  const story = $("finale-story");
  story.innerHTML = (stop.story || [])
    .map((line, i) => `<p style="--i:${i}">${esc(line)}</p>`)
    .join("");
  text("finale-name", HERO.name);
  text("finale-btn", state.finaleOpened ? "礼物就在你面前，慢慢打开吧" : stop.action);
  $("finale-note").hidden = !state.finaleOpened;
  MusicBox.playFor("finale");
}

/* ---------- 流程 ---------- */

function openStop(index) {
  if (!isUnlocked(index)) {
    showToast(COPY.lockedToast || "这一站还没到哦，先往前走一步吧。");
    return;
  }
  state.current = index;
  saveState();
  renderChapter(index);
  showView("chapter");
}

function animateCouple(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  const avatars = Array.isArray(HERO.avatars) ? HERO.avatars : [];
  if (avatars.length === 0) return;
  const couple = $("map-couple");
  const from = MAP_POSITIONS[fromIndex];
  const to = MAP_POSITIONS[toIndex];
  const walk = couple.animate(
    [
      { left: `${from.x}%`, top: `${from.y}%` },
      { left: `${to.x}%`, top: `${to.y}%` },
    ],
    { duration: 900, easing: "cubic-bezier(0.4, 0.1, 0.3, 1)" },
  );
  walk.onfinish = () => {
    couple.style.left = `${to.x}%`;
    couple.style.top = `${to.y}%`;
  };
}

function goNextFromChapter() {
  const fromIndex = state.current;
  const next = Math.min(state.current + 1, STOPS.length - 1);
  state.unlocked.add(next);
  state.current = next;
  saveState();

  if (STOPS[next].opensFinale) {
    renderChapter(next);
    showView("chapter");
    return;
  }

  renderMap();
  showView("map");
  animateCouple(fromIndex, next);
}

/* ================================================================
 * 音乐（浏览器内置合成，无需音频文件）
 * 每个「情绪主题」由 tempo + 和弦 + 音符序列构成。
 * config 里每站可以用 music 字段指定下面的任意主题。
 * ============================================================== */

const NOTE_FREQ = {
  C4: 261.63,
  Csharp4: 277.18,
  D4: 293.66,
  E4: 329.63,
  F4: 349.23,
  Fsharp4: 369.99,
  G4: 392.0,
  Gsharp4: 415.3,
  A4: 440.0,
  Bb4: 466.16,
  B4: 493.88,
  C5: 523.25,
  Csharp5: 554.37,
  D5: 587.33,
  E5: 659.25,
  F5: 698.46,
  Fsharp5: 739.99,
  G5: 783.99,
  Gsharp5: 830.61,
  A5: 880.0,
  B5: 987.77,
  C6: 1046.5,
  Csharp6: 1108.73,
  D6: 1174.66,
  E6: 1318.51,
  F6: 1396.91,
  G6: 1567.98,
  A6: 1760.0,
};

const MUSIC_THEMES = {
  cover: {
    tempo: 120,
    barBeats: 4,
    chords: [
      ["C4", "E4", "G4"],
      ["C4", "E4", "G4"],
      ["F4", "A4", "C5"],
      ["C4", "E4", "G4"],
      ["C4", "E4", "G4"],
      ["F4", "A4", "C5"],
      ["G4", "B4", "D5"],
      ["C4", "E4", "G4"],
    ],
    notes: [
      ["E5", 0.5], ["E5", 0.5], ["F5", 1], ["G5", 1],
      ["G5", 0.5], ["F5", 0.5], ["E5", 1], ["D5", 1],
      ["C5", 1], ["C5", 1], ["D5", 1], ["E5", 1],
      ["E5", 0.5], ["D5", 0.5], ["D5", 2],
      ["E5", 0.5], ["E5", 0.5], ["F5", 1], ["G5", 1],
      ["G5", 0.5], ["F5", 0.5], ["E5", 1], ["D5", 1],
      ["C5", 1], ["C5", 1], ["D5", 1], ["E5", 1],
      ["D5", 0.5], ["C5", 0.5], ["C5", 2],
    ],
  },
  map: {
    tempo: 132,
    barBeats: 4,
    chords: [
      ["A4", "C5", "E5"],
      ["E4", "Gsharp4", "B4"],
      ["A4", "C5", "E5"],
      ["E4", "Gsharp4", "B4"],
    ],
    notes: [
      ["B5", 0.5], ["B5", 0.5], ["B5", 0.5], ["B5", 0.5],
      ["C6", 1], ["B5", 0.5], ["A5", 0.5], ["G5", 1],
      ["A5", 0.5], ["B5", 0.5], ["G5", 1], ["E5", 0.5],
      ["F5", 0.5], ["G5", 0.5], ["A5", 0.5], ["B5", 0.5],
      ["G5", 0.5], ["E5", 0.5], ["F5", 0.5], ["D5", 2],
      ["B5", 0.5], ["B5", 0.5], ["B5", 0.5], ["B5", 0.5],
      ["C6", 1], ["B5", 0.5], ["A5", 0.5], ["G5", 1],
      ["A5", 0.5], ["B5", 0.5], ["G5", 1], ["E5", 0.5],
      ["F5", 0.5], ["G5", 0.5], ["A5", 0.5], ["B5", 0.5],
      ["G5", 0.5], ["E5", 0.5], ["F5", 0.5], ["D5", 2],
    ],
  },
  cinema: {
    tempo: 136,
    barBeats: 4,
    chords: [
      ["G4", "B4", "D5"],
      ["C4", "E4", "G4"],
      ["G4", "B4", "D5"],
      ["D4", "Fsharp4", "A4"],
    ],
    notes: [
      ["G5", 0.5], ["D5", 0.5], ["G5", 0.5], ["D5", 0.5],
      ["E5", 0.5], ["C5", 0.5], ["D5", 0.5], ["B4", 0.5],
      ["C5", 0.5], ["A4", 0.5], ["B4", 0.5], ["G4", 0.5],
      ["A4", 0.5], ["Fsharp4", 0.5], ["G4", 1],
      ["G5", 0.5], ["D5", 0.5], ["G5", 0.5], ["D5", 0.5],
      ["E5", 0.5], ["C5", 0.5], ["D5", 0.5], ["B4", 0.5],
      ["C5", 0.5], ["A4", 0.5], ["B4", 0.5], ["G4", 0.5],
      ["A4", 0.5], ["Fsharp4", 0.5], ["G4", 1],
    ],
  },
  hotpot: {
    tempo: 108,
    barBeats: 4,
    chords: [
      ["C4", "E4", "G4"],
      ["F4", "A4", "C5"],
      ["C4", "E4", "G4"],
      ["G4", "B4", "D5"],
    ],
    notes: [
      ["C5", 0.5], ["E5", 0.5], ["G5", 1], ["E5", 1], ["C5", 0.5], ["D5", 0.5], ["E5", 1],
      ["F5", 0.5], ["F5", 0.5], ["E5", 1], ["D5", 1], ["C5", 2],
      ["C5", 0.5], ["E5", 0.5], ["G5", 1], ["E5", 1], ["C5", 0.5], ["D5", 0.5], ["E5", 1],
      ["F5", 0.5], ["E5", 0.5], ["D5", 1], ["C5", 1], ["C5", 2],
    ],
  },
  craft: {
    tempo: 96,
    barBeats: 4,
    chords: [
      ["C4", "E4", "G4"],
      ["C4", "E4", "G4"],
      ["G4", "B4", "D5"],
      ["C4", "E4", "G4"],
    ],
    notes: [
      ["E5", 1], ["G5", 1], ["E5", 1], ["G5", 1],
      ["E5", 1], ["G5", 1], ["E5", 1], ["B5", 1],
      ["C6", 1], ["B5", 1], ["G5", 1], ["E5", 1],
      ["G5", 1], ["E5", 1], ["D5", 2],
      ["E5", 1], ["G5", 1], ["E5", 1], ["G5", 1],
      ["E5", 1], ["G5", 1], ["E5", 1], ["B5", 1],
      ["C6", 1], ["B5", 1], ["G5", 1], ["E5", 1],
      ["G5", 1], ["E5", 1], ["D5", 2],
    ],
  },
  depart: {
    tempo: 128,
    barBeats: 4,
    chords: [
      ["C4", "E4", "G4"],
      ["F4", "A4", "C5"],
      ["G4", "B4", "D5"],
      ["C4", "E4", "G4"],
    ],
    notes: [
      ["E5", 0.5], ["E5", 0.5], ["E5", 1], ["F5", 1],
      ["G5", 1], ["G5", 0.5], ["A5", 0.5], ["G5", 0.5], ["F5", 0.5],
      ["E5", 0.5], ["F5", 0.5], ["G5", 0.5], ["F5", 0.5], ["E5", 0.5], ["D5", 1],
      ["E5", 0.5], ["F5", 0.5], ["G5", 0.5], ["A5", 0.5], ["B5", 1],
      ["A5", 0.5], ["G5", 0.5], ["F5", 0.5], ["E5", 0.5], ["D5", 2],
    ],
  },
  spa: {
    tempo: 78,
    barBeats: 4,
    chords: [
      ["C4", "E4", "G4"],
      ["A3", "C4", "E4"],
      ["F4", "A4", "C5"],
      ["G4", "B4", "D5"],
    ],
    notes: [
      ["E5", 1.5], ["C5", 0.5], ["D5", 1], ["E5", 2],
      ["A5", 1.5], ["E5", 0.5], ["F5", 1], ["E5", 2],
      ["G5", 1.5], ["E5", 0.5], ["D5", 1], ["C5", 2],
      ["D5", 1], ["E5", 1], ["C5", 2],
    ],
  },
  boat: {
    tempo: 120,
    barBeats: 4,
    chords: [
      ["D4", "Fsharp4", "A4"],
      ["A4", "Csharp5", "E5"],
      ["D4", "Fsharp4", "A4"],
      ["A4", "Csharp5", "E5"],
    ],
    notes: [
      ["D5", 0.5], ["D5", 0.5], ["D5", 0.5], ["Fsharp5", 0.5],
      ["E5", 0.5], ["D5", 0.5], ["Csharp5", 0.5], ["D5", 0.5],
      ["E5", 0.5], ["Fsharp5", 0.5], ["G5", 0.5], ["A5", 0.5],
      ["G5", 0.5], ["Fsharp5", 0.5], ["E5", 0.5], ["D5", 0.5],
      ["Csharp5", 0.5], ["D5", 0.5], ["E5", 0.5], ["Fsharp5", 0.5],
      ["A5", 0.5], ["G5", 0.5], ["Fsharp5", 0.5], ["E5", 0.5],
      ["D5", 0.5], ["Csharp5", 0.5], ["D5", 1], ["Fsharp5", 1],
      ["D5", 1], ["A5", 1], ["Fsharp5", 0.5], ["E5", 0.5], ["D5", 2],
    ],
  },
  bonfire: {
    tempo: 124,
    barBeats: 4,
    chords: [
      ["F4", "A4", "C5"],
      ["C4", "E4", "G4"],
      ["D4", "Fsharp4", "A4"],
      ["G4", "B4", "D5"],
    ],
    notes: [
      ["F5", 0.5], ["A5", 0.5], ["C6", 1], ["A5", 0.5], ["F5", 0.5], ["G5", 1],
      ["E5", 0.5], ["G5", 0.5], ["C6", 1], ["A5", 1], ["F5", 0.5], ["E5", 0.5], ["D5", 1],
      ["D5", 0.5], ["Fsharp5", 0.5], ["A5", 1], ["Fsharp5", 0.5], ["D5", 0.5], ["E5", 1],
      ["G5", 0.5], ["B5", 0.5], ["D6", 1], ["B5", 1], ["G5", 2],
    ],
  },
  return: {
    tempo: 100,
    barBeats: 4,
    chords: [
      ["G4", "B4", "D5"],
      ["C4", "E4", "G4"],
      ["A4", "Csharp5", "E5"],
      ["D4", "Fsharp4", "A4"],
    ],
    notes: [
      ["D5", 1], ["B4", 0.5], ["G4", 0.5], ["A4", 1], ["B4", 1],
      ["C5", 1], ["G4", 0.5], ["E4", 0.5], ["Fsharp4", 1], ["G4", 1],
      ["A4", 1], ["E5", 1], ["Csharp5", 0.5], ["A4", 0.5], ["Fsharp4", 1],
      ["D5", 1], ["A4", 1], ["D4", 1], ["D4", 1],
    ],
  },
  gift: {
    tempo: 86,
    barBeats: 4,
    chords: [
      ["C4", "E4", "G4"],
      ["A3", "C4", "E4"],
      ["F4", "A4", "C5"],
      ["G4", "B4", "D5"],
    ],
    notes: [
      ["C5", 1.5], ["E5", 0.5], ["G5", 1], ["E5", 2],
      ["A5", 1.5], ["E5", 0.5], ["F5", 1], ["E5", 2],
      ["G5", 1.5], ["E5", 0.5], ["D5", 1], ["C5", 2],
      ["D5", 1], ["E5", 1], ["C5", 2],
    ],
  },
  resort: {
    tempo: 96,
    barBeats: 3,
    chords: [
      ["C4", "E4", "G4"],
      ["F4", "A4", "C5"],
      ["C4", "E4", "G4"],
      ["G4", "B4", "D5"],
    ],
    notes: [
      ["C5", 1], ["E5", 0.5], ["G5", 0.5], ["E5", 1],
      ["F5", 1], ["E5", 0.5], ["D5", 0.5], ["C5", 2],
      ["G5", 1], ["A5", 1], ["G5", 1], ["E5", 1],
      ["D5", 1], ["E5", 1], ["C5", 2],
    ],
  },
  omakase: {
    tempo: 92,
    barBeats: 4,
    chords: [
      ["C4", "E4", "G4"],
      ["F4", "A4", "C5"],
      ["G4", "B4", "D5"],
      ["C4", "E4", "G4"],
    ],
    notes: [
      ["G5", 1], ["A5", 1], ["G5", 1], ["E5", 1],
      ["F5", 1], ["E5", 1], ["D5", 1], ["C5", 1],
      ["E5", 1], ["G5", 1], ["B5", 1], ["A5", 1],
      ["G5", 2], ["E5", 1], ["C5", 1],
    ],
  },
  dinner: {
    tempo: 96,
    barBeats: 3,
    chords: [
      ["D4", "Fsharp4", "A4"],
      ["A4", "Csharp5", "E5"],
      ["B4", "D5", "Fsharp5"],
      ["Fsharp4", "A4", "Csharp5"],
      ["G4", "B4", "D5"],
      ["G4", "B4", "D5"],
      ["A4", "Csharp5", "E5"],
      ["A4", "Csharp5", "E5"],
    ],
    notes: [
      ["D4", 0.5], ["Fsharp4", 0.5], ["A4", 0.5], ["D5", 0.5], ["A4", 0.5], ["Fsharp4", 0.5],
      ["A4", 0.5], ["Csharp5", 0.5], ["E5", 0.5], ["A5", 0.5], ["E5", 0.5], ["Csharp5", 0.5],
      ["B4", 0.5], ["D5", 0.5], ["Fsharp5", 0.5], ["B5", 0.5], ["Fsharp5", 0.5], ["D5", 0.5],
      ["Fsharp4", 0.5], ["A4", 0.5], ["Csharp5", 0.5], ["Fsharp5", 0.5], ["Csharp5", 0.5], ["A4", 0.5],
      ["G4", 0.5], ["B4", 0.5], ["D5", 0.5], ["G5", 0.5], ["D5", 0.5], ["B4", 0.5],
      ["G4", 0.5], ["B4", 0.5], ["D5", 0.5], ["G5", 0.5], ["D5", 0.5], ["B4", 0.5],
      ["A4", 0.5], ["Csharp5", 0.5], ["E5", 0.5], ["A5", 0.5], ["E5", 0.5], ["Csharp5", 0.5],
      ["A4", 0.5], ["Csharp5", 0.5], ["E5", 0.5], ["A5", 0.5], ["E5", 0.5], ["Csharp5", 0.5],
    ],
  },
  finale: {
    tempo: 108,
    barBeats: 3,
    chords: [
      ["C4", "E4", "G4"],
      ["F4", "A4", "C5"],
      ["C4", "E4", "G4"],
      ["G4", "B4", "D5"],
      ["C4", "E4", "G4"],
      ["F4", "A4", "C5"],
      ["C4", "E4", "G4"],
      ["G4", "B4", "D5"],
    ],
    notes: [
      ["G4", 0.5], ["G4", 0.5], ["A4", 1], ["G4", 1], ["C5", 1], ["B4", 2],
      ["G4", 0.5], ["G4", 0.5], ["A4", 1], ["G4", 1], ["D5", 1], ["C5", 2],
      ["G4", 0.5], ["G4", 0.5], ["G5", 1], ["E5", 1], ["C5", 1], ["B4", 1], ["A4", 2],
      ["F5", 0.5], ["F5", 0.5], ["E5", 1], ["C5", 1], ["D5", 1], ["C5", 2],
    ],
  },
  memory: {
    tempo: 92,
    barBeats: 4,
    chords: [
      ["C4", "E4", "G4"],
      ["C4", "F4", "A4"],
      ["C4", "E4", "G4"],
      ["G4", "B4", "D5"],
    ],
    notes: [
      ["C5", 1], ["C5", 1], ["G5", 1], ["G5", 1],
      ["A5", 1], ["A5", 1], ["G5", 2],
      ["F5", 1], ["F5", 1], ["E5", 1], ["E5", 1],
      ["D5", 1], ["D5", 1], ["C5", 2],
      ["G5", 1], ["G5", 1], ["F5", 1], ["F5", 1],
      ["E5", 1], ["E5", 1], ["D5", 2],
      ["G5", 1], ["G5", 1], ["F5", 1], ["F5", 1],
      ["E5", 1], ["E5", 1], ["D5", 2],
      ["C5", 1], ["C5", 1], ["G5", 1], ["G5", 1],
      ["A5", 1], ["A5", 1], ["G5", 2],
      ["F5", 1], ["F5", 1], ["E5", 1], ["E5", 1],
      ["D5", 1], ["D5", 1], ["C5", 2],
    ],
  },
};

const DICE_LAYOUT = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

const DICE_WIN_PARITY = "odd"; // "odd" => 1,3,5 中奖；改成 "even" 则 2,4,6 中奖

function diceWins(value) {
  if (DICE_WIN_PARITY === "even") return value % 2 === 0;
  return value % 2 === 1;
}

function drawDie(value) {
  const die = $("die");
  const on = DICE_LAYOUT[value] || [];
  die.innerHTML = Array.from(
    { length: 9 },
    (_, index) =>
      `<span class="die-pip${on.includes(index) ? " is-on" : ""}"></span>`,
  ).join("");
}

function renderDiceState(stopId) {
  const won = state.diceWon[stopId];
  const btn = $("dice-btn");
  const result = $("dice-result");
  if (won) {
    drawDie(won.value);
    btn.disabled = true;
    btn.textContent = "已获得机会券";
    result.hidden = false;
    result.innerHTML =
      `摇到 ${won.value} 点，获得一张机会券 🎟️<br />` +
      '<span class="ticket-chip">多拆一次礼物 · BONUS</span>';
  } else {
    drawDie(6);
    btn.disabled = false;
    btn.textContent = "摇骰子";
    result.hidden = true;
    result.innerHTML = "";
  }
}

function rollDice() {
  const stop = STOPS[state.current];
  if (!stop || !stop.hint || state.diceWon[stop.id]) return;

  const die = $("die");
  const btn = $("dice-btn");
  btn.disabled = true;
  die.classList.add("is-rolling");

  let spins = 0;
  const timer = setInterval(() => {
    drawDie(1 + Math.floor(Math.random() * 6));
    spins += 1;
    if (spins >= 9) {
      clearInterval(timer);
      die.classList.remove("is-rolling");
      const value = 1 + Math.floor(Math.random() * 6);
      drawDie(value);
      if (diceWins(value)) {
        state.diceWon[stop.id] = { value };
        saveState();
        renderDiceState(stop.id);
        showToast("🎟️ 获得一张机会券！");
      } else {
        btn.disabled = false;
        btn.textContent = "再摇一次";
        const result = $("dice-result");
        result.hidden = false;
        result.textContent = `摇到 ${value} 点，这次差一点，再试一次吧`;
      }
    }
  }, 90);
}

/* ---------- 音乐配置：自定义音源（文件/外链）+ 内置合成旋律 ---------- */

const MUSIC_CFG = CFG.music || {};
/* 一个「音源引用」：内置素材 m:assets/... / 用户上传 u:xxx / 外链 https://… / dataURL */
const MUSIC_REF_RE = /^(m:|u:|https?:|data:|blob:)/;

function musicIsRef(v) {
  return typeof v === "string" && MUSIC_REF_RE.test(v);
}

function musicUrl(ref) {
  return ref.startsWith("m:") ? ref.slice(2) : ref;
}

/* 三层优先级：站点级 > 页面级 > 主题级 > 内置默认
 * 站点级：stop.music —— 字符串（内置主题名，或 m:/https/dataURL 音源）或 { src, theme, volume }
 * 页面级：config.music.pages  —— { cover, map, memory, finale }
 * 主题级：config.music.themes —— { seaside, forest, starry, newlywed, christmas } */
function resolveMusic(kind, stop, cfgOverride) {
  const C = cfgOverride || MUSIC_CFG;
  const pages = C.pages || {};
  const themes = C.themes || {};
  const asConf = (v, fallbackTheme) => {
    if (musicIsRef(v)) return { src: v };
    if (typeof v === "string" && v) return { theme: v };
    return { theme: fallbackTheme };
  };

  if (stop && stop.music) {
    const m = stop.music;
    if (m && typeof m === "object") {
      if (m.src && musicIsRef(m.src)) return { src: m.src, volume: m.volume };
      if (m.theme) return { theme: m.theme, volume: m.volume };
    } else if (typeof m === "string") {
      return asConf(m, stop.id);
    }
  }
  if (pages[kind]) return asConf(pages[kind], kind);
  if (themes[THEME_ID]) return asConf(themes[THEME_ID], kind);
  return { theme: stop ? stop.id : kind };
}

const MusicBox = (() => {
  let ctx = null;
  let timer = null;
  let step = 0;
  let beatPosition = 0;
  let currentThemeId = "cover";
  let theme = MUSIC_THEMES[currentThemeId];
  let delayNode = null;
  let master = null; // 合成通道总音量（用于淡入淡出）
  let synthFade = null;

  /* 音频文件通道（自定义音乐）：单例 audio 元素，循环播放 */
  let audioEl = null;
  let currentAudioSrc = "";
  let audioFade = null;
  let wantPlaying = false; // 用户是否已经打开音乐（点击按钮后为 true）
  let lastKind = "cover";
  let lastStop = null;
  const fadeMs = Number(MUSIC_CFG.fadeMs) >= 0 ? Number(MUSIC_CFG.fadeMs) : 600;
  const baseVolume =
    typeof MUSIC_CFG.volume === "number" ? Math.max(0, Math.min(1, MUSIC_CFG.volume)) : 1;

  function ensureContext() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0;
        master.connect(ctx.destination);
        delayNode = ctx.createDelay(1);
        delayNode.delayTime.value = 0.26;
        const feedback = ctx.createGain();
        feedback.gain.value = 0.24;
        const wet = ctx.createGain();
        wet.gain.value = 0.22;
        delayNode.connect(feedback);
        feedback.connect(delayNode);
        delayNode.connect(wet);
        wet.connect(master);
      }
    }
    return ctx;
  }

  function playNote(freq, time, dur, vol, type) {
    if (!freq) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(vol || 0.1, time + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
    osc.connect(gain);
    gain.connect(master || ctx.destination);
    if (delayNode) gain.connect(delayNode);
    osc.start(time);
    osc.stop(time + dur + 0.08);
  }

  function playChord(chordNotes, time, dur, vol) {
    chordNotes.forEach((note) => playNote(NOTE_FREQ[note], time, dur, vol, "triangle"));
  }

  function tick() {
    if (!ctx || ctx.state === "suspended") return;
    const index = step % theme.notes.length;
    const [note, beats] = theme.notes[index];
    const beatMs = 60000 / theme.tempo;
    const now = ctx.currentTime + 0.03;

    playNote(NOTE_FREQ[note], now, Math.min(1.6, beats * 0.5), 0.11, "sine");

    const chordIndex =
      Math.floor(beatPosition / theme.barBeats) % theme.chords.length;
    if (Math.abs(beatPosition % theme.barBeats) < 0.001) {
      playChord(theme.chords[chordIndex], now, 2.2, 0.035);
    }

    beatPosition += beats;
    step += 1;
    timer = window.setTimeout(tick, beats * beatMs);
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /* ---------- 音量淡入淡出 ---------- */

  function fadeSynthTo(target, ms) {
    if (synthFade) {
      clearInterval(synthFade);
      synthFade = null;
    }
    if (!master) return;
    const from = master.gain.value;
    if (!ms) {
      master.gain.value = target;
      return;
    }
    const t0 = Date.now();
    synthFade = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / ms);
      master.gain.value = from + (target - from) * k;
      if (k >= 1) {
        clearInterval(synthFade);
        synthFade = null;
      }
    }, 30);
  }

  function fadeAudioTo(target, ms, done) {
    if (audioFade) {
      clearInterval(audioFade);
      audioFade = null;
    }
    if (!audioEl) {
      if (done) done();
      return;
    }
    const from = audioEl.volume;
    const t = Math.max(0, Math.min(1, target));
    if (!ms) {
      audioEl.volume = t;
      if (done) done();
      return;
    }
    const t0 = Date.now();
    audioFade = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / ms);
      audioEl.volume = Math.max(0, Math.min(1, from + (t - from) * k));
      if (k >= 1) {
        clearInterval(audioFade);
        audioFade = null;
        if (done) done();
      }
    }, 30);
  }

  /* ---------- 音频文件通道（自定义音源） ---------- */

  function ensureAudio() {
    if (audioEl) return audioEl;
    audioEl = new Audio();
    audioEl.loop = true;
    audioEl.preload = "auto";
    audioEl.volume = 0;
    audioEl.addEventListener("error", () => {
      // 音源加载失败：静默回退内置合成旋律，不打断体验
      currentAudioSrc = "";
      const fallback = resolveMusic(lastKind, lastStop);
      setThemeNow(fallback.theme || "cover");
      if (wantPlaying) startSynth();
      syncMusicButtons();
    });
    return audioEl;
  }

  function playFile(src, volume) {
    const el = ensureAudio();
    const switched = currentAudioSrc !== src;
    const target = Math.max(
      0,
      Math.min(1, baseVolume * (typeof volume === "number" ? volume : 1)),
    );
    if (switched) {
      currentAudioSrc = src;
      el.src = musicUrl(src);
      el.volume = 0;
    }
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    fadeAudioTo(target, switched ? Math.min(fadeMs, 400) : fadeMs);
  }

  function stopFile(ms, done) {
    if (!audioEl || !currentAudioSrc) {
      if (done) done();
      return;
    }
    const el = audioEl;
    fadeAudioTo(0, ms, () => {
      el.pause();
      currentAudioSrc = "";
      if (done) done();
    });
  }

  function setThemeNow(id) {
    const next = MUSIC_THEMES[id] || MUSIC_THEMES.cover;
    if (id === currentThemeId) return;
    currentThemeId = id;
    theme = next;
    step = 0;
    beatPosition = 0;
    if (timer) {
      stop();
      tick();
    }
  }

  function startSynth() {
    if (!ensureContext()) return;
    if (ctx.state === "suspended") ctx.resume();
    if (timer) return;
    master.gain.value = 0;
    fadeSynthTo(1, fadeMs);
    tick();
  }

  function stopSynth(ms) {
    if (!timer) {
      if (master) master.gain.value = 0;
      return;
    }
    const t = timer;
    timer = null;
    fadeSynthTo(0, ms);
    window.setTimeout(() => {
      if (!timer || timer === t) clearTimeout(t);
    }, (ms || 0) + 80);
  }

  /* 应用一份音乐配置：有自定义音源走文件通道，否则回退内置合成 */
  function apply(conf) {
    if (!wantPlaying) return;
    if (conf.src) {
      stopSynth(Math.min(fadeMs, 400));
      playFile(conf.src, conf.volume);
      return;
    }
    stopFile(Math.min(fadeMs, 300));
    setThemeNow(conf.theme || "cover");
    startSynth();
  }

  return {
    /* 统一入口：kind = cover | map | memory | finale | stop（站点传 stop 对象） */
    playFor(kind, stop) {
      lastKind = kind;
      lastStop = stop || null;
      const conf = resolveMusic(kind, stop);
      conf.kind = kind;
      if (!wantPlaying) return; // 用户还没打开音乐：仅记录配置，等点击按钮
      apply(conf);
    },
    toggle() {
      if (wantPlaying) {
        wantPlaying = false;
        stopSynth(fadeMs);
        stopFile(fadeMs);
      } else {
        wantPlaying = true;
        const conf = resolveMusic(lastKind, lastStop);
        apply(conf);
      }
      syncMusicButtons();
      return wantPlaying;
    },
    get playing() {
      return wantPlaying;
    },
    get themeId() {
      return currentThemeId;
    },
  };
})();

function syncMusicButtons() {
  const btn = $("music-toggle");
  const icon = MusicBox.playing ? "♫" : "♪";
  btn.querySelector(".music-icon").textContent = icon;
  btn.classList.toggle("is-playing", MusicBox.playing);
  btn.setAttribute("aria-label", MusicBox.playing ? "关闭音乐" : "打开音乐");
  btn.title = MusicBox.playing ? "关闭音乐" : "打开音乐";
}

function bindEvents() {
  $("start-btn").addEventListener("click", () => {
    renderMap();
    showView("map");
  });

  $("map-action-btn").addEventListener("click", () => openStop(state.current));

  $("chapter-back-btn").addEventListener("click", () => {
    renderMap();
    showView("map");
  });

  $("chapter-map-btn").addEventListener("click", () => {
    renderMap();
    showView("map");
  });

  $("chapter-next-btn").addEventListener("click", () => {
    if (STOPS[state.current].opensFinale) {
      renderFinale();
      showView("finale");
      return;
    }
    goNextFromChapter();
  });

  $("music-toggle").addEventListener("click", () => MusicBox.toggle());
  $("dice-btn").addEventListener("click", rollDice);

  $("finale-btn").addEventListener("click", () => {
    state.finaleOpened = true;
    saveState();
    renderFinale();
    showToast(COPY.finaleHint || "接下来的惊喜，不在屏幕里。");
  });

  $("memory-link").addEventListener("click", () => showView("memory"));
  $("cover-memory-link").addEventListener("click", () => showView("memory"));
  $("map-memory-link").addEventListener("click", () => showView("memory"));
  $("map-home-btn").addEventListener("click", () => {
    showView("cover");
    MusicBox.playFor("cover");
  });
  $("memory-back-btn").addEventListener("click", () => {
    renderMap();
    showView("map");
  });
}

loadState();
renderStatic();
renderMap();
bindEvents();

const initialView = params.get("view") || "cover";
if (initialView === "map") {
  showView("map");
} else if (initialView === "finale" && isPreview) {
  renderFinale();
  showView("finale");
} else if (initialView === "memory") {
  showView("memory");
} else if (initialView === "chapter" && isPreview) {
  const stopIndex = Math.min(
    Math.max(Number(params.get("stop")) || 0, 0),
    STOPS.length - 2,
  );
  state.current = stopIndex;
  renderChapter(stopIndex);
  showView("chapter");
} else {
  showView("cover");
}

window.addEventListener("error", (event) => {
  window.__tripErrors = window.__tripErrors || [];
  window.__tripErrors.push(event.message || "unknown error");
});

if (params.get("selftest") === "1") {
  window.addEventListener("load", () => {
    const active = document.querySelector(".screen.is-active");
    const mapWrap = document.querySelector(".map-wrap");
    const markers = Array.from(document.querySelectorAll(".map-marker"));
    const centers = markers.map((marker) => {
      const rect = marker.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    let minGap = Infinity;
    for (let i = 0; i < centers.length; i += 1) {
      for (let j = i + 1; j < centers.length; j += 1) {
        const dx = centers[i].x - centers[j].x;
        const dy = centers[i].y - centers[j].y;
        minGap = Math.min(minGap, Math.hypot(dx, dy));
      }
    }
    const wrapRect = mapWrap ? mapWrap.getBoundingClientRect() : null;
    const outOfBounds = markers.filter((marker) => {
      const rect = marker.getBoundingClientRect();
      return (
        rect.left < wrapRect.left - 8 ||
        rect.right > wrapRect.right + 8 ||
        rect.top < wrapRect.top - 8 ||
        rect.bottom > wrapRect.bottom + 8
      );
    }).length;
    const report = {
      active: active ? active.id : null,
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      markers: markers.length,
      minMarkerGap: Math.round(minGap === Infinity ? -1 : minGap),
      outOfBoundsMarkers: outOfBounds,
      imagesLoaded: Array.from(document.images)
        .filter((img) => img.getAttribute("src"))
        .every((img) => img.complete && img.naturalWidth > 0),
      /* 音乐三层优先级（站点级 > 页面级 > 主题级 > 内置默认） */
      music: (() => {
        try {
          const fake = {
            pages: { cover: "https://example.com/a.mp3", map: "cover" },
            themes: { [THEME_ID]: "m:assets/music/builtin.mp3" },
          };
          const pageRef = resolveMusic("cover", null, fake);
          const pageThemeName = resolveMusic("map", null, fake);
          const themeFallback = resolveMusic("memory", null, fake);
          const stopThemeName = resolveMusic("stop", { id: "s1", music: "craft" }, fake);
          const stopObject = resolveMusic("stop", { id: "s2", music: { src: "u:abc" } }, fake);
          const stopWins = resolveMusic("cover", { id: "s3", music: "u:xyz" }, fake);
          const ok =
            pageRef.src === "https://example.com/a.mp3" &&
            pageThemeName.theme === "cover" &&
            themeFallback.src === "m:assets/music/builtin.mp3" &&
            stopThemeName.theme === "craft" &&
            stopObject.src === "u:abc" &&
            stopWins.src === "u:xyz";
          return { ok, themeFallback: themeFallback.src, stopWins: stopWins.src };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      })(),
      errors: window.__tripErrors || [],
    };
    const el = document.createElement("pre");
    el.id = "selftest-report";
    el.textContent = JSON.stringify(report);
    document.body.appendChild(el);
  });
}
