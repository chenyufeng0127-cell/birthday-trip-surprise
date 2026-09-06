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
    toast("草稿保存失败（浏览器存储已满？）");
  }
}

/* 把成品 config（对象）转成草稿（路径引用 → ref） */
function cfgToDraft(cfg) {
  const media = SRC.media;
  const toRef = (value) =>
    typeof value === "string" && media[value] ? "m:" + value : value;
  const draft = clone(cfg);
  draft.uid = cfg.uid || uid();
  const days = [...new Set((cfg.stops || []).map((s) => s.day))];
  draft.days = days.length ? Math.max(...days) : 3;
  draft.page = draft.page || {};
  draft.page.ogImage = toRef(draft.page.ogImage);
  draft.hero = draft.hero || {};
  draft.hero.coverImage = toRef(draft.hero.coverImage);
  draft.hero.avatars = (draft.hero.avatars || []).map(toRef);
  draft.map = draft.map || {};
  draft.map.background = toRef(draft.map.background);
  (draft.stops || []).forEach((stop) => {
    stop.image = toRef(stop.image);
    stop.icon = toRef(stop.icon);
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

function blankDraft() {
  return {
    uid: uid(),
    days: 3,
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
    map: { background: "m:assets/map/map-seaside.webp" },
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

function rerenderCurrent() {
  const body = $("b-body");
  const stepId = STEPS[state.step].id;
  renderStep(body, stepId);
  window.scrollTo(0, 0);
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
    <h2>旅程安排</h2>
    <div class="b-field"><label>一共几天？</label>
      <select class="b-select" data-p="days" data-num="1">
        ${Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}" ${(d.days || 3) === i + 1 ? "selected" : ""}>${i + 1} 天</option>`).join("")}
      </select></div>
    <div class="b-flex" style="align-items:flex-end">${daysInputs}</div>
    <p class="b-hint">接着到「行程与文案」里按天添加每一站。</p>
  </section>

  <section class="b-card">
    <h2>封面大图</h2>
    ${imagePicker("hero.coverImage", h.coverImage || "", { media: mediaKeysOf("assets/ai"), pickLabel: "用自己的照片" })}
    <div class="b-note">封面图最好偏深色，白色文字会更清晰；也可以用自己的照片。</div>
  </section>

  <section class="b-card">
    <h2>落款头像（可选）</h2>
    ${imagePicker("hero.avatars.0", (h.avatars || [])[0] || "", { media: [], pickLabel: "加第一张头像" })}
    <div style="height:8px"></div>
    ${imagePicker("hero.avatars.1", (h.avatars || [])[1] || "", { media: [], pickLabel: "加第二张头像" })}
    <p class="b-hint">留空也可以：封面不显示头像，地图上的小人会自动隐藏。</p>
  </section>

  <section class="b-card">
    <h2>地图背景</h2>
    ${imagePicker("map.background", (d.map && d.map.background) || "", { media: mediaKeysOf("assets/map"), pickLabel: "上传自己的地图背景", allowClear: true })}
    <p class="b-hint">不想用地图片也可以「清除」：成品会自动变成好看的纯色地图。</p>
  </section>`;
}

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

function thumbUpdateForPath(path, ref) {
  const img = document.querySelector(`[data-pickprev="${cssId(path)}"]`);
  const holder = document.querySelector(`[data-u-to="pic:${cssId(path)}"]`);
  const wrap = (img && img.closest(".b-flex")) || (holder && holder.closest(".b-flex"));
  if (!wrap) return;
  const src = ref
    ? ref.startsWith("m:")
      ? SRC.media[ref.slice(2)]
      : ref.startsWith("u:")
        ? state.uiPhotoCache[ref.slice(2)] || ""
        : ref
    : "";
  if (!src) {
    if (holder) holder.textContent = ref ? "加载照片…" : "";
    return;
  }
  if (holder) holder.closest(".b-flex").remove();
  const existing = wrap.querySelector("[data-pickprev]");
  if (existing) {
    existing.src = src;
  } else {
    wrap.innerHTML = `<img data-pickprev="${cssId(path)}" src="${src}" alt="" style="width:118px;height:76px;object-fit:cover;border-radius:10px;border:1px solid var(--bk-line)" />
      <span class="b-muted" style="font-size:12px">${ref.startsWith("u:") ? "你上传的照片" : "当前已选"}</span>`;
  }
}

/* ---------- 第 2 步：行程与文案 ---------- */

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
          <div class="b-field"><label>站点名 *</label>
            <input class="b-input" data-p="stops.${i}.title" value="${esc(stop.title || "")}" placeholder="如：印记工坊" /></div>
          <div class="b-row">
            <div class="b-field"><label>第几天</label>
              <select class="b-select" data-p="stops.${i}.day" data-num="1">${dayOptions}</select></div>
            <div class="b-field"><label>一句话简介（地图面板显示）</label>
              <input class="b-input" data-p="stops.${i}.short" value="${esc(stop.short || "")}" placeholder="如：下午，去做一件能一直戴着的纪念。" /></div>
          </div>
          <div class="b-field"><label>这一站在哪（可选小标签）</label>
            <input class="b-input" data-p="stops.${i}.place" value="${esc(stop.place || "")}" placeholder="如：这一站是：手作工坊里" /></div>
          <div class="b-field"><label>正文故事（每行一段，TA 会逐段阅读）</label>
            <textarea class="b-textarea" style="min-height:110px" data-p="stops.${i}.story" data-lines="1" placeholder="每行一段……">${esc((stop.story || []).join("\n"))}</textarea></div>
          <div class="b-field"><label>这一站的心情（一句话）</label>
            <input class="b-input" data-p="stops.${i}.mood" value="${esc(stop.mood || "")}" placeholder="如：有些约定不必说出口，戴在手上就够了。" /></div>
          <div class="b-row">
            <div class="b-field"><label>小任务（可留空）</label>
              <input class="b-input" data-p="stops.${i}.task" value="${esc(stop.task || "")}" placeholder="如：把两件作品放在一起合影" /></div>
            <div class="b-field"><label>卡片提示（填了就有骰子小游戏）</label>
              <input class="b-input" data-p="stops.${i}.hint" value="${esc(stop.hint || "")}" placeholder="如：第 1 张卡：手作卡" /></div>
          </div>
          <div class="b-field"><label>站图标（地图上的小图标）</label>
            <div class="b-pick">${iconChips}</div></div>
          <div class="b-field"><label>章节大图（进入这一站看到的大图）</label>
            <div class="b-pick">
              ${thumbBlock("stops.${i}.image", stop.image || "")}
              ${imageChips}
              <button class="b-btn b-btn-sm" data-act="pick-upload" data-path="stops.${i}.image" data-multi="0">📷 用自己的照片</button>
              ${stop.image ? `<button class="b-btn b-btn-sm b-btn-ghost" data-act="pick-clear" data-path="stops.${i}.image">清除</button>` : ""}
            </div></div>
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
      const target = el.getAttribute("data-u-to");
      const path = "u:" + id;
      const refPath = target ? "pic:" : "";
      if (target) {
        const holder = el.closest(".b-flex");
        if (holder) holder.remove();
        // 找到该 picker 容器并刷新预览
        const container = el.closest(".b-pick");
        if (container) {
          container.insertAdjacentHTML(
            "afterbegin",
            `<div class="b-flex" style="margin-bottom:8px">
              <img data-pickprev="${refPath ? "" : ""}" src="${dataUrl}" alt="" style="width:118px;height:76px;object-fit:cover;border-radius:10px;border:1px solid var(--bk-line)" />
              <span class="b-muted" style="font-size:12px">你上传的照片</span>
            </div>`,
          );
        }
      }
    });
  });
}

/* ---------- 第 3 步：AI 助手 ---------- */

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
- image 只能取以下之一（省略也行）：${AI_IMAGE_CHOICES.join(" / ")}。
- 最后一站在 stops 末尾补充 "opensFinale": true 和 "action": "打开最后的惊喜"。
- 不要编造真实姓名，name 用昵称。`;

function renderAssist(body) {
  body.innerHTML = `
  <section class="b-card">
    <h2>让 AI 帮你起草</h2>
    <p class="b-desc">跟 AI 说一句「帮我安排一次 XX」，就能得到一份可以再改的草稿。两种用法任选：
    <br />① 直接在下面和 AI 对话（要填你自己的 DeepSeek API Key）；
    <br />② 用任意聊天 AI（DSH / DeepSeek 网页版 / ChatGPT）——复制提示词，把返回的 JSON 粘贴回来导入。</p>
    <div class="b-tabs">
      <button class="is-on" data-act="ai-tab" data-tab="chat">💬 AI 对话</button>
      <button data-act="ai-tab" data-tab="paste">📋 粘贴导入</button>
    </div>
    <div id="ai-pane"></div>
  </section>`;
  renderAiPane("chat", {});
}

function renderAiPane(tab, _opts) {
  const pane = $("ai-pane");
  if (!pane) return;
  document.querySelectorAll(".b-tabs button").forEach((b) => {
    b.classList.toggle("is-on", b.dataset.tab === tab);
  });
  if (tab === "chat") {
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
    pane.innerHTML = `<div class="b-field"><label>DeepSeek API Key（只存在这台电脑的浏览器里，直接连官方）</label>
      <input class="b-input" type="password" id="ai-key" value="${esc(localStorage.getItem(LS_AI_KEY) || "")}" placeholder="sk-…" /></div>
      <div class="b-row">
        <div class="b-field"><label>接口地址（一般不用改）</label>
          <input class="b-input" id="ai-base" value="${esc(localStorage.getItem(LS_AI_BASE) || AI_DEFAULT_BASE)}" /></div>
        <div class="b-field"><label>模型</label>
          <input class="b-input" id="ai-model" value="${esc(localStorage.getItem(LS_AI_MODEL) || AI_DEFAULT_MODEL)}" /></div>
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
      <p class="b-hint" style="margin-top:8px">若直连被浏览器拦截（CORS），改用「粘贴导入」：把这段提示词复制给任意 AI，把返回的 JSON 粘回来即可。</p>`;
  } else {
    pane.innerHTML = `<div class="b-field"><label>1 · 复制这段提示词，发给任意 AI（DSH / DeepSeek 网页版 / ChatGPT…）</label>
      <textarea class="b-textarea code" readonly rows="6" id="ai-prompt">${esc(AI_SYSTEM_PROMPT)}</textarea>
      <div style="height:8px"></div>
      <button class="b-btn b-btn-sm" data-act="ai-copy-prompt">复制提示词</button>
      <p class="b-hint">在对话里再补一句：主角是谁、几天、想去哪、想安排什么。</p></div>
      <div class="b-field"><label>2 · 把 AI 返回的 JSON 粘贴到这里，点导入</label>
      <textarea class="b-textarea code" rows="10" id="ai-json" placeholder='{"hero":{...},"stops":[...]}'></textarea>
      <div style="height:8px"></div>
      <button class="b-btn b-btn-primary" data-act="ai-import">导入（会覆盖行程与主角信息）</button></div>`;
  }
}

async function sendAiMessage() {
  const input = $("ai-input");
  const text = (input.value || "").trim();
  if (!text) {
    toast("先告诉我你想安排什么");
    return;
  }
  const key = ($("ai-key").value || "").trim();
  if (!key) {
    toast("先填写 DeepSeek API Key（platform.deepseek.com 获取，很便宜）");
    return;
  }
  const base = ($("ai-base").value || AI_DEFAULT_BASE).replace(/\/+$/, "");
  const model = $("ai-model").value || AI_DEFAULT_MODEL;
  localStorage.setItem(LS_AI_KEY, key);
  localStorage.setItem(LS_AI_BASE, base);
  localStorage.setItem(LS_AI_MODEL, model);

  state.aiMessages.push({ role: "user", content: text });
  state.aiMessages.push({ role: "assistant", content: "（思考中…）" });
  renderAiPane("chat", {});
  const log = $("ai-log");
  if (log) log.scrollTop = log.scrollHeight;
  try {
    const resp = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
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
  });
  cfg.copy = cfg.copy && Object.keys(cfg.copy).length ? cfg.copy : defaultCopy();
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
  if (!t.dataset || t.dataset.p === undefined) return;
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
}

function onChange(e) {
  const t = e.target;
  if (!t.dataset) return;
  if (t.type === "file") {
    handleUpload(t);
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
    if (t.dataset.p === "days") {
      Object.keys(state.draft.dayDates || {}).forEach((k) => {
        if (Number(k) > value) delete state.draft.dayDates[k];
      });
      scheduleSave();
      rerenderCurrent();
      return;
    }
    // 修改了某站 day，标题同步
    const card = t.closest(".b-stop");
    if (card && t.dataset.p.endsWith(".day")) {
      const badge = card.querySelector(".b-stop-day");
      if (badge) badge.textContent = "DAY " + value;
    }
    scheduleSave();
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
  if (multi) {
    const cur = getByPath(d, path) || [];
    ids.forEach((id) => cur.push("u:" + id));
    setByPath(d, path, cur);
  } else {
    setByPath(d, path, "u:" + ids[0]);
  }
  ids.forEach((id) => {
    PhotoLib.getPhoto(id).then((dataUrl) => {
      if (dataUrl) state.uiPhotoCache[id] = dataUrl;
    });
  });
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
  if (failed.length) {
    toast(
      "已添加 " + ids.length + " 张，另有 " + failed.length + " 张失败：" +
        failed[0].reason,
    );
  } else {
    toast("照片已添加 ✓" + storageNote);
  }
  rerenderCurrent();
  hydratePhotos();
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
    }
    thumbUpdateForPath(path, "m:" + key);
    scheduleSave();
    return;
  }

  if (act === "pick-clear") {
    const path = btn.dataset.path;
    setByPath(state.draft, path, "");
    const container = btn.closest(".b-pick");
    if (container) {
      container
        .querySelectorAll(".b-pick-item")
        .forEach((c) => c.classList.remove("is-on"));
    }
    thumbUpdateForPath(path, "");
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
    s.gallery.splice(idx, 1);
    if (Array.isArray(s.galleryCaption)) s.galleryCaption.splice(idx, 1);
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
    el.select();
    el.setSelectionRange(0, 99999);
    try {
      await navigator.clipboard.writeText(el.value);
      toast("提示词已复制");
    } catch (err) {
      toast("请手动复制上方文本");
    }
    return;
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
  bind();
  renderAll();
  updateStorageLabel();
}
