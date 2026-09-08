/*
 * builder.js —— 制作向导主逻辑
 *
 * 五个步骤：开始 → 主角与封面 → 行程与文案 → AI 助手 → 预览与导出
 *
 * 数据模型：一份「草稿」（draft），字段与成品 config.js 对齐：
 *   draft.uid / page / hero / copy / dayDates / days / stops[] / map
 * 图片引用（ref）：
 *   "m:assets/..."  内置示例素材（template.inline.js 里的 dataURL）
 *   "u:xxxxx"       用户上传的照片（存在浏览器 IndexedDB）
 *   其它             原样（http/dataURL/相对路径）
 * 草稿自动保存在 localStorage；照片保存在 IndexedDB——全部在本机，不上传。
 */

"use strict";

const SRC = window.TEMPLATE_SRC;
const LS_DRAFT = "trip-builder-draft-v1";
const LS_AI_KEY = "trip-builder-ai-key";
const LS_AI_BASE = "trip-builder-ai-base";
const LS_AI_MODEL = "trip-builder-ai-model";

const STEPS = [
  { id: "welcome", label: "开始" },
  { id: "basic", label: "主角与封面" },
  { id: "stops", label: "行程与文案" },
  { id: "assist", label: "AI 助手" },
  { id: "preview", label: "预览与导出" },
];

const AI_DEFAULT_BASE = "https://api.deepseek.com";
const AI_DEFAULT_MODEL = "deepseek-chat";
const AI_IMAGE_CHOICES = [
  "ai-craft",
  "ai-cinema",
  "ai-depart",
  "ai-resort",
  "ai-bonfire",
  "ai-omakase",
];

/* ================================================================
 * 小工具
 * ============================================================== */

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function uid() {
  return (
    "d_" +
    (window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2))
  );
}

function cssId(path) {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 300);
}

function toast(message) {
  const el = $("b-toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2400);
}

function mediaKeysOf(folder) {
  return Object.keys(SRC.media)
    .filter((k) => k.startsWith(folder))
    .sort();
}

function mediaLabel(key) {
  const base = key.split("/").pop();
  return base.replace(/\.(webp|png|jpg|jpeg|svg)$/i, "");
}

/* ================================================================
 * 草稿
 * ============================================================== */

const state = {
  step: 0,
  draft: null,
  stopOpen: new Set(),
  uiPhotoCache: {}, // u:id → dataURL（缩略图缓存）
  aiMessages: [],
  lastAiJson: null,
  calibOpen: false, // 地图站点校准面板是否展开
};

function loadDraft() {
  try {
    const raw = localStorage.getItem(LS_DRAFT);
    if (raw) state.draft = JSON.parse(raw);
  } catch (err) {
    state.draft = null;
  }
}

function saveDraft() {
  if (!state.draft) return;
  try {
    localStorage.setItem(LS_DRAFT, JSON.stringify(state.draft));
  } catch (err) {
    // 常见原因：照片占满了 localStorage（浏览器只给约 5MB），草稿写不进去
    toast(
      "草稿保存失败：本浏览器本地空间已满（照片占用过多或浏览器限制存储）。建议：删几张照片，或用 Chrome / Edge 打开本页",
    );
  }
}

/* 把成品 config（对象）转成草稿（路径引用 → ref） */
function cfgToDraft(cfg) {
  const media = SRC.media;
  const toRef = (value) =>
    typeof value === "string" && media[value] ? "m:" + value : value;
  const draft = clone(cfg);
  draft.uid = cfg.uid || uid();
  if (!["seaside", "forest", "starry", "newlywed", "christmas"].includes(draft.theme)) draft.theme = "seaside";
  const days = [...new Set((cfg.stops || []).map((s) => s.day))];
  draft.days = days.length ? Math.max(...days) : 3;
  draft.page = draft.page || {};
  draft.page.ogImage = toRef(draft.page.ogImage);
  draft.hero = draft.hero || {};
  draft.hero.coverImage = toRef(draft.hero.coverImage);
  draft.hero.avatars = (draft.hero.avatars || []).map(toRef);
  draft.map = draft.map || {};
  draft.map.background = toRef(draft.map.background);
  if (!["pin", "card"].includes(draft.map.markerStyle)) draft.map.markerStyle = "pin";
  (draft.stops || []).forEach((stop) => {
    stop.image = toRef(stop.image);
    stop.icon = toRef(stop.icon);
    stop.iconRefs = (stop.iconRefs || []).map(toRef); // 贴纸收藏
    stop.imageRefs = (stop.imageRefs || []).map(toRef); // 章节大图图库
    stop.gallery = (stop.gallery || []).map(toRef);
    (stop.videos || []).forEach((v) => {
      v.src = toRef(v.src);
      v.poster = toRef(v.poster);
    });
  });
  return draft;
}

/* 从示例 config.js 生成一份「从示例开始」的草稿 */
function sampleDraft() {
  try {
    const fn = new Function(SRC.config + "\nreturn window.TRIP_CONFIG;");
    const cfg = fn();
    return cfgToDraft(cfg);
  } catch (err) {
    console.error("解析示例配置失败", err);
    return blankDraft();
  }
}

/* 成品风格主题 */
const THEMES = [
  { id: "seaside", label: "海边暖沙", note: "奶油粉与暖沙，海风一样轻", swatch: ["#f7c9cf", "#e58b9e", "#4f9aa0"], mapBg: "m:assets/map/map-seaside.webp" },
  { id: "forest", label: "森林", note: "树屋茶屋与溪桥篝火，鼠尾草绿与焦糖", swatch: ["#dfe8d2", "#8aa668", "#5e9277"], mapBg: "m:assets/map/map-forest.jpg" },
  { id: "starry", label: "星光夜", note: "观星丘与月光码头，薰衣草紫与星光金", swatch: ["#ddd2f1", "#8d7cc9", "#e0c190"], mapBg: "m:assets/map/map-starry.jpg" },
  { id: "newlywed", label: "新婚燕尔", note: "香槟金与暖白，白纱、花亭与清晨的光", swatch: ["#f6dccc", "#d9a869", "#8fae9e"], mapBg: "m:assets/map/map-honeymoon.jpg" },
  { id: "christmas", label: "圣诞颂歌", note: "雪夜小屋与暖窗，松针绿与红金灯", swatch: ["#dde8e3", "#a23b48", "#5c8f7f"], mapBg: "m:assets/map/map-christmas.jpg" },
];

/* 成对小人套装：点一套 → 同时填两位小人（封面落款 + 地图上沿路线走的主角） */
const AVATAR_SETS = [
  { id: "prince-princess", label: "原版 · 小王子与小公主", keys: ["assets/avatars/prince.webp", "assets/avatars/princess.webp"] },
  { id: "forest", label: "森林 · 王子与公主", keys: ["assets/avatars/forest-boy.webp", "assets/avatars/forest-girl.webp"] },
  { id: "starry", label: "星光夜 · 王子与公主", keys: ["assets/avatars/starry-boy.webp", "assets/avatars/starry-girl.webp"] },
  { id: "newlywed", label: "新婚燕尔 · 王子与公主", keys: ["assets/avatars/wedding-boy.webp", "assets/avatars/wedding-girl.webp"] },
  { id: "christmas", label: "圣诞颂歌 · 王子与公主", keys: ["assets/avatars/christmas-boy.webp", "assets/avatars/christmas-girl.webp"] },
];

/* 套装卡片行：当前两位小人正好等于某套时高亮 */
function avatarSetsRow(avatars) {
  const cur = Array.isArray(avatars) ? avatars : [];
  return `<div class="b-avatar-row">
    ${AVATAR_SETS.map((set) => {
      const on =
        cur.length >= 2 &&
        cur[0] === "m:" + set.keys[0] &&
        cur[1] === "m:" + set.keys[1];
      const imgs = set.keys
        .map((k) => (SRC.media[k] ? `<img src="${SRC.media[k]}" alt="" />` : ""))
        .join("");
      return `<button type="button" class="b-avatar-card${on ? " is-on" : ""}" data-act="avatar-set" data-set="${set.id}" title="${esc(set.label)}">${imgs}<span>${esc(set.label)}</span></button>`;
    }).join("")}
  </div>`;
}

function blankDraft() {
  return {
    uid: uid(),
    days: 3,
    theme: "seaside",
    page: { title: "", description: "一封在手机里慢慢展开的旅行邀请。" },
    hero: {
      name: "",
      badge: "BIRTHDAY TRIP",
      datesLabel: "",
      titleLines: ["", "生日快乐"],
      subLines: [],
      coupleName: "",
      coupleNote: "每一天，都值得被记住。",
      coverImage: "m:assets/ai/ai-bonfire.webp",
      avatars: [],
    },
    copy: defaultCopy(),
    dayDates: {},
    stops: [],
    map: { background: "m:assets/map/map-seaside.webp", markerStyle: "pin" },
  };
}

function defaultCopy() {
  const sample = sampleDraft();
  return sample && sample.copy ? sample.copy : {};
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (cur[p] == null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function getByPath(obj, path) {
  return path.split(".").reduce((acc, p) => (acc == null ? acc : acc[p]), obj);
}

/* ================================================================
 * 顶层渲染
 * ============================================================== */

function renderAll() {
  const stepsEl = $("b-steps");
  stepsEl.innerHTML = STEPS.map(
    (s, i) =>
      `<button data-act="goto" data-step="${i}" class="${i === state.step ? "is-on" : ""}">${esc(s.label)}</button>`,
  ).join("");
  const body = $("b-body");
  if (!state.draft) {
    body.innerHTML = `<section class="b-card b-hero-banner">
      <h1>做一个只属于 TA 的惊喜网页</h1>
      <p>选风格 · 写行程 · 放照片 · 导出即成品</p>
    </section>`;
    renderStep(body, "welcome");
  } else {
    renderStep(body, STEPS[state.step].id);
    refreshLive(); // 渲染完立即填充封面/正文实时小样
  }
  renderNav();
}

function renderStep(body, stepId) {
  if (stepId === "welcome") return renderWelcome(body);
  if (stepId === "basic") return renderBasic(body);
  if (stepId === "stops") return renderStops(body);
  if (stepId === "assist") return renderAssist(body);
  if (stepId === "preview") return renderPreview(body);
}

function rerenderCurrent(keepScroll) {
  const y = keepScroll ? window.scrollY : 0;
  const body = $("b-body");
  const stepId = STEPS[state.step].id;
  renderStep(body, stepId);
  refreshLive();
  window.scrollTo(0, y);
}

/* ---------- 实时小样：编辑时即时显示文字会以什么样子出现在成品 ---------- */

function refreshLive() {
  if (document.getElementById("cover-live")) refreshCoverLive();
  refreshStopPreviews();
}

function setLiveText(id, value, emptyHint) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = (value || "").trim();
  el.textContent = v || emptyHint || "";
  el.classList.toggle("is-empty", !v);
}

let coverFrameReady = false;

function refSrc(ref) {
  if (!ref) return "";
  if (ref.startsWith("m:")) return SRC.media[ref.slice(2)] || "";
  if (ref.startsWith("u:")) return state.uiPhotoCache[ref.slice(2)] || "";
  return ref;
}

/* 封面实时预览：加载成品同款样式 + cover 结构，喂入草稿渲染（所见即所得） */
function refreshCoverLive() {
  if (!document.getElementById("cover-live") || !state.draft) return;
  const frame = document.getElementById("cover-live-frame");
  if (!frame) return;
  if (!frame.dataset.inited) {
    frame.dataset.inited = "1";
    frame.dataset.token = String(Math.random());
    initCoverFrame(frame);
    return;
  }
  if (!coverFrameReady) return; // 首帧还没加载完，onload 会自动填充
  fillCoverFrame();
}

function initCoverFrame(frame) {
  const token = frame.dataset.token;
  coverFrameReady = false;
  frame.srcdoc =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    "<style>" + SRC.css + "</style></head><body>" +
    '<section class="screen cover is-active" id="screen-cover">' +
    '<div class="cover-media" id="cover-media"><img id="cover-img" alt="" decoding="async" /></div>' +
    '<div class="cover-content">' +
    '<p class="kicker" id="cover-kicker"></p>' +
    '<h1 class="cover-title" id="cover-title"></h1>' +
    '<p class="cover-sub" id="cover-sub"></p>' +
    '<div class="cover-couple"><div class="cover-couple-copy">' +
    '<p class="cover-couple-name" id="cover-couple-name"></p>' +
    '<p class="cover-couple-note" id="cover-couple-note"></p>' +
    "</div></div></div></section></body></html>";
  frame.onload = () => {
    // 只认当前帧（防止重建后的旧帧回调误触发）
    const cur = document.getElementById("cover-live-frame");
    if (!cur || cur !== frame || cur.dataset.token !== token) return;
    coverFrameReady = true;
    try {
      fillCoverFrame();
    } catch (err) {
      console.warn("[cover-live]", err);
    }
  };
}

function fillCoverFrame() {
  const frame = document.getElementById("cover-live-frame");
  const doc = frame && frame.contentDocument;
  if (!doc || !state.draft) return;
  const h = state.draft.hero || {};
  const theme = state.draft.theme;
  doc.body.dataset.theme =
    theme === "forest" ||
    theme === "starry" ||
    theme === "newlywed" ||
    theme === "christmas"
      ? theme
      : "seaside";
  const $d = (id) => doc.getElementById(id);

  // 封面大图 / 无图纯色
  const img = $d("cover-img");
  const media = $d("cover-media");
  const coverEl = $d("screen-cover");
  const src = refSrc(h.coverImage);
  if (src && img) {
    img.src = src;
    if (media) media.style.display = "";
    if (coverEl) coverEl.classList.remove("is-plain");
  } else {
    if (img) img.removeAttribute("src");
    if (media) media.style.display = "none";
    if (coverEl) coverEl.classList.add("is-plain");
  }

  const kicker = [(h.datesLabel || "").trim(), (h.badge || "").trim()]
    .filter(Boolean)
    .join(" · ");
  if ($d("cover-kicker")) $d("cover-kicker").textContent = kicker;

  const l1 = ((h.titleLines || [])[0] || "").trim() || (h.name ? h.name + "，" : "TA，");
  const l2 = ((h.titleLines || [])[1] || "").trim() || "生日快乐";
  const titleEl = $d("cover-title");
  if (titleEl) titleEl.innerHTML = esc(l1) + "<span>" + esc(l2) + "</span>";

  const subEl = $d("cover-sub");
  if (subEl) {
    const sub = (h.subLines || []).filter((s) => s.trim());
    subEl.innerHTML = sub.length ? sub.map((s) => esc(s)).join("<br />") : "";
  }
  if ($d("cover-couple-name")) $d("cover-couple-name").textContent = h.coupleName || "";
  if ($d("cover-couple-note")) $d("cover-couple-note").textContent = h.coupleNote || "";
}

function refreshStopPreviews() {
  const stops = (state.draft && state.draft.stops) || [];
  stops.forEach((s, i) => {
    const el = document.getElementById("stop-preview-" + i);
    if (!el) return;
    let media = "";
    const imgSrc = refSrc(s.image);
    if (imgSrc) {
      media = `<img src="${esc(imgSrc)}" alt="" />`;
    } else if (typeof s.image === "string" && s.image.startsWith("u:")) {
      media = `<img src="" alt="" data-u="${esc(s.image.slice(2))}" style="display:none" /><span class="b-sticker-load">…</span>`;
    } else {
      media = '<span class="sp-noph">（未设大图）</span>';
    }
    const paras = (s.story || []).filter((t) => t.trim());
    el.innerHTML = `<div class="sp-media">${media}</div>
      <div class="sp-body">
        <p class="sp-day">DAY ${esc(s.day || 1)}</p>
        <h4>${esc(s.title || "（未命名的一站）")}</h4>
        ${(s.short || "").trim() ? `<p class="sp-short">${esc(s.short)}</p>` : ""}
        <div class="sp-story">${paras.length ? paras.map((t) => `<p>${esc(t)}</p>`).join("") : '<i class="b-muted">（还没写正文）</i>'}</div>
        ${(s.mood || "").trim() ? `<p class="sp-mood">${esc(s.mood)}</p>` : ""}
      </div>`;
  });
}

function renderNav() {
  const nav = $("b-nav");
  const id = STEPS[state.step].id;
  let inner = "";
  if (id === "welcome") {
    inner = `<div class="b-nav-inner"></div>`;
  } else if (id === "preview") {
    inner = `<div class="b-nav-inner">
      <button class="b-btn b-btn-ghost" data-act="goto" data-step="3">← AI 助手</button>
      <button class="b-btn b-btn-primary" data-act="download">💾 导出成品 HTML</button>
    </div>`;
  } else {
    inner = `<div class="b-nav-inner">
      <button class="b-btn b-btn-ghost" data-act="goto" data-step="${state.step - 1}">← 上一步</button>
      <button class="b-btn b-btn-primary" data-act="goto" data-step="${state.step + 1}">下一步 →</button>
    </div>`;
  }
  nav.innerHTML = inner;
}

/* ---------- 第 0 步：开始 ---------- */

function renderWelcome(body) {
  const hasDraft = Boolean(state.draft);
  body.innerHTML = `<div class="b-card">
    <h2>${hasDraft ? "继续上次的创作？" : "你想怎么开始？"}</h2>
    <p class="b-desc">所有内容都只保存在你自己的浏览器里，不会上传到任何地方。</p>
    ${hasDraft ? `<button class="b-btn b-btn-primary b-btn-block" data-act="start" data-mode="continue">继续制作（草稿已自动保存）</button>
    <div style="height:10px"></div>` : ""}
    <button class="b-btn b-btn-block" data-act="start" data-mode="sample">🎈 从示例旅程开始（推荐：先看效果再改成自己的）</button>
    <div style="height:10px"></div>
    <button class="b-btn b-btn-ghost b-btn-block" data-act="start" data-mode="blank">从空白开始（自己搭建每一站）</button>
  </div>
  <div class="b-card">
    <h3>它是什么？</h3>
    <p class="b-desc">做出来的成品是一个「惊喜旅程网页」：对方打开后会看到封面，然后一站一站解锁你们的故事——每一站有文字、照片、小任务和骰子小游戏，全部走完到终章，最后还有一本照片回忆册。成品是一个文件，直接发给 TA 就能打开。</p>
  </div>`;
}

/* ---------- 第 1 步：主角与封面 ---------- */

function renderBasic(body) {
  const d = state.draft;
  const h = d.hero;
  const daysInputs = Array.from({ length: Math.max(1, d.days || 1) }, (_, i) => {
    const day = i + 1;
    const val = (d.dayDates && d.dayDates[day]) || "";
    return `<div class="b-field" style="flex:1">
      <label>第 ${day} 天的日期（可留空）</label>
      <input class="b-input" data-p="dayDates.${day}" value="${esc(val)}" placeholder="如 6.28" />
    </div>`;
  }).join("");

  body.innerHTML = `
  <section class="b-card">
    <h2>谁是主角？</h2>
    <div class="b-field"><label>TA 的名字 / 昵称 *</label>
      <input class="b-input" data-p="hero.name" value="${esc(h.name)}" placeholder="如：小星" /></div>
    <div class="b-row">
      <div class="b-field"><label>封面英文小徽章</label>
        <input class="b-input" data-p="hero.badge" value="${esc(h.badge)}" placeholder="BIRTHDAY TRIP" /></div>
      <div class="b-field"><label>日期（封面上方）</label>
        <input class="b-input" data-p="hero.datesLabel" value="${esc(h.datesLabel)}" placeholder="如 6.28 → 6.30" /></div>
    </div>
    <div class="b-row">
      <div class="b-field"><label>主标题·第一行</label>
        <input class="b-input" data-p="hero.titleLines.0" value="${esc((h.titleLines || [])[0] || "")}" placeholder="如：小星，" /></div>
      <div class="b-field"><label>主标题·第二行</label>
        <input class="b-input" data-p="hero.titleLines.1" value="${esc((h.titleLines || [])[1] || "")}" placeholder="生日快乐" /></div>
    </div>
    <div class="b-field"><label>封面副标题（每行一句）</label>
      <textarea class="b-textarea" data-p="hero.subLines" data-lines="1" placeholder="每一行都会换行显示">${esc((h.subLines || []).join("\n"))}</textarea>
      <p class="b-hint">多写几句也没关系。</p></div>
    <div class="b-row">
      <div class="b-field"><label>封面落款</label>
        <input class="b-input" data-p="hero.coupleName" value="${esc(h.coupleName)}" placeholder="如：我 & 小星" /></div>
      <div class="b-field"><label>落款旁小字</label>
        <input class="b-input" data-p="hero.coupleNote" value="${esc(h.coupleNote)}" /></div>
    </div>
    <div class="b-field"><label>作品标题（浏览器标签 / 微信分享标题）</label>
      <input class="b-input" data-p="page.title" value="${esc(d.page.title || "")}" placeholder="留空自动生成" /></div>
  </section>

  <section class="b-card">
    <h3>封面实时预览 <span class="b-muted" style="font-weight:400">（真·成品样式，随输入更新）</span></h3>
    <div class="b-cover-frame-box" id="cover-live">
      <iframe class="b-cover-frame" id="cover-live-frame" title="封面实时预览"></iframe>
    </div>
    <p class="b-hint">与成品使用同一套样式与主题；封面大图取自你的选择。头像、动画与完整流程请以「预览与导出」为准。</p>
  </section>

  <section class="b-card">
    <h2>选一个风格</h2>
    <div class="b-style-grid">
      ${THEMES.map((t) => {
        const on = (d.theme || "seaside") === t.id;
        const dots = t.swatch
          .map((c) => `<i style="background:${c}"></i>`)
          .join("");
        return `<button type="button" class="b-style-card${on ? " is-on" : ""}" data-act="theme-set" data-theme="${t.id}">
          <span class="b-style-swatch" aria-hidden="true">${dots}</span>
          <span class="b-style-name">${esc(t.label)}</span>
          <span class="b-style-note">${esc(t.note)}</span>
        </button>`;
      }).join("")}
    </div>
    <p class="b-hint">选风格会同步配套地图背景（若你已自定义地图背景则保留你的）。到「预览与导出」可实时查看成品效果。</p>
  </section>

  <section class="b-card">
    <h2>旅程安排</h2>
    <div class="b-row" style="align-items:flex-end">
      <div class="b-field"><label>一共几天？</label>
        <select class="b-select" data-days-preset>
          ${Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}" ${(d.days || 3) === i + 1 ? "selected" : ""}>${i + 1} 天</option>`).join("")}
          <option value="custom" ${(d.days || 3) > 10 ? "selected" : ""}>自定义（超过 10 天）…</option>
        </select></div>
      <div class="b-field" data-days-custom-field style="${(d.days || 3) > 10 ? "" : "display:none"}">
        <label>自定义天数（最多 21）</label>
        <input class="b-input" type="number" min="1" max="21" data-days-custom value="${(d.days || 3) > 10 ? d.days : ""}" placeholder="如 12" />
      </div>
    </div>
    <div class="b-flex" style="align-items:flex-end">${daysInputs}</div>
    <p class="b-hint">接着到「行程与文案」里按天添加每一站。改天数不会删掉已有站点。</p>
  </section>

  <section class="b-card">
    <h2>封面大图</h2>
    ${imagePicker("hero.coverImage", h.coverImage || "", { media: mediaKeysOf("assets/ai"), pickLabel: "用自己的照片" })}
    <div class="b-note">封面图最好偏深色，白色文字会更清晰；也可以用自己的照片。</div>
  </section>

  <section class="b-card">
    <h2>落款头像（可选）</h2>
    <p class="b-hint">这对小人是封面上的落款，也是地图上沿路线一站一站走的主角。成对套装一键填好两位：</p>
    ${avatarSetsRow(h.avatars)}
    <p class="b-hint" style="margin-top:4px">也可以分别选/传图，或只放一位：</p>
    ${imagePicker("hero.avatars.0", (h.avatars || [])[0] || "", { media: mediaKeysOf("assets/avatars"), pickLabel: "加第一张头像" })}
    <div style="height:8px"></div>
    ${imagePicker("hero.avatars.1", (h.avatars || [])[1] || "", { media: mediaKeysOf("assets/avatars"), pickLabel: "加第二张头像" })}
    <p class="b-hint">留空也可以：封面不显示头像，地图上的小人会自动隐藏。头像会跟着路线移动，建议选浅色底小图。</p>
  </section>

  <section class="b-card">
    <h2>地图背景</h2>
    ${imagePicker("map.background", (d.map && d.map.background) || "", { media: mediaKeysOf("assets/map"), pickLabel: "上传自己的地图背景", allowClear: true })}
    <p class="b-hint">背景图只负责画面氛围；站点的图钉/图标、路线都由引擎叠加。若图上画有地标，可用下面的「校准」把站点拖到对应位置。</p>
    <div class="b-flex" style="margin-top:10px">
      <span class="b-label" style="margin:0 4px 0 0">标记样式：</span>
      ${["pin", "card"]
        .map(
          (m) =>
            `<button type="button" class="b-btn b-btn-sm${(d.map && d.map.markerStyle) === m ? " b-btn-primary" : " b-btn-ghost"}" data-act="map-style" data-style="${m}">${m === "pin" ? "📌 图钉（尖角指向地标）" : "▦ 卡片（大图标）"}</button>`,
        )
        .join("")}
      <span class="b-spacer"></span>
      <button type="button" class="b-btn b-btn-sm" data-act="calib-open">🎯 校准站点位置</button>
    </div>
    <div class="b-calib" id="calib-panel" ${state.calibOpen ? "" : "hidden"}>${state.calibOpen ? calibPanelHtml() : ""}</div>
  </section>`;
}

/* ---------- 站点位置校准（把站点拖到背景图上的地标） ---------- */

function calibAuto(n) {
  const pos = [];
  const perRow = n <= 5 ? n : 4;
  const rows = Math.ceil(n / perRow);
  for (let i = 0; i < n; i += 1) {
    const row = Math.floor(i / perRow);
    const col = row % 2 === 1 ? perRow - 1 - (i % perRow) : i % perRow;
    const rowSpan = rows <= 1 ? 0 : 100 / rows;
    pos.push({
      x: perRow <= 1 ? 50 : 10 + (col * 80) / Math.max(perRow - 1, 1),
      y: perRow <= 1 ? 18 + (i * 56) / Math.max(n - 1, 1) : 14 + rowSpan * (row + 0.5),
    });
  }
  return pos;
}

function calibPanelHtml() {
  const d = state.draft;
  if (!d) return "";
  const bg = refSrc(d.map && d.map.background);
  const stops = d.stops || [];
  if (!bg) {
    return '<p class="b-muted" style="padding:12px">先选一张地图背景，再校准站点位置。</p>';
  }
  if (!stops.length) {
    return '<p class="b-muted" style="padding:12px">还没有站点，先到「行程与文案」添加站点再来校准。</p>';
  }
  const positions =
    d.map && Array.isArray(d.map.positions) && d.map.positions.length === stops.length
      ? d.map.positions
      : calibAuto(stops.length);
  const pts = positions
    .map(
      (p, i) =>
        `<span class="b-calib-pt" data-calib-i="${i}" style="left:${p.x}%;top:${p.y}%"><b>${i + 1}</b><i>${esc((stops[i].title || "").slice(0, 6))}</i></span>`,
    )
    .join("");
  return `<div class="b-calib-stage" style="background-image:url('${esc(bg)}')">${pts}</div>
  <div class="b-flex" style="margin-top:8px">
    <button type="button" class="b-btn b-btn-sm b-btn-ghost" data-act="calib-auto">↺ 重置为自动</button>
    <span class="b-hint" style="margin:0">拖动数字点，对准图上的地标（尖角即标记指向）</span>
    <span class="b-spacer"></span>
    <button type="button" class="b-btn b-btn-sm b-btn-primary" data-act="calib-close">完成 ✓</button>
  </div>`;
}

/* 拖动校准（pointer 事件，全局一份） */
let calibDragIndex = null;
function ensureCalibPositions() {
  const d = state.draft;
  const n = (d.stops || []).length;
  d.map = d.map || {};
  if (!Array.isArray(d.map.positions) || d.map.positions.length !== n) {
    d.map.positions = calibAuto(n);
  }
}
function setCalibPos(i, x, y) {
  ensureCalibPositions();
  state.draft.map.positions[i] = { x, y };
  scheduleSave();
  const pt = document.querySelector(`[data-calib-i="${i}"]`);
  if (pt) {
    pt.style.left = x + "%";
    pt.style.top = y + "%";
  }
}
function bindCalibPointer() {
  window.addEventListener("pointerdown", (e) => {
    const pt = e.target && e.target.closest ? e.target.closest("[data-calib-i]") : null;
    if (pt && document.getElementById("calib-panel")) calibDragIndex = Number(pt.dataset.calibI);
  });
  window.addEventListener("pointermove", (e) => {
    if (calibDragIndex === null) return;
    const stage = document.querySelector("#calib-panel .b-calib-stage");
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    setCalibPos(calibDragIndex, Math.min(98, Math.max(2, x)), Math.min(98, Math.max(2, y)));
  });
  window.addEventListener("pointerup", () => {
    calibDragIndex = null;
  });
}
bindCalibPointer();

/* ---------- 图片选择器（通用） ---------- */

function imagePicker(path, current, opts) {
  const o = opts || {};
  const media = o.media || [];
  const chips = media
    .map(
      (key) =>
        `<button type="button" class="b-pick-item${current === "m:" + key ? " is-on" : ""}" data-act="pick" data-path="${esc(path)}" data-key="${esc(key)}" title="${esc(key)}">
          <img src="${SRC.media[key]}" alt="" /><span>${esc(mediaLabel(key))}</span>
        </button>`,
    )
    .join("");
  return `<div class="b-pick">
    ${thumbBlock(path, current)}
    ${chips}
    <button type="button" class="b-btn b-btn-sm" data-act="pick-upload" data-path="${esc(path)}" data-multi="0">📷 ${esc(o.pickLabel || "上传照片")}</button>
    ${current && o.allowClear !== false ? `<button type="button" class="b-btn b-btn-sm b-btn-ghost" data-act="pick-clear" data-path="${esc(path)}">清除</button>` : ""}
  </div>`;
}

/* 当前选中缩略图（支持 m:/u:/http 三种引用；u: 未加载时异步补） */
function thumbBlock(path, ref) {
  if (!ref) return "";
  const src =
    ref.startsWith("m:")
      ? SRC.media[ref.slice(2)] || ""
      : ref.startsWith("u:")
        ? state.uiPhotoCache[ref.slice(2)] || null
        : ref;
  const id = cssId(path);
  if (ref.startsWith("u:") && !src) {
    return `<div class="b-flex" style="margin-bottom:8px">
      <i class="b-muted" style="font-size:12px" data-u-load="${esc(ref.slice(2))}" data-u-to="pic:${id}">加载照片…</i>
    </div>`;
  }
  return src
    ? `<div class="b-flex" style="margin-bottom:8px">
        <img data-pickprev="${id}" src="${src}" alt="" style="width:118px;height:76px;object-fit:cover;border-radius:10px;border:1px solid var(--bk-line)" />
        <span class="b-muted" style="font-size:12px">${ref.startsWith("u:") ? "你上传的照片" : "当前已选"}</span>
      </div>`
    : "";
}

/* 预览块 HTML（清除/换图时用它整体替换） */
function previewBlockHtml(pid, src, isUploaded) {
  return `<div class="b-flex" style="margin-bottom:8px">
    <img data-pickprev="${pid}" src="${src}" alt="" style="width:118px;height:76px;object-fit:cover;border-radius:10px;border:1px solid var(--bk-line)" />
    <span class="b-muted" style="font-size:12px">${isUploaded ? "你上传的照片" : "当前已选"}</span>
  </div>`;
}

/*
 * 同步单个图片位的预览：
 *  ref 为空 → 移除预览块（点「清除」后图片立刻消失）；
 *  ref 有效 → 移除旧块并把新图块插到选择面板顶部。
 */
function thumbUpdateForPath(path, ref, host) {
  const pid = cssId(path);
  document
    .querySelectorAll(`[data-pickprev="${pid}"], [data-u-to="pic:${pid}"]`)
    .forEach((el) => {
      const w = el.closest(".b-flex");
      if (w) w.remove();
    });
  if (!ref || !host) return;
  const src = ref.startsWith("m:")
    ? SRC.media[ref.slice(2)] || ""
    : ref.startsWith("u:")
      ? state.uiPhotoCache[ref.slice(2)] || ""
      : ref;
  if (!src) return; // 用户照片尚未读入：交给 hydrate 占位
  host.insertAdjacentHTML("afterbegin", previewBlockHtml(pid, src, ref.startsWith("u:")));
}

/* ---------- 第 2 步：行程与文案 ---------- */

function iconEmojiOf(icon) {
  return typeof icon === "string" && icon.startsWith("emoji:")
    ? icon.slice(6)
    : "";
}

/* 图标当前值预览：emoji 放大 / 内置图 / 上传贴纸。带 data-icon-thumb 标记，
 * 清除/换选时可被 removeIconThumb() 移除，避免「清不掉」的假象 */
function iconThumbHtml(icon, idx) {
  const tag = `data-icon-thumb="${idx}"`;
  if (!icon) return "";
  if (icon.startsWith("emoji:")) {
    const c = icon.slice(6) || "😊";
    return `<span class="b-flex" style="margin-bottom:8px" ${tag}><b style="font-size:30px;line-height:1">${esc(c)}</b></span>`;
  }
  let src = "";
  if (icon.startsWith("m:")) src = SRC.media[icon.slice(2)] || "";
  else if (icon.startsWith("u:")) src = state.uiPhotoCache[icon.slice(2)] || "";
  if (!src) {
    if (icon.startsWith("u:")) {
      return `<span class="b-flex" style="margin-bottom:8px" ${tag}><i class="b-muted" style="font-size:12px" data-icon-u="${esc(icon.slice(2))}">正在读取贴纸…</i></span>`;
    }
    return "";
  }
  return `<span class="b-flex" style="margin-bottom:8px" ${tag}>
    <img src="${esc(src)}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:14px;border:2px solid #fff;box-shadow:0 4px 10px rgba(120,97,88,.18)" />
  </span>`;
}

function stopIndexFromPathIcon(path) {
  const m = String(path).match(/^stops\.(\d+)\.icon$/);
  return m ? Number(m[1]) : -1;
}

/* 移除某站的图标预览块（选择变化/清除时调用） */
function removeIconThumb(idx) {
  document
    .querySelectorAll(`[data-icon-thumb="${idx}"]`)
    .forEach((el) => el.remove());
}

/* 收藏的贴纸格：多张贴纸可并存，点击任一张作为当前图标，右上 ✕ 删除单张 */
function iconStickerGrid(stop, stopIdx) {
  const refs = stop.iconRefs || [];
  if (!refs.length) return "";
  const cards = refs
    .map((ref, ri) => {
      const isCur = ref === stop.icon;
      const u = ref.startsWith("u:") ? ref.slice(2) : null;
      const cached = u ? state.uiPhotoCache[u] : null;
      const inner = cached
        ? `<img src="${cached}" alt="" />`
        : u
          ? `<img src="" alt="" data-u="${u}" style="display:none" /><i class="b-sticker-load">…</i>`
          : `<b>${esc(ref)}</b>`;
      return `<span class="b-sticker${isCur ? " is-on" : ""}" title="${isCur ? "当前图标" : "点我设为当前图标"}" data-act="icon-select" data-stop="${stopIdx}" data-ri="${ri}">
        ${inner}
        <button type="button" class="b-sticker-x" aria-label="删除这张贴纸" data-act="icon-ref-del" data-stop="${stopIdx}" data-ri="${ri}">✕</button>
      </span>`;
    })
    .join("");
  return `<div class="b-stickers">${cards}</div>`;
}

/* 章节大图图库：多张并存、点选设为当前、单张 ✕ 删除 */
function imageStickerGrid(stop, stopIdx) {
  const refs = stop.imageRefs || [];
  if (!refs.length) return "";
  const cards = refs
    .map((ref, ri) => {
      const isCur = ref === stop.image;
      const u = ref.startsWith("u:") ? ref.slice(2) : null;
      const cached = u ? state.uiPhotoCache[u] : null;
      const inner = cached
        ? `<img src="${cached}" alt="" />`
        : u
          ? `<img src="" alt="" data-u="${u}" style="display:none" /><i class="b-sticker-load">…</i>`
          : `<b>${esc(ref)}</b>`;
      return `<span class="b-sticker b-sticker-lg${isCur ? " is-on" : ""}" title="${isCur ? "当前大图" : "点我设为当前大图"}" data-act="image-select" data-stop="${stopIdx}" data-ri="${ri}">
        ${inner}
        <button type="button" class="b-sticker-x" aria-label="删除这张图" data-act="image-ref-del" data-stop="${stopIdx}" data-ri="${ri}">✕</button>
      </span>`;
    })
    .join("");
  return `<div class="b-stickers">${cards}</div>`;
}

function renderStops(body) {
  const d = state.draft;
  if (!d.stops.length) {
    body.innerHTML = `<section class="b-card">
      <h2>还没有任何一站</h2>
      <p class="b-desc">每一站就是旅程地图上的一个点：TA 打开网页后会一站一站往前走、一站一站解锁。</p>
      <button class="b-btn b-btn-primary b-btn-block" data-act="stop-add">＋ 添加第一站</button>
    </section>`;
    return;
  }
  const icons = mediaKeysOf("assets/icons");
  const images = mediaKeysOf("assets/ai");

  const cards = d.stops
    .map((stop, i) => {
      const open = state.stopOpen.has(i);
      const pics = (stop.gallery || [])
        .map((ref, gi) => {
          const u = ref.startsWith("u:") ? ref.slice(2) : null;
          const cached = u ? state.uiPhotoCache[u] : null;
          const imgTag = cached
            ? `<img src="${cached}" alt="" />`
            : `<img src="" alt="" style="display:none" data-u="${u || ""}" />
               <i class="b-muted" style="font-size:11px;position:absolute;inset:0;display:flex;align-items:center;justify-content:center">读取中…</i>`;
          return `<div class="b-photo">
            ${imgTag}
            <button type="button" class="b-photo-x" data-act="photo-del" data-stop="${i}" data-idx="${gi}" data-photo="${esc(u || "")}">✕</button>
            <input class="b-photo-cap" placeholder="照片说明…" data-p="stops.${i}.galleryCaption.${gi}" value="${esc((stop.galleryCaption || [])[gi] || "")}" />
          </div>`;
        })
        .join("");
      const iconChips = icons
        .map(
          (key) =>
            `<button type="button" class="b-pick-item${stop.icon === "m:" + key ? " is-on" : ""}" data-act="pick" data-path="stops.${i}.icon" data-key="${esc(key)}" title="${esc(key)}">
              <img src="${SRC.media[key]}" alt="" /><span>${esc(mediaLabel(key))}</span>
            </button>`,
        )
        .join("");
      const imageChips = images
        .map(
          (key) =>
            `<button type="button" class="b-pick-item${stop.image === "m:" + key ? " is-on" : ""}" data-act="pick" data-path="stops.${i}.image" data-key="${esc(key)}" title="${esc(key)}">
              <img src="${SRC.media[key]}" alt="" /><span>${esc(mediaLabel(key))}</span>
            </button>`,
        )
        .join("");
      const dayOptions = Array.from({ length: Math.max(1, d.days || 1) }, (_, k) => {
        const day = k + 1;
        return `<option value="${day}" ${Number(stop.day) === day ? "selected" : ""}>第 ${day} 天</option>`;
      }).join("");
      const isLast = i === d.stops.length - 1;

      return `<article class="b-stop${open ? " is-open" : ""}" data-stop="${i}">
        <div class="b-stop-head" data-act="stop-toggle" data-i="${i}">
          <span class="b-stop-day">DAY ${esc(stop.day || 1)}</span>
          <span class="b-stop-title${stop.title ? "" : " is-empty"}">${esc(stop.title || "（未命名的一站）")}</span>
          <span class="b-muted">${open ? "收起 ▴" : "展开 ▾"}</span>
        </div>
        <div class="b-stop-body">
          <div class="b-stop-preview" id="stop-preview-${i}" aria-hidden="true"></div>
          <div class="b-field"><label>站点名 *</label>
            <input class="b-input" data-p="stops.${i}.title" value="${esc(stop.title || "")}" placeholder="如：印记工坊" />
            <p class="b-hint">→ 出现在：地图上的站点标记 + 章节页大标题</p></div>
          <div class="b-row">
            <div class="b-field"><label>第几天</label>
              <select class="b-select" data-p="stops.${i}.day" data-num="1">${dayOptions}</select></div>
            <div class="b-field"><label>一句话简介</label>
              <input class="b-input" data-p="stops.${i}.short" value="${esc(stop.short || "")}" placeholder="如：下午，去做一件能一直戴着的纪念。" />
              <p class="b-hint">→ 出现在：地图下方面板（TA 点进来前先看到这句）</p></div>
          </div>
          <div class="b-field"><label>这一站在哪（可选小标签）</label>
            <input class="b-input" data-p="stops.${i}.place" value="${esc(stop.place || "")}" placeholder="如：这一站是：手作工坊里" />
            <p class="b-hint">→ 出现在：章节页的「这一站是…」小标签</p></div>
          <div class="b-field"><label>正文故事（每行一段，TA 会逐段阅读）</label>
            <textarea class="b-textarea" style="min-height:110px" data-p="stops.${i}.story" data-lines="1" placeholder="每行一段……">${esc((stop.story || []).join("\n"))}</textarea>
            <p class="b-hint">→ 出现在：章节正文，会实时显示在本站顶部预览卡里（随输入更新）</p></div>
          <div class="b-field"><label>这一站的心情（一句话）</label>
            <input class="b-input" data-p="stops.${i}.mood" value="${esc(stop.mood || "")}" placeholder="如：有些约定不必说出口，戴在手上就够了。" />
            <p class="b-hint">→ 出现在：章节页的「心情」卡片（顶部预览卡可见样式）</p></div>
          <div class="b-row">
            <div class="b-field"><label>小任务（可留空）</label>
              <input class="b-input" data-p="stops.${i}.task" value="${esc(stop.task || "")}" placeholder="如：把两件作品放在一起合影" />
              <p class="b-hint">→ 出现在：章节页「小任务」卡片（📷）</p></div>
            <div class="b-field"><label>卡片提示（填了就有骰子小游戏）</label>
              <input class="b-input" data-p="stops.${i}.hint" value="${esc(stop.hint || "")}" placeholder="如：第 1 张卡：手作卡" />
              <p class="b-hint">→ 出现在：章节页卡片提示；不填则不显示骰子</p></div>
          </div>
          <div class="b-field"><label>站图标（地图小图标）</label>
            <div class="b-pick">
              ${iconThumbHtml(stop.icon, i)}
              ${iconStickerGrid(stop, i)}
              ${iconChips}
              <span class="b-flex" style="width:100%">
                <input class="b-input" style="flex:1;min-width:0" data-icon-emoji="${i}" placeholder="或用 emoji，如 🍜 🚗 🎆" value="${esc(iconEmojiOf(stop.icon))}" maxlength="6" />
                <button class="b-btn b-btn-sm" data-act="icon-upload" data-stop="${i}">📷 添加贴纸</button>
                ${stop.icon ? `<button class="b-btn b-btn-sm b-btn-ghost" data-act="pick-clear" data-path="stops.${i}.icon">清除当前</button>` : ""}
              </span>
            </div>
            <p class="b-hint">可收藏多张贴纸再任选一张（点它即生效）；贴纸右上角 ✕ 删除单个；预设图标点选即用；emoji 输入即用。地图上显示 52px 圆角框，普通照片建议放到「章节大图」。</p></div>
          <div class="b-field"><label>章节大图（进入这一站看到的大图 · 图库式）</label>
            <div class="b-pick">
              ${imageStickerGrid(stop, i)}
              ${imageChips}
              <span class="b-flex" style="width:100%">
                <button class="b-btn b-btn-sm" data-act="image-upload" data-stop="${i}">📷 加入图库（可多张）</button>
                ${stop.image ? `<button class="b-btn b-btn-sm b-btn-ghost" data-act="pick-clear" data-path="stops.${i}.image">清除当前</button>` : ""}
              </span>
            </div>
            <p class="b-hint">图库可存多张，任点一张设为当前；右上 ✕ 删除单张。加入的图不会因点选其它图而消失；预设插画点选即用。当前图显示在本站顶部预览卡。</p></div>
          <div class="b-field"><label>这一站的照片（进照片墙和回忆册）</label>
            <div class="b-photos">
              ${pics}
              <button class="b-add-photo" data-act="pick-upload" data-path="stops.${i}.gallery" data-multi="1">
                <span class="big">＋</span>${pics ? "再加照片" : "添加这一站的照片"}
              </button>
            </div>
            <p class="b-hint">手机浏览器会打开相册；电脑上可以多选本地文件。</p></div>
          ${isLast ? `<div class="b-field" style="margin-top:12px">
            <label class="b-label">收尾设置（最后这一站）</label>
            <div class="b-flex"><label style="display:flex;gap:6px;align-items:center;font-size:13px">
              <input type="checkbox" data-p="stops.${i}.opensFinale" ${stop.opensFinale ? "checked" : ""} /> 走到这里打开终章
            </label></div>
            <input class="b-input" data-p="stops.${i}.action" value="${esc(stop.action || "")}" placeholder="最后一站按钮文字，如：打开最后的惊喜" style="margin-top:6px" />
          </div>` : ""}
          <div class="b-flex" style="justify-content:flex-end;margin-top:10px">
            <button class="b-btn b-btn-sm b-btn-ghost${i === 0 ? " is-disabled" : ""}" ${i === 0 ? 'aria-disabled="true" data-tip="已经是第一站了"' : ""} data-act="stop-move" data-i="${i}" data-dir="-1">↑ 上移</button>
            <button class="b-btn b-btn-sm b-btn-ghost${isLast ? " is-disabled" : ""}" ${isLast ? 'aria-disabled="true" data-tip="已经是最后一站了"' : ""} data-act="stop-move" data-i="${i}" data-dir="1">↓ 下移</button>
            <button class="b-btn b-btn-sm b-btn-ghost" data-act="stop-copy" data-i="${i}">复制</button>
            <button class="b-btn b-btn-sm b-btn-ghost" data-act="stop-del" data-i="${i}">删除</button>
          </div>
        </div>
      </article>`;
    })
    .join("");

  body.innerHTML = `<section class="b-card">
    <div class="b-flex">
      <div><h2>行程与文案</h2>
      <p class="b-desc">共 ${d.stops.length} 站 · 点击卡片展开编辑。顺序就是 TA 解锁的顺序。</p></div>
      <span class="b-spacer"></span>
      <button class="b-btn b-btn-sm" data-act="stop-add">＋ 添加一站</button>
    </div>
    ${cards}
  </section>`;
  hydratePhotos();
}

/* 异步补全照片缩略图 */
function hydratePhotos() {
  const need = Array.from(document.querySelectorAll("[data-u]")).map((img) => {
    const id = img.getAttribute("data-u");
    if (!id) return null;
    const sibling = img.nextElementSibling;
    return { img, id, sibling };
  }).filter(Boolean);
  need.forEach(({ img, id, sibling }) => {
    PhotoLib.getPhoto(id)
      .then((dataUrl) => {
        if (!dataUrl) return;
        state.uiPhotoCache[id] = dataUrl;
        if (img.isConnected) {
          img.src = dataUrl;
          img.style.display = "";
          if (sibling && sibling.isConnected) sibling.remove();
        }
      })
      .catch(() => {});
  });
  // 缩略块里的「加载照片…」占位
  document.querySelectorAll("[data-u-load]").forEach((el) => {
    const id = el.getAttribute("data-u-load");
    PhotoLib.getPhoto(id).then((dataUrl) => {
      if (!dataUrl || !el.isConnected) return;
      state.uiPhotoCache[id] = dataUrl;
      const holder = el.closest(".b-flex");
      const container = el.closest(".b-pick");
      if (holder) holder.remove();
      if (!container) return;
      // 从 data-u-to="pic:xxx" 还原路径 id，插入带清除标记的预览块
      const target = el.getAttribute("data-u-to") || "";
      const pid = target.startsWith("pic:") ? target.slice(4) : "";
      container.insertAdjacentHTML(
        "afterbegin",
        previewBlockHtml(pid, dataUrl, true),
      );
    });
  });
  // 站图标上传的贴纸占位
  document.querySelectorAll("[data-icon-u]").forEach((el) => {
    const id = el.getAttribute("data-icon-u");
    PhotoLib.getPhoto(id).then((dataUrl) => {
      if (!dataUrl || !el.isConnected) return;
      state.uiPhotoCache[id] = dataUrl;
      const wrap = el.closest(".b-flex");
      if (!wrap) return;
      wrap.innerHTML = `<img src="${dataUrl}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:14px;border:2px solid #fff;box-shadow:0 4px 10px rgba(120,97,88,.18)" />`;
    });
  });
}

/* ---------- 第 3 步：AI 助手 ---------- */

const LS_AI_PROVIDER = "trip-builder-ai-provider";

const AI_PROVIDERS = [
  { id: "deepseek", label: "DeepSeek", base: "https://api.deepseek.com", model: "deepseek-chat", keyHint: "platform.deepseek.com" },
  { id: "openai", label: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-4o-mini", keyHint: "platform.openai.com" },
  { id: "zhipu", label: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", keyHint: "open.bigmodel.cn" },
  { id: "moonshot", label: "Moonshot Kimi", base: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", keyHint: "platform.moonshot.cn" },
  { id: "qwen", label: "阿里通义千问", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", keyHint: "阿里云百炼控制台" },
  { id: "openrouter", label: "OpenRouter（聚合）", base: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", keyHint: "openrouter.ai" },
  { id: "ollama", label: "Ollama 本地（无需 Key）", base: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", keyHint: "本机安装 Ollama 即可，不联网不外发" },
  { id: "custom", label: "自定义 OpenAI 兼容端点…", base: "", model: "", keyHint: "填写任意兼容 /chat/completions 的地址" },
];

function aiProviderById(id) {
  return AI_PROVIDERS.find((p) => p.id === id) || AI_PROVIDERS[0];
}

/* 图片素材灵感：主题 × 用途 → 出图提示词模板 */
const IMAGE_PURPOSES = [
  { id: "map", label: "旅程地图背景", size: "4:5 竖幅", note: "底图只画风景与地标，站点图钉/路线由成品引擎叠加" },
  { id: "chapter", label: "章节大图（每站一景）", size: "16:9 横幅", note: "场景氛围画，图上不要文字" },
  { id: "cover", label: "封面大图", size: "4:5 竖幅、偏深色", note: "白色大字会压在图上，深色区域更适合" },
  { id: "sticker", label: "贴纸 / 小图标素材", size: "1:1，透明底更好", note: "物体特写/徽章，透明背景 PNG 优先" },
];

const THEME_MATERIALS = {
  seaside: { name: "海边暖沙", palette: "奶油粉、暖沙、海蓝", elems: "灯塔、沙滩、帆船、遮阳伞、海边小屋与栈道", vibe: "明亮轻盈的海风假日" },
  forest: { name: "森林", palette: "鼠尾草绿、焦糖、奶油", elems: "林间木屋、松林小径、野餐、湖泊、苔石", vibe: "安静治愈的森系假日" },
  starry: { name: "星光夜", palette: "薰衣草紫、月光金、深蓝", elems: "星空、月光下的屋顶、灯串、夜风、萤火", vibe: "浪漫入夜的星光感" },
  newlywed: { name: "新婚燕尔", palette: "香槟金、暖白、淡玫瑰", elems: "白色礼堂与花拱、露天餐桌、热气球坪、湖心亭、花园凉亭、烛光舞台", vibe: "新婚当天清晨般温柔浪漫" },
  christmas: { name: "圣诞颂歌", palette: "松针绿、蔓越莓红、窗灯暖金、雪地蓝白", elems: "礼物屋、圣诞树广场、暖窗姜饼屋、雪橇驯鹿、雪人花园、尖顶教堂钟楼", vibe: "雪夜温馨的节日感" },
};

function buildImagePrompt(purposeId, themeKey, detail) {
  const purpose = IMAGE_PURPOSES.find((p) => p.id === purposeId) || IMAGE_PURPOSES[0];
  const mat = THEME_MATERIALS[themeKey] || THEME_MATERIALS.seaside;
  const detailLine = (detail || "").trim()
    ? `\n画面中加入：${detail}。`
    : "";
  let scene = "";
  if (purposeId === "map") {
    scene = `水彩插画的${mat.name}主题旅行地图底图，斜俯视构图（像手绘导览图）。画面里有一条浅色蜿蜒小路串起若干风格各异、可辨识的小场地：${mat.elems}。场地之间是柔和地形分区，画面中下部留出干净区域（站点标记会叠加在这里）。`;
  } else if (purposeId === "chapter") {
    scene = `水彩插画的${mat.name}主题场景画：${mat.elems} 中的一处被温柔刻画为主角场景，${mat.vibe}，留出呼吸感，色调克制。`;
  } else if (purposeId === "cover") {
    scene = `水彩插画的${mat.name}主题封面背景：${mat.elems} 的远景氛围，画面下半部偏深/沉以便压白色大字，${mat.vibe}。`;
  } else {
    scene = `扁平可爱的${mat.name}主题贴纸/小图标：${mat.elems} 中单个元素的特写（圆润造型、清晰轮廓），白边或透明底，单色背景可选。`;
  }
  return (
    `【${purpose.label} · ${mat.name}】\n` +
    `${scene}${detailLine}\n` +
    `主色：${mat.palette}。水彩绘本风，笔触柔和水彩，边缘清晰圆润，对比温和。\n` +
    `尺寸建议：${purpose.size}（${purpose.note}）。\n` +
    `禁止：文字、字母、水印、logo、人物面部、现代高楼、地图图钉、虚线路线、边框。\n` +
    `生成后若偏花/偏空，追加：simpler composition, softer contrast, leave a calm area in the middle/for text。`
  );
}

const AI_SYSTEM_PROMPT = `你是「生日旅行惊喜网页」的文案与行程助手。用户会口述一次想安排的旅程（生日/纪念日/约会惊喜）。

请只输出一个 JSON 对象，不要输出任何其它文字或解释。结构如下：
{
  "hero": {
    "name": "寿星昵称",
    "badge": "英文小徽章，如 BIRTHDAY TRIP",
    "datesLabel": "日期，如 6.28 → 6.30",
    "coupleName": "落款，如 我 & 小星",
    "coupleNote": "落款旁的一句话"
  },
  "dayDates": { "1": "M.D", "2": "M.D" },
  "stops": [
    {
      "day": 1,
      "title": "站名",
      "short": "一句话简介",
      "place": "这一站是：……",
      "story": ["正文段落1", "正文段落2", "正文段落3"],
      "mood": "一句心情/感悟",
      "task": "一个可执行的小任务",
      "hint": "第 n 张卡：xxx 卡",
      "image": "ai-craft"
    }
  ]
}
规则：
- 站数 3 到 6 个，day 从 1 开始递增，可同一天多站。
- 文案用中文，浪漫、具体、有画面感，像写给 TA 的第二人称口吻，不要空泛口号。
- image 可省略或填 ai-craft/ai-cinema/ai-depart/ai-resort/ai-bonfire/ai-omakase 之一（向导会为其它值做兜底）。
- 最后一站在 stops 末尾补充 "opensFinale": true 和 "action": "打开最后的惊喜"。
- 不要编造真实姓名，name 用昵称。`;

function renderAssist(body) {
  body.innerHTML = `
  <section class="b-card">
    <h2>AI 助手</h2>
    <p class="b-desc">三个能力，任选：
    <br />💬 对话起草：可接 DeepSeek / OpenAI / 智谱 / Kimi / 通义 / OpenRouter / Ollama 本地…（用自己的 Key，或走粘贴）；
    <br />🎨 图片素材灵感：按主题与用途生成可直接复制的出图提示词（无需 Key 也能用）；
    <br />📋 粘贴导入：完全不填 Key 的万能通道。</p>
    <div class="b-tabs">
      <button class="is-on" data-act="ai-tab" data-tab="chat">💬 AI 对话</button>
      <button data-act="ai-tab" data-tab="inspiration">🎨 图片灵感</button>
      <button data-act="ai-tab" data-tab="paste">📋 粘贴导入</button>
    </div>
    <div id="ai-pane"></div>
  </section>`;
  renderAiPane("chat", {});
}

function aiProviderOptions(selected) {
  return AI_PROVIDERS.map(
    (p) => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.label)}</option>`,
  ).join("");
}

function renderAiPane(tab, _opts) {
  const pane = $("ai-pane");
  if (!pane) return;
  document.querySelectorAll(".b-tabs button").forEach((b) => {
    b.classList.toggle("is-on", b.dataset.tab === tab);
  });
  if (tab === "chat") {
    renderChatPane(pane);
  } else if (tab === "inspiration") {
    renderInspirationPane(pane);
  } else {
    renderPastePane(pane);
  }
}

function currentProviderId() {
  const saved = localStorage.getItem(LS_AI_PROVIDER);
  return AI_PROVIDERS.some((p) => p.id === saved) ? saved : "deepseek";
}

function renderChatPane(pane) {
  const d = state.draft;
  const brief = d
    ? (d.hero && d.hero.name ? `主角：${d.hero.name}。` : "") +
      (d.stops.length
        ? `目前已安排 ${d.stops.length} 站。可以让我先列出每站标题，或补写/改写某些站的文案。`
        : "还没有站点，我可以根据你的口述安排整个行程。")
    : "";
  const msgs = (state.aiMessages || [])
    .map(
      (m) =>
        `<div><b>${m.role === "user" ? "你" : "AI"}</b>：${esc(m.content)}</div><div style="height:8px"></div>`,
    )
    .join("");
  const provId = currentProviderId();
  const prov = aiProviderById(provId);
  const savedKey = localStorage.getItem(LS_AI_KEY) || "";
  const savedBase = localStorage.getItem(LS_AI_BASE) || prov.base;
  const savedModel = localStorage.getItem(LS_AI_MODEL) || prov.model;
  pane.innerHTML = `<div class="b-field"><label>选择模型（费用走你自己的账户；Ollama 本地则完全无需 Key）</label>
      <select class="b-select" data-ai-provider>${aiProviderOptions(provId)}</select></div>
      <div class="b-field"><label>API Key</label>
        <div class="b-flex">
          <input class="b-input" style="flex:1;min-width:0" type="password" id="ai-key" value="${esc(savedKey)}" placeholder="${prov.id === "ollama" ? "本地无需 Key，留空即可" : "sk-…，在 " + prov.keyHint + " 获取"}" autocomplete="off" />
          <button type="button" class="b-btn b-btn-sm b-btn-ghost" data-act="ai-key-eye" title="显示 / 隐藏">👁</button>
        </div>
        <p class="b-hint">Key 只保存在你自己的浏览器里，直连你选的接口，不会进入导出文件；不填也能用「🎨 图片灵感 / 📋 粘贴导入」。</p></div>
      <div class="b-row">
        <div class="b-field"><label>接口地址</label>
          <input class="b-input" id="ai-base" value="${esc(savedBase)}" /></div>
        <div class="b-field"><label>模型名</label>
          <input class="b-input" id="ai-model" value="${esc(savedModel)}" /></div>
      </div>
      <div class="b-flex" style="margin:2px 0 10px">
        <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--bk-muted)">
          <input type="checkbox" id="ai-persist" ${localStorage.getItem(LS_AI_KEY) !== null ? "checked" : ""} /> 记住我的 Key（存本机浏览器）
        </label>
        <span class="b-spacer"></span>
        <button type="button" class="b-btn b-btn-sm b-btn-ghost" data-act="ai-key-clear">清除已保存 Key</button>
      </div>
      <div class="b-note">${esc(brief)}</div>
      <div class="b-ai-log" id="ai-log">${msgs || '<span class="b-muted">打个招呼吧，比如：帮我把这次周末两天一夜的惊喜之旅安排成 4 站…</span>'}</div>
      <textarea class="b-textarea" id="ai-input" placeholder="口述你的想法……"></textarea>
      <div style="height:10px"></div>
      <div class="b-flex">
        <button class="b-btn b-btn-primary" data-act="ai-send">发送，让 AI 起草</button>
        <button class="b-btn b-btn-ghost" data-act="ai-apply">把 AI 结果填进草稿</button>
        <span class="b-spacer"></span>
        <button class="b-btn b-btn-sm b-btn-ghost" data-act="ai-clear">清空对话</button>
      </div>
      <p class="b-hint" style="margin-top:8px">安全说明：向导是纯本地网页——Key 只发往你选的接口、不经任何第三方服务器；被浏览器拦截（CORS）时请改用「📋 粘贴导入」（无需 Key）；想完全零 Key 可装 Ollama 本地。</p>`;
}

function renderPastePane(pane) {
  pane.innerHTML = `<div class="b-field"><label>1 · 复制这段提示词，发给任意 AI（DSH / 豆包 / DeepSeek / ChatGPT…）</label>
      <textarea class="b-textarea code" readonly rows="6" id="ai-prompt">${esc(AI_SYSTEM_PROMPT)}</textarea>
      <div style="height:8px"></div>
      <button class="b-btn b-btn-sm" data-act="ai-copy-prompt">复制提示词</button>
      <p class="b-hint">在对话里再补一句：主角是谁、几天、想去哪、想安排什么。</p></div>
      <div class="b-field"><label>2 · 把 AI 返回的 JSON 粘贴到这里，点导入</label>
      <textarea class="b-textarea code" rows="10" id="ai-json" placeholder='{"hero":{...},"stops":[...]}'></textarea>
      <div style="height:8px"></div>
      <button class="b-btn b-btn-primary" data-act="ai-import">导入（会覆盖行程与主角信息）</button></div>`;
}

function renderInspirationPane(pane) {
  const themeKey = (state.draft && state.draft.theme) || "seaside";
  pane.innerHTML = `<p class="b-desc">按主题与用途生成「可直接复制」的出图提示词——粘贴到即梦 / 豆包 / Midjourney 等生成，再把图传回本向导对应素材位。无需 Key。</p>
    <div class="b-row">
      <div class="b-field"><label>用途</label>
        <select class="b-select" id="insp-purpose">${IMAGE_PURPOSES.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("")}</select></div>
      <div class="b-field"><label>主题风格</label>
        <select class="b-select" id="insp-theme">${Object.entries(THEME_MATERIALS).map(([id, m]) => `<option value="${id}" ${id === themeKey ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
    </div>
    <div class="b-field"><label>出图提示词</label>
      <textarea class="b-textarea code" readonly rows="9" id="insp-out"></textarea>
      <div style="height:8px"></div>
      <button class="b-btn b-btn-primary" data-act="insp-copy">📋 复制提示词</button></div>
    <div class="b-field"><label>想让 AI 按你的画面想法定制？（需在「AI 对话」保存过 Key）</label>
      <textarea class="b-textarea" id="insp-detail" placeholder="如：这一站是海边傍晚第一次放烟花的时刻…"></textarea>
      <div style="height:8px"></div>
      <button class="b-btn b-btn-sm" data-act="insp-gen">✨ 让 AI 定制这段提示词</button>
    </div>`;
  refreshInspiration();
}

function refreshInspiration() {
  const out = document.getElementById("insp-out");
  if (!out) return;
  const purpose = (document.getElementById("insp-purpose") || {}).value || IMAGE_PURPOSES[0].id;
  const theme = (document.getElementById("insp-theme") || {}).value || "seaside";
  out.value = buildImagePrompt(purpose, theme, "");
}

function inspDetailPrompt() {
  const purpose = (document.getElementById("insp-purpose") || {}).value || IMAGE_PURPOSES[0].id;
  const theme = (document.getElementById("insp-theme") || {}).value || "seaside";
  const detail = (document.getElementById("insp-detail") || {}).value || "";
  return buildImagePrompt(purpose, theme, detail);
}

/* 用所配 LLM 定制出图提示词 */
async function genInspirationAi() {
  const promptText = inspDetailPrompt();
  const prov = aiProviderById(currentProviderId());
  const key = localStorage.getItem(LS_AI_KEY) || "";
  const base = (localStorage.getItem(LS_AI_BASE) || prov.base || AI_DEFAULT_BASE).replace(/\/+$/, "");
  const model = localStorage.getItem(LS_AI_MODEL) || prov.model || AI_DEFAULT_MODEL;
  if (!key && prov.id !== "ollama") {
    toast("请先在「AI 对话」里选择模型并保存 Key（或用 Ollama 本地）");
    renderAiPane("chat", {});
    return;
  }
  toast("正在生成定制提示词…");
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = "Bearer " + key;
  try {
    const resp = await fetch(base + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "你是资深 AI 出图提示词专家。把用户提供的出图需求润色成一段结构更细腻、可直接粘贴给即梦/Midjourney 等工具的中文提示词：包含画面层次、光线、笔触与构图留白；保留所有禁止项（无文字/水印/logo/人物面部等）。只输出提示词本体，不要任何解释。",
          },
          { role: "user", content: promptText },
        ],
        temperature: 0.9,
        max_tokens: 1200,
        stream: false,
      }),
    });
    if (!resp.ok) {
      const d = await resp.text().catch(() => "");
      throw new Error("HTTP " + resp.status + " " + d.slice(0, 120));
    }
    const data = await resp.json();
    const out =
      data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "";
    const el = document.getElementById("insp-out");
    if (el && out) {
      el.value = out.trim();
      toast("已生成定制提示词，可复制去生图");
    } else {
      toast("AI 没有返回内容，请重试或改走粘贴通道");
    }
  } catch (err) {
    console.error(err);
    toast(
      "生成失败：" + ((err && err.message) || err) +
        " —— 可用任意 AI 手动润色后复制回来",
    );
  }
}

async function sendAiMessage() {
  const input = $("ai-input");
  const text = (input.value || "").trim();
  if (!text) {
    toast("先告诉我你想安排什么");
    return;
  }
  const prov = aiProviderById(currentProviderId());
  const key = ($("ai-key").value || "").trim();
  const base = ($("ai-base").value || prov.base || AI_DEFAULT_BASE).replace(/\/+$/, "");
  const model = $("ai-model").value || prov.model || AI_DEFAULT_MODEL;
  if (!key && prov.id !== "ollama") {
    toast("请填写所选模型的 API Key（获取地址：" + prov.keyHint + "），或改用「粘贴导入 / Ollama 本地」");
    return;
  }
  // Key 持久化策略：默认存本机（可一键清除）；取消勾选则只在本会话内存使用
  const persist = !($("ai-persist") && !$("ai-persist").checked);
  localStorage.setItem(LS_AI_PROVIDER, prov.id);
  localStorage.setItem(LS_AI_BASE, base);
  localStorage.setItem(LS_AI_MODEL, model);
  if (persist && key) localStorage.setItem(LS_AI_KEY, key);
  else if (!persist) localStorage.removeItem(LS_AI_KEY);

  state.aiMessages.push({ role: "user", content: text });
  state.aiMessages.push({ role: "assistant", content: "（思考中…）" });
  renderAiPane("chat", {});
  const log = $("ai-log");
  if (log) log.scrollTop = log.scrollHeight;
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = "Bearer " + key;
  try {
    const resp = await fetch(base + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: AI_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 1.1,
        max_tokens: 3000,
        stream: false,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error("HTTP " + resp.status + " " + detail.slice(0, 160));
    }
    const data = await resp.json();
    const content =
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content
        ? data.choices[0].message.content
        : "";
    state.aiMessages[state.aiMessages.length - 1] = { role: "assistant", content };
    const json = extractJson(content);
    if (json) {
      state.lastAiJson = json;
      toast("AI 返回了草稿：点「把 AI 结果填进草稿」应用");
    } else {
      toast("AI 已回复（没认出 JSON，可让它重试或手动改）");
    }
  } catch (err) {
    state.aiMessages[state.aiMessages.length - 1] = {
      role: "assistant",
      content:
        "直连失败：" +
        err.message +
        "\n\n浏览器通常不允许网页直接请求 AI 接口（CORS）。请改用「粘贴导入」：复制提示词给任意 AI，把返回的 JSON 粘回来。",
    };
  }
  renderAiPane("chat", {});
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

function applyAiJson(json) {
  if (!json || !Array.isArray(json.stops) || !json.stops.length) {
    toast("这段 JSON 里没有站点列表，无法导入");
    return;
  }
  const d = state.draft;
  if (json.hero) {
    Object.assign(d.hero, {
      name: json.hero.name || d.hero.name,
      badge: json.hero.badge || d.hero.badge,
      datesLabel: json.hero.datesLabel || d.hero.datesLabel,
      coupleName: json.hero.coupleName || d.hero.coupleName,
      coupleNote: json.hero.coupleNote || d.hero.coupleNote,
    });
  }
  if (json.dayDates) {
    d.dayDates = Object.assign({}, json.dayDates);
    const days = Object.keys(d.dayDates)
      .map(Number)
      .filter((n) => n > 0);
    if (days.length) d.days = Math.max(...days);
  }
  d.stops = json.stops.map((s) => ({
    id: uid(),
    day: Number(s.day) || 1,
    title: s.title || "",
    short: s.short || "",
    place: s.place || "",
    story: Array.isArray(s.story) ? s.story.filter(Boolean) : [s.story].filter(Boolean),
    mood: s.mood || "",
    task: s.task || "",
    hint: s.hint || "",
    image: aiImageToRef(s.image),
    gallery: [],
    iconRefs: [],
    imageRefs: [],
    galleryCaption: [],
    icon: "m:assets/icons/secret-pavilion.webp",
    music: aiImageToMusic(s.image),
    action: s.action || "继续旅程",
    opensFinale: Boolean(s.opensFinale),
  }));
  state.lastAiJson = null;
  scheduleSave();
  toast("已导入 " + d.stops.length + " 站，去「行程与文案」里微调吧");
  state.step = 2;
  rerenderCurrent();
}

function aiImageToRef(image) {
  const key = String(image || "")
    .trim()
    .replace(/^m:assets\/ai\//, "")
    .replace(/\.webp$/, "");
  if (AI_IMAGE_CHOICES.includes(key)) return "m:assets/ai/" + key + ".webp";
  return "m:assets/ai/ai-bonfire.webp";
}

function aiImageToMusic(image) {
  const key = String(image || "").replace(/^ai-/, "");
  const map = {
    craft: "craft",
    cinema: "cinema",
    depart: "depart",
    resort: "resort",
    bonfire: "bonfire",
    omakase: "omakase",
    hotpot: "hotpot",
    spa: "spa",
    gift: "gift",
    return: "return",
  };
  return map[key] || "cover";
}

/* ---------- 第 4 步：预览与导出 ---------- */

async function draftToConfig(draft) {
  // 1. 收集用户照片（u: 引用）
  const refs = new Set();
  const collect = (v) => {
    if (typeof v === "string" && v.startsWith("u:")) refs.add(v.slice(2));
  };
  collect(draft.page && draft.page.ogImage);
  collect(draft.hero && draft.hero.coverImage);
  (draft.hero && draft.hero.avatars || []).forEach(collect);
  collect(draft.map && draft.map.background);
  (draft.stops || []).forEach((s) => {
    collect(s.image);
    collect(s.icon);
    (s.gallery || []).forEach(collect);
    (s.videos || []).forEach((v) => {
      collect(v.src);
      collect(v.poster);
    });
  });
  const photoMap = {};
  await Promise.all(
    Array.from(refs).map(async (id) => {
      const dataUrl = await PhotoLib.getPhoto(id);
      if (dataUrl) photoMap[id] = dataUrl;
    }),
  );
  const resolve = (ref) => {
    if (!ref) return "";
    if (ref.startsWith("m:")) return SRC.media[ref.slice(2)] || "";
    if (ref.startsWith("u:")) return photoMap[ref.slice(2)] || "";
    return ref;
  };

  // 2. 组装成品 config
  const cfg = clone(draft);
  cfg.uid = cfg.uid || uid();
  const hero = cfg.hero || {};
  if (!hero.name) hero.name = "TA";
  hero.coverImage = resolve(hero.coverImage);
  hero.avatars = (hero.avatars || []).map(resolve);
  const tl = hero.titleLines || [];
  hero.titleLines =
    tl.length === 2 && (tl[0] || "").trim() && (tl[1] || "").trim()
      ? tl
      : [hero.name + "，", (tl[1] || "").trim() || "生日快乐"];
  if (!hero.coupleName) hero.coupleName = "我 & " + hero.name;
  cfg.page = cfg.page || {};
  cfg.page.title =
    cfg.page.title && cfg.page.title.trim()
      ? cfg.page.title
      : hero.name + "的生日旅行";
  cfg.page.ogImage = resolve(cfg.page.ogImage || hero.coverImage);
  cfg.map = cfg.map || {};
  cfg.map.background = resolve(cfg.map.background);
  cfg.map.markerStyle = cfg.map.markerStyle === "card" ? "card" : "pin";
  // 校准过的站点坐标：数量与站点一致才保留，否则引擎自动排布
  if (!Array.isArray(cfg.map.positions) || cfg.map.positions.length !== cfg.stops.length) {
    delete cfg.map.positions;
  }
  cfg.stops.forEach((s) => {
    s.image = resolve(s.image);
    s.icon = resolve(s.icon) || SRC.media["assets/icons/secret-pavilion.webp"];
    const pics = (s.gallery || []).map(resolve).filter(Boolean);
    const caps = (s.galleryCaption || []).slice(0, pics.length);
    while (caps.length < pics.length) caps.push("");
    s.gallery = pics;
    s.galleryCaption = caps;
    s.videos = ((s.videos || []).map((v) => ({
      src: resolve(v.src),
      poster: resolve(v.poster),
      caption: v.caption || "",
    }))).filter((v) => v.src);
    if (!s.id) s.id = uid();
    delete s.iconRefs; // 收藏贴纸/图库只在编辑器里用，成品引擎只用 icon/image
    delete s.imageRefs;
  });
  cfg.copy = cfg.copy && Object.keys(cfg.copy).length ? cfg.copy : defaultCopy();
  if (!["seaside", "forest", "starry", "newlywed", "christmas"].includes(cfg.theme)) cfg.theme = "seaside";
  delete cfg.days;
  return cfg;
}

function assembleHtml(cfg) {
  const json = JSON.stringify(cfg).replace(/<\//g, "<\\/");
  let out = SRC.html;
  out = out.replace(
    '<link rel="stylesheet" href="styles.css" />',
    "<style>" + SRC.css + "</style>",
  );
  out = out.replace(
    '<script src="config.js"></script>',
    "<script>window.TRIP_CONFIG=" + json + ";<\/script>",
  );
  out = out.replace('<script src="app.js"></script>', "<script>" + SRC.js + "<\/script>");
  return out;
}

function bytesToText(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

let previewHtml = "";
let previewReady = false;

async function buildPreview() {
  const cfg = await draftToConfig(state.draft);
  previewHtml = assembleHtml(cfg);
  previewReady = true;
  return previewHtml;
}

function renderPreview(body) {
  const size = previewHtml
    ? bytesToText(new Blob([previewHtml]).size)
    : "…";
  body.innerHTML = `<section class="b-card">
    <div class="b-flex">
      <div><h2>预览与导出</h2>
      <p class="b-desc">下面是 TA 将会看到的成品（可以在预览里点着玩）。</p></div>
      <span class="b-spacer"></span>
      <button class="b-btn b-btn-sm" data-act="preview-refresh">⟳ 重新预览</button>
    </div>
    <p class="b-exportsize">成品体积：${size}</p>
    <iframe class="b-preview-frame" id="preview-frame" title="成品预览"></iframe>
  </section>
  <section class="b-card">
    <h2>怎么发给 TA？</h2>
    <ol class="b-desc" style="padding-left:18px;line-height:2">
      <li>点右下角「导出成品 HTML」，得到一个 .html 文件；</li>
      <li>电脑上双击就能打开；手机上把文件发到微信/QQ「文件传输助手」，用浏览器打开；</li>
      <li>想长期在线访问，把文件放到任意静态托管（GitHub Pages 等）即可。</li>
    </ol>
    <div class="b-note">导出文件会把照片全部内嵌进去——别人打开无需联网、无需安装任何东西。照片多时文件较大是正常的。</div>
  </section>`;
  if (!previewReady) {
    refreshPreview();
  } else {
    const frame = $("preview-frame");
    if (frame) frame.srcdoc = previewHtml;
  }
}

async function refreshPreview() {
  const frame = $("preview-frame");
  toast("正在生成预览…");
  try {
    await buildPreview();
    if (frame) frame.srcdoc = previewHtml;
    const sizeEl = document.querySelector(".b-exportsize");
    if (sizeEl)
      sizeEl.textContent = "成品体积：" + bytesToText(new Blob([previewHtml]).size);
    toast("预览已生成 ✓");
  } catch (err) {
    console.error(err);
    toast("生成预览失败：" + err.message);
  }
}

function validateDraft() {
  const d = state.draft;
  if (!d.stops.length) {
    toast("还没有任何一站——去「行程与文案」添加吧");
    return false;
  }
  const unnamed = d.stops
    .map((s, i) => (!s.title || !s.title.trim() ? i + 1 : -1))
    .filter((i) => i > 0);
  if (unnamed.length) {
    toast("第 " + unnamed.join("、") + " 站还没填名字");
    state.step = 2;
    rerenderCurrent();
    return false;
  }
  return true;
}

async function downloadHtml() {
  if (!validateDraft()) return;
  toast("正在打包…");
  try {
    const html = await buildPreview();
    const name = "birthday-trip.html";
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("已导出（" + bytesToText(blob.size) + "）");
  } catch (err) {
    console.error(err);
    toast("导出失败：" + err.message);
  }
}

/* ================================================================
 * 事件
 * ============================================================== */

function onInput(e) {
  const t = e.target;
  if (!t.dataset) return;
  // 站图标：输入 emoji
  if (t.dataset.iconEmoji !== undefined) {
    const idx = Number(t.dataset.iconEmoji);
    const stop = (state.draft.stops || [])[idx];
    if (stop) {
      const v = t.value.trim();
      if (v) stop.icon = "emoji:" + v;
      else if (stop.icon && stop.icon.startsWith("emoji:")) stop.icon = "";
      // 同步：取消内置图标高亮、移除旧的图标预览块（输入框本身即所见）
      const picker = t.closest(".b-pick");
      if (picker) {
        picker
          .querySelectorAll(".b-pick-item")
          .forEach((c) => c.classList.remove("is-on"));
      }
      removeIconThumb(idx);
      scheduleSave();
      refreshLive();
    }
    return;
  }
  if (t.dataset.p === undefined) return;
  const lines = t.dataset.lines === "1";
  const raw = lines ? t.value.split("\n") : t.value;
  const value =
    lines && Array.isArray(raw)
      ? raw.filter((line) => line.trim() !== "")
      : raw;
  setByPath(state.draft, t.dataset.p, value);
  if (t.dataset.p.endsWith(".title")) {
    const card = t.closest(".b-stop");
    if (card) {
      const head = card.querySelector(".b-stop-title");
      if (head) {
        head.textContent = t.value || "（未命名的一站）";
        head.classList.toggle("is-empty", !t.value);
      }
    }
  }
  scheduleSave();
  refreshLive();
}

function onChange(e) {
  const t = e.target;
  if (!t.dataset) return;
  if (t.dataset.aiProvider !== undefined) {
    // AI Provider 预设联动 base/model/key 提示
    const p = aiProviderById(t.value);
    const baseEl = document.getElementById("ai-base");
    if (baseEl && p.base) baseEl.value = p.base;
    const modelEl = document.getElementById("ai-model");
    if (modelEl && p.model) modelEl.value = p.model;
    const keyEl = document.getElementById("ai-key");
    if (keyEl) {
      keyEl.placeholder =
        p.id === "ollama"
          ? "本地无需 Key，留空即可"
          : "sk-…，在 " + p.keyHint + " 获取";
      if (p.id === "ollama") keyEl.value = "";
    }
    localStorage.setItem(LS_AI_PROVIDER, p.id);
    return;
  }
  if (t.id === "insp-purpose" || t.id === "insp-theme") {
    refreshInspiration();
    return;
  }
  if (t.type === "file") {
    handleUpload(t);
    return;
  }
  if (t.dataset.daysPreset !== undefined) {
    // 旅程天数：预设下拉 或 自定义
    if (t.value === "custom") {
      const customField = document.querySelector("[data-days-custom-field]");
      const customInput = document.querySelector("[data-days-custom]");
      if (customField) customField.style.display = "";
      if (customInput) customInput.focus();
      return;
    }
    setTripDays(Number(t.value));
    return;
  }
  if (t.dataset.daysCustom !== undefined) {
    // 自定义天数输入框（blur/回车时收口并刷新界面）
    const raw = String(t.value || "").trim();
    const n = Math.round(Number(raw));
    if (raw === "" || Number.isNaN(n) || n < 1) {
      // 清空或非法：恢复显示当前天数
      if (t.value === "") setTripDays(state.draft.days);
      return;
    }
    setTripDays(n);
    return;
  }
  if (t.type === "checkbox" && t.dataset.p !== undefined) {
    setByPath(state.draft, t.dataset.p, t.checked);
    scheduleSave();
    return;
  }
  if (t.tagName === "SELECT" && t.dataset.p !== undefined) {
    let value = t.value;
    if (t.dataset.num === "1") value = Number(value);
    setByPath(state.draft, t.dataset.p, value);
    // 修改了某站 day，标题同步
    const card = t.closest(".b-stop");
    if (card && t.dataset.p.endsWith(".day")) {
      const badge = card.querySelector(".b-stop-day");
      if (badge) badge.textContent = "DAY " + value;
    }
    scheduleSave();
  }
}

/* 设置旅程天数（1-30），自动清理超出的日期标签并重绘 */
function setTripDays(n) {
  const value = Math.min(21, Math.max(1, Math.round(n) || 1));
  state.draft.days = value;
  Object.keys(state.draft.dayDates || {}).forEach((k) => {
    if (Number(k) > value) delete state.draft.dayDates[k];
  });
  scheduleSave();
  rerenderCurrent(true); // 保留滚动位置
  // 若天数回到 1-10，收起自定义输入框
  if (value <= 10) {
    const field = document.querySelector("[data-days-custom-field]");
    if (field) field.style.display = "none";
  }
}

async function handleUpload(input) {
  const path = input.dataset.upload;
  const multi = input.dataset.multi === "1";
  const files = input.files;
  if (!files || !files.length) return;
  toast(multi ? "正在压缩并保存照片…" : "正在处理照片…");
  const result = await PhotoLib.filesToPhotos(files);
  const ids = result.added;
  const failed = result.failed || [];
  if (!ids.length) {
    // 一张都没成：给出具体原因，而不是笼统的「没有可用图片」
    const reason = failed.length
      ? failed[0].reason
      : "没有可用的图片（请选择 JPG/PNG 照片）";
    toast("添加失败：" + reason);
    return;
  }
  const d = state.draft;
  let hadOld = false;
  if (multi) {
    // 照片墙：永远「追加」，不覆盖已有照片
    const existed = getByPath(d, path);
    const cur = Array.isArray(existed) ? existed.slice() : [];
    ids.forEach((id) => cur.push("u:" + id));
    setByPath(d, path, cur);
  } else {
    // 单图位（封面/大图/头像/图标）：一张图的位置，新图替换旧图
    const oldRef = getByPath(d, path);
    hadOld = Boolean(oldRef);
    setByPath(d, path, "u:" + ids[0]);
    releasePhotoIfOrphan(oldRef); // 被顶掉的旧图若孤儿则释放
  }
  // 先把新照片的缩略图全部读出来缓存，再渲染——保证添加后立刻能看到
  await Promise.all(
    ids.map((id) =>
      PhotoLib.getPhoto(id).then((dataUrl) => {
        if (dataUrl) state.uiPhotoCache[id] = dataUrl;
      }),
    ),
  );
  scheduleSave();
  input.value = "";
  let storageNote = "";
  try {
    const m = await PhotoLib.detectMode();
    if (m !== "idb") {
      storageNote = "（本浏览器存储受限，照片按「" + PhotoLib.modeLabel(m) + "」保存）";
    }
    updateStorageLabel();
  } catch (err) {
    /* ignore */
  }
  const doneMsg = multi
    ? "已添加 " + ids.length + " 张照片"
    : hadOld
      ? "已替换为这张新图（单图位置，一张即换）"
      : "已设置这张图";
  toast(
    (failed.length ? doneMsg + "，" + failed.length + " 张失败" : doneMsg + " ✓") +
      storageNote,
  );
  rerenderCurrent(true); // 保留滚动位置，用户就在刚刚添加的位置看到照片
  hydratePhotos();
}

/* 把选择的图片文件加入某站的「贴纸收藏」：可多张、不替换已有、无当前图标时自动用第一张 */
/* 把选择的多张图加入某站的「素材库」（field: iconRefs 贴纸库 / imageRefs 大图库）。
 * 只入库与预览，不覆盖当前选中；当前为空时才自动用第一张。 */
async function addStickers(stopIdx, field, fileList) {
  const stop = (state.draft.stops || [])[stopIdx];
  if (!stop || !fileList || !fileList.length) return;
  const list = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
  if (!list.length) {
    toast("没有可用的图片（请选择 JPG/PNG）");
    return;
  }
  toast("正在压缩并加入素材库…");
  const result = await PhotoLib.filesToPhotos(list);
  const ids = result.added;
  if (!ids.length) {
    toast(
      "添加失败：" +
        (result.failed && result.failed.length
          ? result.failed[0].reason
          : "没有可用的图片"),
    );
    return;
  }
  if (!Array.isArray(stop[field])) stop[field] = [];
  const refs = ids.map((id) => "u:" + id);
  stop[field] = stop[field].concat(refs);
  const currentKey = field === "imageRefs" ? "image" : "icon";
  if (!stop[currentKey]) stop[currentKey] = refs[0]; // 原本没有当前图才自动用第一张
  await Promise.all(
    ids.map((id) =>
      PhotoLib.getPhoto(id).then((d) => {
        if (d) state.uiPhotoCache[id] = d;
      }),
    ),
  );
  scheduleSave();
  toast(
    "已加入素材库 " + refs.length + " 张（不会覆盖你已选的图）——点击某张即可设为当前" +
      (field === "imageRefs" ? "大图" : "图标"),
  );
  rerenderCurrent(true);
  hydratePhotos();
}

/* 照片若已不被草稿任何位置引用，就从存储中删除（释放 localStorage 空间） */
function releasePhotoIfOrphan(ref) {
  if (typeof ref !== "string" || !ref.startsWith("u:")) return;
  const marker = '"' + ref + '"';
  try {
    if (JSON.stringify(state.draft).indexOf(marker) !== -1) return; // 仍被引用
  } catch (err) {
    return;
  }
  PhotoLib.removePhoto(ref.slice(2)).catch(() => {});
  delete state.uiPhotoCache[ref.slice(2)];
}

/* 顶栏显示照片存储模式（IndexedDB 正常 / localStorage 轻量 / 仅本次会话） */
async function updateStorageLabel() {
  const el = $("b-saved");
  if (!el) return;
  try {
    const m = await PhotoLib.detectMode();
    el.textContent =
      m === "idb"
        ? "草稿与照片自动保存在本机浏览器"
        : "草稿保存在本机 · 照片存储：" +
          PhotoLib.modeLabel(m) +
          "（换 Chrome/Edge 普通窗口可获得更大存储）";
  } catch (err) {
    /* ignore */
  }
}

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;

  // 通用规则：任何「不可用」的按钮，点击都必须说明原因，而不是无声无息。
  // 原生 disabled 不会触发 click，所以禁用一律用 aria-disabled + data-tip 实现，
  // 让用户点得到、也提示得到。
  if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
    toast(btn.dataset.tip || "这一步暂时还不能点");
    return;
  }

  if (act === "goto") {
    const step = Number(btn.dataset.step);
    if (step < 0 || step >= STEPS.length) return;
    state.step = step;
    previewReady = false;
    renderAll();
    window.scrollTo(0, 0);
    return;
  }

  if (act === "start") {
    const mode = btn.dataset.mode;
    if (mode === "sample") {
      state.draft = sampleDraft();
      saveDraft();
      toast("已载入示例旅程，把它改成你的吧");
    } else if (mode === "blank") {
      state.draft = blankDraft();
      saveDraft();
      toast("从空白开始，去加第一站吧");
    }
    // continue：保留现有草稿
    state.stopOpen.clear();
    state.aiMessages = [];
    state.lastAiJson = null;
    state.step = 1;
    previewReady = false;
    renderAll();
    window.scrollTo(0, 0);
    return;
  }

  if (act === "pick") {
    const path = btn.dataset.path;
    const key = btn.dataset.key;
    setByPath(state.draft, path, "m:" + key);
    const container = btn.closest(".b-pick");
    if (container) {
      container
        .querySelectorAll(".b-pick-item")
        .forEach((c) => c.classList.remove("is-on"));
      btn.classList.add("is-on");
      // 站点选了内置图标时，清掉旁边的 emoji 输入与旧预览
      if (path.endsWith(".icon")) {
        const emoji = container.querySelector("[data-icon-emoji]");
        if (emoji) emoji.value = "";
        removeIconThumb(stopIndexFromPathIcon(path));
      }
    }
    thumbUpdateForPath(path, "m:" + key, btn.closest(".b-pick"));
    scheduleSave();
    return;
  }

  if (act === "pick-clear") {
    const path = btn.dataset.path;
    const oldRef = getByPath(state.draft, path);
    setByPath(state.draft, path, "");
    releasePhotoIfOrphan(oldRef);
    const container = btn.closest(".b-pick");
    if (container) {
      container
        .querySelectorAll(".b-pick-item")
        .forEach((c) => c.classList.remove("is-on"));
      if (path.endsWith(".icon")) {
        const emoji = container.querySelector("[data-icon-emoji]");
        if (emoji) emoji.value = "";
        removeIconThumb(stopIndexFromPathIcon(path));
      }
    }
    thumbUpdateForPath(path, "", btn.closest(".b-pick"));
    scheduleSave();
    return;
  }

  if (act === "pick-upload") {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = btn.dataset.multi === "1";
    input.dataset.upload = btn.dataset.path;
    input.dataset.multi = btn.dataset.multi;
    input.addEventListener("change", () => handleUpload(input));
    input.click();
    return;
  }

  if (act === "theme-set") {
    const picked = THEMES.find((t) => t.id === btn.dataset.theme);
    state.draft.theme = picked ? picked.id : "seaside";
    previewReady = false;
    document
      .querySelectorAll("[data-act='theme-set']")
      .forEach((c) => c.classList.toggle("is-on", c === btn));
    // 配套的地图背景：当前背景还是默认海边图或空 → 跟随主题；已自定义则保留
    const curBg = (state.draft.map && state.draft.map.background) || "";
    const isDefaultBg =
      curBg === "" || curBg === "m:assets/map/map-seaside.webp";
    if (picked && picked.mapBg && isDefaultBg) {
      state.draft.map = state.draft.map || {};
      state.draft.map.background = picked.mapBg;
      // 换背景后旧坐标不再匹配，清掉让用户重新校准或自动排布
      delete state.draft.map.positions;
    } else if (picked && picked.mapBg && !isDefaultBg) {
      toast(
        "风格已切换，但你有自定义地图背景，已为你保留（需要的话可在地图背景处换回默认）",
      );
      scheduleSave();
      renderAll();
      return;
    }
    scheduleSave();
    rerenderCurrent(true); // 同步地图背景选择区等界面
    toast(
      "风格已切换为「" + (picked ? picked.label : "") +
        "」——已配套" + (picked && picked.mapBg && isDefaultBg ? "地图背景，" : "") +
        "到「预览与导出」查看效果",
    );
    return;
  }

  if (act === "avatar-set") {
    const set = AVATAR_SETS.find((s) => s.id === btn.dataset.set);
    if (!set) return;
    const prev = (state.draft.hero && state.draft.hero.avatars) || [];
    state.draft.hero = state.draft.hero || {};
    state.draft.hero.avatars = set.keys.map((k) => "m:" + k);
    document
      .querySelectorAll("[data-act='avatar-set']")
      .forEach((c) => c.classList.toggle("is-on", c === btn));
    scheduleSave();
    rerenderCurrent(true);
    toast(
      (prev.length ? "已换成「" : "已放上「") +
        set.label +
        "」这对小人——封面落款与地图上沿路线走的都是他们",
    );
    return;
  }

  if (act === "map-style") {
    state.draft.map = state.draft.map || {};
    state.draft.map.markerStyle = btn.dataset.style === "card" ? "card" : "pin";
    previewReady = false;
    scheduleSave();
    rerenderCurrent(true);
    toast(btn.dataset.style === "card" ? "已切换为卡片式标记" : "已切换为图钉式标记（尖角指向地标）");
    return;
  }

  if (act === "calib-open") {
    state.calibOpen = true;
    rerenderCurrent(true);
    setTimeout(() => {
      const panel = document.getElementById("calib-panel");
      if (panel) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 60);
    return;
  }

  if (act === "calib-close") {
    state.calibOpen = false;
    scheduleSave();
    rerenderCurrent(true);
    return;
  }

  if (act === "calib-auto") {
    const d = state.draft;
    if (d && d.map) delete d.map.positions;
    scheduleSave();
    rerenderCurrent(true);
    toast("已重置为自动排列，可再拖动校准");
    return;
  }

  if (act === "icon-upload" || act === "image-upload") {
    const field = act === "image-upload" ? "imageRefs" : "iconRefs";
    const stopIdx = Number(btn.dataset.stop);
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.addEventListener("change", () => addStickers(stopIdx, field, input.files));
    input.click();
    return;
  }

  if (act === "icon-select" || act === "image-select") {
    const field = act === "image-select" ? "imageRefs" : "iconRefs";
    const curKey = act === "image-select" ? "image" : "icon";
    const stop = (state.draft.stops || [])[Number(btn.dataset.stop)];
    const ref = stop && (stop[field] || [])[Number(btn.dataset.ri)];
    if (ref && stop[curKey] !== ref) {
      stop[curKey] = ref;
      scheduleSave();
      rerenderCurrent(true);
    }
    return;
  }

  if (act === "icon-ref-del" || act === "image-ref-del") {
    const field = act === "image-ref-del" ? "imageRefs" : "iconRefs";
    const curKey = act === "image-ref-del" ? "image" : "icon";
    const stop = (state.draft.stops || [])[Number(btn.dataset.stop)];
    const ri = Number(btn.dataset.ri);
    if (!stop || !Array.isArray(stop[field])) return;
    const removed = stop[field].splice(ri, 1)[0];
    if (stop[curKey] === removed) stop[curKey] = "";
    releasePhotoIfOrphan(removed);
    scheduleSave();
    rerenderCurrent(true);
    hydratePhotos();
    return;
  }

  if (act === "stop-add") {
    const d = state.draft;
    const last = d.stops[d.stops.length - 1];
    const idx = d.stops.length;
    d.stops.push({
      id: uid(),
      day: last ? last.day : 1,
      title: "",
      short: "",
      place: "",
      story: [],
      mood: "",
      task: "",
      hint: "",
      image: "m:assets/ai/ai-" + AI_IMAGE_CHOICES[idx % AI_IMAGE_CHOICES.length] + ".webp",
      icon: "m:assets/icons/secret-pavilion.webp",
      music: "cover",
      gallery: [],
      iconRefs: [],
      imageRefs: [],
      galleryCaption: [],
      action: "继续旅程",
    });
    state.stopOpen.add(d.stops.length - 1);
    scheduleSave();
    rerenderCurrent();
    window.scrollTo(0, document.body.scrollHeight);
    return;
  }

  if (act === "stop-toggle") {
    const i = Number(btn.dataset.i);
    if (state.stopOpen.has(i)) state.stopOpen.delete(i);
    else state.stopOpen.add(i);
    const card = document.querySelector(`[data-stop="${i}"]`);
    if (card) card.classList.toggle("is-open");
    return;
  }

  if (act === "stop-move") {
    const d = state.draft;
    const i = Number(btn.dataset.i);
    const j = i + Number(btn.dataset.dir);
    if (j < 0 || j >= d.stops.length) return;
    const tmp = d.stops[i];
    d.stops[i] = d.stops[j];
    d.stops[j] = tmp;
    scheduleSave();
    rerenderCurrent();
    return;
  }

  if (act === "stop-copy") {
    const d = state.draft;
    const i = Number(btn.dataset.i);
    const copy = clone(d.stops[i]);
    copy.id = uid();
    copy.title = (copy.title || "") + "（副本）";
    d.stops.splice(i + 1, 0, copy);
    state.stopOpen.add(i + 1);
    scheduleSave();
    rerenderCurrent();
    return;
  }

  if (act === "stop-del") {
    const d = state.draft;
    const i = Number(btn.dataset.i);
    if (!confirm(`删除第 ${i + 1} 站「${d.stops[i].title || "未命名"}」？照片仍保留在草稿库。`)) {
      return;
    }
    d.stops.splice(i, 1);
    state.stopOpen.delete(i);
    scheduleSave();
    rerenderCurrent();
    return;
  }

  if (act === "photo-del") {
    const stop = Number(btn.dataset.stop);
    const idx = Number(btn.dataset.idx);
    const s = state.draft.stops[stop];
    if (!s) return;
    const removed = s.gallery[idx];
    s.gallery.splice(idx, 1);
    if (Array.isArray(s.galleryCaption)) s.galleryCaption.splice(idx, 1);
    releasePhotoIfOrphan(removed); // 不再被引用则释放存储空间
    scheduleSave();
    rerenderCurrent();
    hydratePhotos();
    return;
  }

  if (act === "ai-tab") {
    renderAiPane(btn.dataset.tab, {});
    return;
  }

  if (act === "ai-copy-prompt") {
    const el = $("ai-prompt");
    if (!el) return;
    await copyText(el.value);
    return;
  }

  if (act === "ai-key-eye") {
    const el = $("ai-key");
    if (!el) return;
    const isPw = el.type === "password";
    el.type = isPw ? "text" : "password";
    btn.textContent = isPw ? "🙈" : "👁";
    return;
  }

  if (act === "ai-key-clear") {
    localStorage.removeItem(LS_AI_KEY);
    const el = $("ai-key");
    if (el) el.value = "";
    toast("已清除本机保存的 Key");
    return;
  }

  if (act === "insp-copy") {
    const el = $("insp-out");
    if (!el) return;
    await copyText(el.value);
    return;
  }

  if (act === "insp-gen") {
    genInspirationAi();
    return;
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value || "");
      toast("已复制到剪贴板");
    } catch (err) {
      toast("请手动复制上方文本");
    }
  }

  if (act === "ai-send") {
    sendAiMessage();
    return;
  }

  if (act === "ai-clear") {
    state.aiMessages = [];
    state.lastAiJson = null;
    renderAiPane("chat", {});
    return;
  }

  if (act === "ai-apply") {
    const json = state.lastAiJson || extractLastAiJson();
    if (json) {
      applyAiJson(json);
    } else {
      toast("还没找到 AI 返回的 JSON，先发一条消息吧");
    }
    return;
  }

  function extractLastAiJson() {
    const msgs = state.aiMessages || [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === "assistant") {
        const found = extractJson(msgs[i].content);
        if (found) return found;
      }
    }
    return null;
  }

  if (act === "ai-import") {
    const el = $("ai-json");
    if (!el) return;
    const json = extractJson(el.value);
    if (!json) {
      toast("没认出 JSON，请粘贴 AI 返回的完整内容");
      return;
    }
    applyAiJson(json);
    return;
  }

  if (act === "preview-refresh") {
    refreshPreview();
    return;
  }

  if (act === "download") {
    downloadHtml();
    return;
  }
}

function bind() {
  // 事件委托必须挂在 document 上：步骤条(#b-steps)与底部导航(#b-nav)
  // 是 #b-body 的兄弟节点，只绑 #b-body 会漏掉它们（曾经的导航全灭 bug）
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  document.addEventListener("click", onClick);
}

/* ================================================================
 * 自检（?selftest=1）
 * ============================================================== */

window.addEventListener("error", (event) => {
  window.__builderErrors = window.__builderErrors || [];
  window.__builderErrors.push(event.message || "unknown error");
});

async function runSelfTest() {
  state.draft = sampleDraft();
  state.draft.hero.name = "测试";
  const cfg = await draftToConfig(state.draft);
  const html = assembleHtml(cfg);
  const report = {
    ok: true,
    stops: cfg.stops.length,
    heroName: cfg.hero.name,
    embeddedImages: (html.match(/data:image/g) || []).length,
    htmlBytes: new Blob([html]).size,
    stylesInlined: !html.includes('href="styles.css"'),
    configInlined: html.includes("window.TRIP_CONFIG=") && !html.includes('src="config.js"'),
    engineInlined: !html.includes('src="app.js"'),
    errors: window.__builderErrors || [],
  };
  const pre = document.createElement("pre");
  pre.id = "builder-selftest-report";
  pre.textContent = JSON.stringify(report);
  document.body.appendChild(pre);
}

/* 端到端：把导出的单文件装进 iframe 真跑一次成品引擎 */
async function runE2E() {
  state.draft = sampleDraft();
  state.draft.hero.name = "测试";
  const cfg = await draftToConfig(state.draft);
  const html = assembleHtml(cfg);
  const frame = document.createElement("iframe");
  frame.style.cssText = "width:390px;height:700px;border:0";
  document.body.appendChild(frame);
  frame.srcdoc = html;
  await new Promise((resolve) => {
    const done = () => resolve();
    frame.addEventListener("load", done);
    setTimeout(done, 15000); // 兜底
  });
  await new Promise((r) => setTimeout(r, 1200)); // 等 app.js 渲染完
  const doc = frame.contentDocument;
  const images = Array.from(doc.images || []);
  const report = {
    ok: true,
    title: doc.title,
    activeScreen: doc.querySelector(".screen.is-active")
      ? doc.querySelector(".screen.is-active").id
      : null,
    markers: (doc.querySelectorAll(".map-marker") || []).length,
    coverTitle: doc.querySelector("#cover-title")
      ? doc.querySelector("#cover-title").textContent
      : null,
    brokenImages: images.filter((i) => {
      const s = i.getAttribute("src");
      return s && (!i.complete || i.naturalWidth === 0);
    }).length,
    brokenSrcs: images
      .filter((i) => {
        const s = i.getAttribute("src");
        return s && (!i.complete || i.naturalWidth === 0);
      })
      .map((i) => (i.getAttribute("src") || "").slice(0, 70)),
    engineErrors: doc.__tripErrors || [],
  };
  const pre = document.createElement("pre");
  pre.id = "builder-e2e-report";
  pre.textContent = JSON.stringify(report);
  document.body.appendChild(pre);
}

/* UI 真实流程自检（?uidebug=1）：绑定事件、逐步骤渲染、真实派发点击 */
window.addEventListener("unhandledrejection", (event) => {
  window.__builderErrors = window.__builderErrors || [];
  window.__builderErrors.push("unhandled:" + (event.reason && event.reason.message ? event.reason.message : String(event.reason)));
});

async function runUIDebug() {
  const log = [];
  const push = (msg) => log.push(msg);
  // 统计真实点击是否到达 body（捕获阶段）
  let bodyClickCount = 0;
  const counter = () => {
    bodyClickCount += 1;
  };
  try {
    bind();
    document.body.addEventListener("click", counter, true);
    state.draft = sampleDraft();
    state.stopOpen.clear();
    state.step = 0;
    renderAll();
    push("boot:body=" + ($("b-body").textContent || "").trim().slice(0, 40).replace(/\n/g, " "));

    // 探测欢迎页主按钮是否被遮挡（真实命中测试）
    probe(push, "欢迎start", '[data-act="start"][data-mode="sample"]');

    // 真实点击「从示例旅程开始」
    const startBtn = document.querySelector('[data-act="start"][data-mode="sample"]');
    if (startBtn) startBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    push("afterStart:step=" + state.step + " clicks=" + bodyClickCount);

    // 探测 basic 步导航按钮是否被遮挡
    probe(push, "nav下一步", '.b-nav [data-act="goto"]');

    // 依次点步骤条每个标签
    const gotoSteps = [1, 2, 3, 4];
    for (const s of gotoSteps) {
      const btn = document.querySelector(`[data-act="goto"][data-step="${s}"]`);
      push(
        `g${s}btn=` +
          (btn
            ? "found disabled=" + btn.disabled + " aria=" + btn.getAttribute("aria-disabled")
            : "NOTFOUND"),
      );
      if (btn) {
        const before = state.step;
        btn.click();
        await new Promise((r) => setTimeout(r, 30));
        push(`goto${s}:step ${before}->${state.step} clicks=${bodyClickCount}`);
      }
    }
    // 检查 assist / preview 两步的内容完整性
    state.step = 3;
    renderAll();
    push(
      "assist:" +
        "ai-pane=" + ($("ai-pane") ? ($("ai-pane").textContent || "").trim().length : "MISSING") +
        " tabs=" + document.querySelectorAll(".b-tabs button").length +
        " hasKey=" + Boolean($("ai-key")) +
        " hasLog=" + Boolean($("ai-log")) +
        " hasInput=" + Boolean($("ai-input")) +
        " bodyLen=" + ($("b-body").textContent || "").length,
    );
    state.step = 4;
    renderAll();
    // preview 会自动触发 refreshPreview（异步），这里只等一拍
    await new Promise((r) => setTimeout(r, 600));
    push(
      "preview:" +
        "frame=" + Boolean($("preview-frame")) +
        " downloadBtn=" + Boolean(document.querySelector('[data-act="download"]')) +
        " previewReady=" + previewReady +
        " previewBytes=" + (previewHtml ? new Blob([previewHtml]).size : 0),
    );
    push("finalStep=" + state.step);
  } catch (err) {
    push("ERR:" + err.message);
    console.error(err);
  }
  document.body.removeEventListener("click", counter, true);
  const report = {
    log,
    errors: window.__builderErrors || [],
  };
  const pre = document.createElement("pre");
  pre.id = "builder-ui-report";
  pre.textContent = JSON.stringify(report);
  document.body.appendChild(pre);
}

function probe(push, label, selector) {
  const el = document.querySelector(selector);
  if (!el) {
    push(`${label}: NO EL`);
    return;
  }
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const top = document.elementFromPoint(cx, cy);
  push(
    `${label}: rect=${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)} topEl=${top ? top.tagName + "." + (top.className || "").toString().slice(0, 40) : "NONE"} inside=${top === el || (top && el.contains(top))}`,
  );
}

/* 上传链路自检（?uploadtest=1）：内置 1×1 PNG 走压缩+IndexedDB 全链路 */
async function runUploadTest() {
  const report = { step: "builtin-png" };
  const finish = () => {
    const pre = document.createElement("pre");
    pre.id = "builder-upload-report";
    pre.textContent = JSON.stringify(report);
    document.body.appendChild(pre);
  };
  try {
    // 真实链路与兜底并行：headless 虚拟时间下 IDB 等异步可能被截断
    await Promise.race([
      (async () => {
        const b64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], "selftest-photo.png", { type: "image/png" });
        const result = await PhotoLib.filesToPhotos([file]);
        report.added = result.added.length;
        report.failed = result.failed;
        if (result.added.length) {
          const url = await PhotoLib.getPhoto(result.added[0]);
          report.readBack = url ? url.slice(0, 30) : "MISSING";
        }
        report.idbOk = true;
      })(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    report.protocol = location.protocol;
    report.timed = true;
    finish();
  } catch (err) {
    report.idbOk = false;
    report.error = String((err && err.message) || err);
    report.protocol = location.protocol;
    finish();
  }
}

/* ---------- 启动 ---------- */
loadDraft();
const qParams = new URLSearchParams(location.search);
if (qParams.get("selftest") === "1") {
  runSelfTest();
} else if (qParams.get("e2e") === "1") {
  runE2E();
} else if (qParams.get("uidebug") === "1") {
  runUIDebug();
} else if (qParams.get("uploadtest") === "1") {
  runUploadTest();
} else {
  // 调试直达：?view=0..4 直接进入对应步骤（无草稿时自动载入示例）
  const viewParam = qParams.get("view");
  if (viewParam !== null) {
    if (!state.draft) state.draft = sampleDraft();
    const v = Math.min(Math.max(Number(viewParam) || 0, 0), STEPS.length - 1);
    state.step = v;
    previewReady = false;
  }
  // 调试：?calib=1 打开校准面板（可配 ?theme=newlywed 演示配套背景）
  const themeParam = qParams.get("theme");
  if (themeParam && state.draft && THEMES.some((t) => t.id === themeParam)) {
    state.draft.theme = themeParam;
    const withBg = THEMES.find((t) => t.id === themeParam);
    if (withBg && withBg.mapBg) {
      state.draft.map = state.draft.map || {};
      state.draft.map.background = withBg.mapBg;
      delete state.draft.map.positions;
    }
  }
  if (qParams.get("calib") === "1" && state.draft) {
    state.calibOpen = true;
  }
  // 调试：?openstop=N 展开某一站
  const openParam = qParams.get("openstop");
  if (openParam !== null && state.draft) {
    state.stopOpen.add(Math.min(Math.max(Number(openParam) || 0, 0), (state.draft.stops || []).length - 1));
  }
  bind();
  renderAll();
  updateStorageLabel();
  // 调试：?aitab=chat|inspiration|paste 直达 AI 子页
  const aitab = qParams.get("aitab");
  if (aitab && document.getElementById("ai-pane")) {
    renderAiPane(aitab === "inspiration" || aitab === "paste" ? aitab : "chat", {});
  }
}
