/*
 * builder-media.js —— 向导的「照片库」
 *
 * 职责：
 *   1. 把用户选的照片（手机相册 / 本地文件 / 拖拽）压缩成较小的 JPEG
 *   2. 存进浏览器本地存储（三级自动降级）：
 *        IndexedDB（推荐，容量大）→ localStorage（约 5MB）→ 仅本次会话内存
 *   3. 导出时再取出来内嵌进成品文件
 *
 * 有的浏览器 / 环境会拒绝 IndexedDB（如隐私模式、沙箱、某些浏览器设置），
 * 这时照片库会自动降级而不是报错，保证照片能用、能导出。
 */

(function (w) {
  "use strict";

  const DB_NAME = "trip-builder-store";
  const STORE = "photos";
  const LS_PREFIX = "trip-builder-photo:";

  let dbPromise = null;
  let modePromise = null;
  let mode = null;
  const memStore = {};

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!w.indexedDB) {
        reject(new Error("浏览器不支持 IndexedDB"));
        return;
      }
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        }
        // v2 新增：自选音乐的音频库（音频体积大，独立 store 便于单独清理）
        if (!req.result.objectStoreNames.contains("audios")) {
          req.result.createObjectStore("audios", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("打开本地素材库失败"));
    });
    return dbPromise;
  }

  function reqDone(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /*
   * 探测可用存储：IndexedDB → localStorage → 内存。
   * 结果缓存，只探测一次。
   */
  async function detectMode() {
    if (modePromise) return modePromise;
    modePromise = (async () => {
      try {
        // 注意：这里不能 db.close()——openDb 缓存的是同一个连接，
        // 探测后关闭会让后续 transaction 报 "database connection is closing"
        await openDb();
        mode = "idb";
        return mode;
      } catch (err) {
        // IndexedDB 不可用（最常见是 context 被拒 / 隐私限制）
      }
      try {
        const probe = LS_PREFIX + "probe";
        localStorage.setItem(probe, "1");
        localStorage.removeItem(probe);
        mode = "local";
        return mode;
      } catch (err) {
        // localStorage 也被拒
      }
      mode = "memory";
      return mode;
    })();
    return modePromise;
  }

  function newId() {
    return (
      "u_" +
      (w.crypto && w.crypto.randomUUID
        ? w.crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2))
    );
  }

  /* localStorage 照片占用（字节，按 UTF-16 计） */
  function lsPhotosBytes() {
    let total = 0;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.indexOf(LS_PREFIX) === 0) {
          const v = localStorage.getItem(k);
          total += (k.length + (v ? v.length : 0)) * 2;
        }
      }
    } catch (err) {
      /* ignore */
    }
    return total;
  }

  /* localStorage 模式留给照片的最大空间：给草稿及其它键留 400KB */
  const LS_PHOTO_LIMIT = 4.2 * 1024 * 1024;

  async function addPhoto(dataUrl) {
    const id = newId();
    const m = await detectMode();
    if (m === "idb") {
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ id, dataUrl });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } else if (m === "local") {
      // 先估算，空间不足直接说清楚，而不是让浏览器静默失败
      if (lsPhotosBytes() + dataUrl.length * 2 > LS_PHOTO_LIMIT) {
        throw new Error(
          "当前浏览器只提供约 5MB 本地空间，照片已快存满（建议不超过 10-15 张）。可删除几张旧照片，或改用 Chrome / Edge 打开本页获得更大存储",
        );
      }
      try {
        localStorage.setItem(LS_PREFIX + id, dataUrl);
      } catch (err) {
        throw new Error(
          "本地存储已满——当前浏览器空间约 5MB。请删除一些照片，或改用 Chrome / Edge 打开本页",
        );
      }
    } else {
      memStore[id] = dataUrl;
    }
    return id;
  }

  async function getPhoto(id) {
    const m = await detectMode();
    if (m === "idb") {
      const db = await openDb();
      const result = await reqDone(
        db.transaction(STORE, "readonly").objectStore(STORE).get(id),
      );
      return result ? result.dataUrl : null;
    }
    if (m === "local") return localStorage.getItem(LS_PREFIX + id);
    return memStore[id] || null;
  }

  async function removePhoto(id) {
    const m = await detectMode();
    if (m === "idb") {
      const db = await openDb();
      await reqDone(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
    } else if (m === "local") {
      localStorage.removeItem(LS_PREFIX + id);
    } else {
      delete memStore[id];
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("无法解码图片"));
      };
      img.src = url;
    });
  }

  /*
   * 压缩图片 → JPEG dataURL
   * 手机原图常 3-10MB，压缩到长边 1440px、质量 0.85 后通常 150-400KB，
   * 保证最终成品文件不会太大。
   */
  async function fileToDataUrl(file, maxDim, quality) {
    const dim = maxDim || 1440;
    const img = await loadImage(file);
    const scale = Math.min(1, dim / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    try {
      return canvas.toDataURL("image/jpeg", quality || 0.85);
    } catch (err) {
      throw new Error("浏览器不允许处理这张图片");
    }
  }

  // 把失败原因翻译成人话
  function friendlyError(file, err) {
    const msg = String((err && err.message) || err);
    if (/decode|无法解码/i.test(msg)) {
      return "「" + file.name + "」格式无法解码（可能是 HEIC 等），请转成 JPG/PNG 再试";
    }
    if (/空间不足|quota|Quota/i.test(msg)) {
      return msg;
    }
    if (/IndexedDB|denied|deny|SecurityError|存储|IDBFactory/i.test(msg)) {
      return "当前浏览器环境不允许大容量本地存储，已自动切换轻量模式，照片仍可使用；长期保存建议用 Chrome / Edge 的普通窗口打开";
    }
    return "「" + file.name + "」处理失败：" + msg;
  }

  async function filesToPhotos(fileList) {
    const files = Array.from(fileList || []);
    const added = [];
    const failed = [];
    // 存储受限（localStorage/内存）时压得更小，让有限的 5MB 能多装几张
    let dim = 1440;
    let quality = 0.85;
    try {
      const m = await detectMode();
      if (m !== "idb") {
        dim = 1080;
        quality = 0.72;
      }
    } catch (err) {
      /* ignore */
    }
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        failed.push({ name: file.name, reason: "不是图片文件（" + (file.type || "无类型") + "）" });
        continue;
      }
      try {
        const dataUrl = await fileToDataUrl(file, dim, quality);
        const id = await addPhoto(dataUrl);
        added.push(id);
      } catch (err) {
        console.warn("[builder-media]", file.name, err);
        failed.push({ name: file.name, reason: friendlyError(file, err) });
      }
    }
    return { added, failed };
  }

  /* 给界面用的存储模式说明 */
  const MODE_LABEL = {
    idb: "正常",
    local: "轻量（约 5MB 上限）",
    memory: "仅本次会话（浏览器禁止本地存储）",
  };
  function modeLabel(m) {
    return MODE_LABEL[m] || m;
  }

  /* ---------------- 音频（自选音乐） ----------------
   * 一首歌通常 3-5MB，localStorage 那约 5MB 的额度装不下，
   * 因此音频只保存在 IndexedDB（或内存：仅本次会话）；外链地址不占存储。 */

  const STORE_AUDIO = "audios";
  const AUDIO_MAX_BYTES = 15 * 1024 * 1024;
  const AUDIO_EXT_OK = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

  function fileToAudioDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取音频失败"));
      reader.readAsDataURL(file);
    });
  }

  /* 读时长（秒），失败返回 0 */
  function audioDuration(src) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      try {
        const a = new Audio();
        a.preload = "metadata";
        a.addEventListener("loadedmetadata", () =>
          done(Number.isFinite(a.duration) ? Math.round(a.duration) : 0),
        );
        a.addEventListener("error", () => done(0));
        a.src = src;
        setTimeout(() => done(0), 8000);
      } catch (err) {
        done(0);
      }
    });
  }

  async function addAudio(dataUrl, meta) {
    const id = newId();
    const m = await detectMode();
    const rec = {
      id,
      dataUrl,
      name: (meta && meta.name) || "未命名音乐",
      size: (meta && meta.size) || Math.round((dataUrl.length * 3) / 4),
      type: (meta && meta.type) || "",
      duration: (meta && meta.duration) || 0,
    };
    if (m === "idb") {
      const db = await openDb();
      const tx = db.transaction(STORE_AUDIO, "readwrite");
      tx.objectStore(STORE_AUDIO).put(rec);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      return id;
    }
    if (m === "memory") {
      memStore[id] = rec;
      return id;
    }
    throw new Error(
      "当前浏览器环境不允许大容量本地存储，音乐无法保存在本机。可改用「外链音频地址」（https://…），或换 Chrome / Edge 的普通窗口打开本页",
    );
  }

  async function getAudio(id) {
    const m = await detectMode();
    if (m === "idb") {
      const db = await openDb();
      const result = await reqDone(
        db.transaction(STORE_AUDIO, "readonly").objectStore(STORE_AUDIO).get(id),
      );
      return result || null;
    }
    return memStore[id] || null;
  }

  async function removeAudio(id) {
    const m = await detectMode();
    if (m === "idb") {
      const db = await openDb();
      await reqDone(
        db.transaction(STORE_AUDIO, "readwrite").objectStore(STORE_AUDIO).delete(id),
      );
      return;
    }
    delete memStore[id];
  }

  async function listAudios() {
    const m = await detectMode();
    if (m === "idb") {
      const db = await openDb();
      const rows = await reqDone(
        db.transaction(STORE_AUDIO, "readonly").objectStore(STORE_AUDIO).getAll(),
      );
      return (rows || []).map((r) => ({
        id: r.id,
        name: r.name || "未命名音乐",
        size: r.size || 0,
        duration: r.duration || 0,
      }));
    }
    return Object.keys(memStore)
      .map((k) => memStore[k])
      .filter((r) => r && typeof r === "object" && r.dataUrl)
      .map((r) => ({
        id: r.id,
        name: r.name || "未命名音乐",
        size: r.size || 0,
        duration: r.duration || 0,
      }));
  }

  async function filesToAudios(fileList) {
    const files = Array.from(fileList || []);
    const added = [];
    const failed = [];
    for (const file of files) {
      const looksAudio =
        (file.type && file.type.indexOf("audio/") === 0) || AUDIO_EXT_OK.test(file.name);
      if (!looksAudio) {
        failed.push({ name: file.name, reason: "不是音频文件（支持 mp3 / m4a / wav / ogg）" });
        continue;
      }
      if (file.size > AUDIO_MAX_BYTES) {
        failed.push({
          name: file.name,
          reason: "文件超过 15MB，会明显拖慢成品；建议压到 128kbps 或剪短到 1 分钟左右",
        });
        continue;
      }
      try {
        const dataUrl = await fileToAudioDataUrl(file);
        const duration = await audioDuration(dataUrl);
        const id = await addAudio(dataUrl, {
          name: file.name.replace(/\.[^.]+$/, ""),
          size: file.size,
          type: file.type,
          duration,
        });
        added.push(id);
      } catch (err) {
        failed.push({ name: file.name, reason: String((err && err.message) || err) });
      }
    }
    return { added, failed };
  }

  w.AudioLib = {
    addAudio,
    getAudio,
    removeAudio,
    listAudios,
    filesToAudios,
    fileToAudioDataUrl,
    audioDuration,
    MAX_BYTES: AUDIO_MAX_BYTES,
  };

  w.PhotoLib = {
    addPhoto,
    getPhoto,
    removePhoto,
    fileToDataUrl,
    filesToPhotos,
    detectMode,
    modeLabel,
  };
})(window);
