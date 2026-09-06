/*
 * builder-media.js —— 向导的「照片库」
 *
 * 职责：
 *   1. 把用户选的照片（手机相册 / 本地文件 / 拖拽）压缩成较小的 JPEG
 *   2. 存进浏览器本地数据库 IndexedDB（不联网、不上传）
 *   3. 导出时再取出来内嵌进成品文件
 */

(function (w) {
  "use strict";

  const DB_NAME = "trip-builder-store";
  const STORE = "photos";
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!w.indexedDB) {
        reject(new Error("当前浏览器不支持 IndexedDB，无法保存照片。"));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("打开照片库失败"));
    });
    return dbPromise;
  }

  function reqDone(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function addPhoto(dataUrl) {
    const id =
      "u_" +
      (w.crypto && w.crypto.randomUUID
        ? w.crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ id, dataUrl });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return id;
  }

  async function getPhoto(id) {
    const db = await openDb();
    const result = await reqDone(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
    return result ? result.dataUrl : null;
  }

  async function removePhoto(id) {
    const db = await openDb();
    await reqDone(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
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
        reject(new Error("无法读取这张图片"));
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
    return canvas.toDataURL("image/jpeg", quality || 0.85);
  }

  async function filesToPhotos(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    const ids = [];
    for (const file of files) {
      try {
        const dataUrl = await fileToDataUrl(file);
        const id = await addPhoto(dataUrl);
        ids.push(id);
      } catch (err) {
        console.warn("[builder-media]", err);
      }
    }
    return ids;
  }

  w.PhotoLib = {
    addPhoto,
    getPhoto,
    removePhoto,
    fileToDataUrl,
    filesToPhotos,
  };
})(window);
