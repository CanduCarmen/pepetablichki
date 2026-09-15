/* Карта миров — веб-версия. Логика координат 1:1 повторяет map_app.py */
(function () {
  "use strict";

  var MIN_ZOOM = 0.004, MAX_ZOOM = 60.0;
  var CHUNK = 256;
  var MAX_TILES_AT_ONCE = 48;

  // Прямые ссылки на гифки для кнопки темы.
  // Если clovi.ru отдаёт страницы-просмотрщики, а не сами файлы,
  // открой ссылку → правый клик по гифке → "Копировать адрес изображения"
  // и вставь сюда получившийся URL (обычно заканчивается на .gif / .webp).
  var THEME_GIFS = {
    dark:  "https://clovi.ru/f/wu3eaI4",   // тёмная тема
    light: "https://clovi.ru/f/MWrSy94"    // светлая тема
  };

  var els = {};
  var state = {
    index: null,          // atlas_index.json
    worlds: [],            // meta list
    world: null,            // current meta
    signs: [], portals: [],
    zoom: 1, off: [0, 0],
    showSigns: true, showPortals: true, showLabels: true, showBg: true, showGrid: true,
    alsoPortalsInSearch: false,
    hover: null, pinned: null, mouse: null, found: [],
    dotScale: 1,
    signColor: "#ffd23f", portalColor: "#9b5de5",
    theme: "dark",
    drag: null,
    tileCache: {}, tileMissing: {}, overviewImg: null,
    renderQueued: false,
    hits: [],
  };

  function $(id) { return document.getElementById(id); }

  function qsAll(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // ---------------------------------------------------------- хранилище настроек
  function loadPrefs() {
    try {
      var t = localStorage.getItem("atlas_theme");
      if (t) state.theme = t;
      var sc = localStorage.getItem("atlas_sign_color");
      if (sc) state.signColor = sc;
      var pc = localStorage.getItem("atlas_portal_color");
      if (pc) state.portalColor = pc;
      var ds = localStorage.getItem("atlas_dot_scale");
      if (ds) state.dotScale = parseFloat(ds) || 1;
    } catch (e) { /* localStorage недоступен — не страшно */ }
  }

  function savePref(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------- координаты
  function toImg(x, z) {
    var c = state.world.calib;
    return [(x - c.ox) / c.scale, (z - c.oz) / c.scale];
  }
  function toWorld(px, py) {
    var c = state.world.calib;
    return [px * c.scale + c.ox, py * c.scale + c.oz];
  }
  function toScreen(x, z) {
    var p = toImg(x, z);
    return [p[0] * state.zoom + state.off[0], p[1] * state.zoom + state.off[1]];
  }
  function screenToWorld(sx, sy) {
    return toWorld((sx - state.off[0]) / state.zoom, (sy - state.off[1]) / state.zoom);
  }

  function cw() { return els.canvas.clientWidth || 1; }
  function ch() { return els.canvas.clientHeight || 1; }

  function fit() {
    state.hover = null;
    var b = state.world.bounds, x0, y0, x1, y1;
    if (state.world.size && state.showBg) {
      x0 = 0; y0 = 0; x1 = state.world.size[0]; y1 = state.world.size[1];
    } else {
      var p0 = toImg(b.minx, b.minz), p1 = toImg(b.maxx, b.maxz);
      x0 = p0[0]; y0 = p0[1]; x1 = p1[0]; y1 = p1[1];
    }
    var w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
    state.zoom = Math.min(cw() / w, ch() / h) * 0.94;
    state.off[0] = cw() / 2 - (x0 + w / 2) * state.zoom;
    state.off[1] = ch() / 2 - (y0 + h / 2) * state.zoom;
    render();
  }

  function centerOn(x, z, minZoom) {
    state.hover = null;
    if (minZoom) state.zoom = Math.max(state.zoom, minZoom);
    var p = toImg(x, z);
    state.off[0] = cw() / 2 - p[0] * state.zoom;
    state.off[1] = ch() / 2 - p[1] * state.zoom;
    render();
  }

  function wheelAt(sx, sy, dir) {
    var k = dir > 0 ? 1.25 : 1 / 1.25;
    var nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom * k));
    k = nz / state.zoom;
    state.off[0] = sx - (sx - state.off[0]) * k;
    state.off[1] = sy - (sy - state.off[1]) * k;
    state.zoom = nz;
    render();
  }

  // ---------------------------------------------------------- загрузка мира
  function loadWorld(meta) {
    state.world = meta;
    state.signs = []; state.portals = [];
    state.found = []; state.hits = []; state.hover = null; state.pinned = null;
    state.tileCache = {}; state.tileMissing = {}; state.overviewImg = null;
    els.results.innerHTML = "";
    els.hitsInfo.textContent = "загружаю…";
    fetch(meta.file).then(function (r) { return r.json(); }).then(function (d) {
      state.signs = d.signs || [];
      state.portals = d.portals || [];
      if (meta.overview) {
        var img = new Image();
        img.onload = render;
        img.src = meta.overview;
        state.overviewImg = img;
      }
      loadChips();
      searchClear();
      fit();
    }).catch(function (err) {
      els.hitsInfo.textContent = "не смог загрузить данные мира: " + err;
    });
  }

  // ---------------------------------------------------------- тайлы карты
  function tileKey(tx, ty) { return tx + "_" + ty; }

  function getTile(tx, ty) {
    var key = tileKey(tx, ty);
    if (state.tileMissing[key]) return null;
    var cached = state.tileCache[key];
    if (cached) return cached.complete ? cached : null;
    var t = state.world.tiles;
    var img = new Image();
    img.onload = function () { render(); };
    img.onerror = function () { state.tileMissing[key] = true; };
    img.src = t.dir + "/" + tx + "_" + ty + ".png";
    state.tileCache[key] = img;
    return null;
  }

  function drawMap(ctx, W, H) {
    if (!state.showBg) return;
    var meta = state.world;
    var tiles = meta.tiles;
    if (!tiles) {
      if (meta.image) drawWholeImage(ctx);
      return;
    }
    var size = meta.size;
    var x0 = Math.max(0, (0 - state.off[0]) / state.zoom);
    var y0 = Math.max(0, (0 - state.off[1]) / state.zoom);
    var x1 = Math.min(size[0], (W - state.off[0]) / state.zoom);
    var y1 = Math.min(size[1], (H - state.off[1]) / state.zoom);
    if (x1 <= x0 || y1 <= y0) return;

    var tx0 = Math.max(0, Math.floor(x0 / tiles.tile));
    var ty0 = Math.max(0, Math.floor(y0 / tiles.tile));
    var tx1 = Math.min(tiles.cols - 1, Math.floor(x1 / tiles.tile));
    var ty1 = Math.min(tiles.rows - 1, Math.floor(y1 / tiles.tile));
    var count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);

    if (count > MAX_TILES_AT_ONCE) {
      // слишком далеко — картинка кусками будет тормозить, показываем обзорную
      drawOverview(ctx, size);
      return;
    }
    ctx.imageSmoothingEnabled = state.zoom < 1;
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) {
        var img = getTile(tx, ty);
        var px = tx * tiles.tile * state.zoom + state.off[0];
        var py = ty * tiles.tile * state.zoom + state.off[1];
        var pw = Math.min(tiles.tile, size[0] - tx * tiles.tile) * state.zoom;
        var ph = Math.min(tiles.tile, size[1] - ty * tiles.tile) * state.zoom;
        if (img) {
          ctx.drawImage(img, px, py, pw, ph);
        }
        // пустые (пропущенные при сборке) кусочки — просто фон, ничего не рисуем
      }
    }
  }

  function drawOverview(ctx, size) {
    var img = state.overviewImg;
    if (!img || !img.complete) return;
    var px = state.off[0], py = state.off[1];
    var pw = size[0] * state.zoom, ph = size[1] * state.zoom;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, px, py, pw, ph);
  }

  var wholeImgCache = {};
  function drawWholeImage(ctx) {
    var meta = state.world;
    var img = wholeImgCache[meta.image];
    if (!img) {
      img = new Image();
      img.onload = render;
      img.src = meta.image;
      wholeImgCache[meta.image] = img;
    }
    if (!img.complete) return;
    var px = state.off[0], py = state.off[1];
    var pw = meta.size[0] * state.zoom, ph = meta.size[1] * state.zoom;
    ctx.imageSmoothingEnabled = state.zoom < 1;
    ctx.drawImage(img, px, py, pw, ph);
  }

  // ---------------------------------------------------------- сетка
  // Рисуем только подсветку ячейки, над которой находится курсор.
  // Слабых линий по всей карте нет — это убирает визуальный шум.
  function drawGrid(ctx, W, H) {
    if (!state.showGrid) return;
    if (!state.mouse) return;

    var mx = state.mouse[0], my = state.mouse[1];
    if (mx < 0 || mx > W || my < 0 || my > H) return;

    var w = screenToWorld(mx, my);
    var wx = w[0], wz = w[1];

    var b = state.world.bounds;
    if (wx < b.minx || wx > b.maxx || wz < b.minz || wz > b.maxz) return;

    // Шаг выбираем по масштабу — чтобы ячейка была «человеческого» размера.
    var blocksPx = state.zoom / state.world.calib.scale;
    var step = blocksPx > 1.2 ? 16 : blocksPx > 0.35 ? 64 :
    blocksPx > 0.09 ? 256 : blocksPx > 0.03 ? 512 : 2048;

    var cellX = Math.floor(wx / step) * step;
    var cellZ = Math.floor(wz / step) * step;

    var p0 = toScreen(cellX, cellZ);
    var p1 = toScreen(cellX + step, cellZ + step);
    var x0 = p0[0], y0 = p0[1];
    var x1 = p1[0], y1 = p1[1];

    // мягкая заливка + тонкая рамка цвета Blurple
    ctx.fillStyle = cssVar("--grid-hover");
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    ctx.strokeStyle = cssVar("--found");
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
  }

  // ---------------------------------------------------------- точки
  // Без жёсткой обводки: мягкая тень + лёгкий светлый блик сверху-слева.
  function drawPoints(ctx, W, H) {
    var blocksPx = state.zoom / state.world.calib.scale;
    var r = Math.max(1, Math.min(6, 1 + blocksPx * 2)) * state.dotScale;
    var drawn = 0;

    var sets = [];
    if (state.showSigns) sets.push([state.signs, state.signColor, r]);
    if (state.showPortals) sets.push([state.portals, state.portalColor, r + 1]);

    for (var s = 0; s < sets.length; s++) {
      var arr = sets[s][0], color = sets[s][1], rad = sets[s][2];

      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        var sp = toScreen(p[0], p[2]);
        var sx = sp[0], sy = sp[1];
        if (sx < -rad * 2 || sx > W + rad * 2 || sy < -rad * 2 || sy > H + rad * 2) continue;

        // мягкая тень
        ctx.save();
        ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
        ctx.shadowBlur = Math.max(4, rad * 2);
        ctx.shadowOffsetY = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();

        // элегантный блик
        if (rad >= 2.5) {
          ctx.beginPath();
          ctx.arc(sx - rad * 0.3, sy - rad * 0.3, rad * 0.35, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
          ctx.fill();
        }
        drawn++;
      }
    }

    // найденные — тонкое кольцо акцентного цвета
    ctx.strokeStyle = cssVar("--found");
    ctx.lineWidth = 2;
    for (var f = 0; f < state.found.length; f++) {
      var pf = state.found[f];
      var spf = toScreen(pf[0], pf[2]);
      if (spf[0] < -6 || spf[0] > W + 6 || spf[1] < -6 || spf[1] > H + 6) continue;
      ctx.beginPath();
      ctx.arc(spf[0], spf[1], r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    return drawn;
  }

  function drawLabels(ctx, W, H) {
    var blocksPx = state.zoom / state.world.calib.scale;
    if (!state.showLabels || !state.showSigns || blocksPx < 0.25) return;
    var used = [], n = 0;
    ctx.font = "600 12px Manrope, Inter, sans-serif";
    for (var i = 0; i < state.signs.length && n < 130; i++) {
      var p = state.signs[i];
      var text = ((p[3] || p[4] || "") + "").split(" | ")[0].trim();
      if (!text) continue;
      var sp = toScreen(p[0], p[2]);
      var sx = sp[0], sy = sp[1];
      if (!(sx > 0 && sx < W && sy > 0 && sy < H)) continue;
      var overlap = false;
      for (var u = 0; u < used.length; u++) {
        if (Math.abs(used[u][0] - sx) < 130 && Math.abs(used[u][1] - sy) < 17) { overlap = true; break; }
      }
      if (overlap) continue;
      used.push([sx, sy]);
      var label = text.slice(0, 26);
      var tw = 6.4 * label.length;
      ctx.fillStyle = cssVar("--label-bg");
      ctx.fillRect(sx + 6, sy - 8, 12 + tw, 16);
      ctx.fillStyle = cssVar("--bright");
      ctx.fillText(label, sx + 9, sy + 4);
      n++;
    }
  }

  function ring(ctx, p, color) {
    var sp = toScreen(p[0], p[2]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sp[0], sp[1], 9, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ---------------------------------------------------------- статус
  function statusText(drawn) {
    var blocksPx = state.zoom / state.world.calib.scale;
    var scale = blocksPx >= 1 ? blocksPx.toFixed(1) + " пкс/блок" : (1 / blocksPx).toFixed(1) + " блок/пкс";
    return state.world.name + "   табличек " + state.signs.length + "   порталов " +
    state.portals.length + "   на экране " + drawn + "   " + scale;
  }

  // ---------------------------------------------------------- рендер
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function render() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(function () {
      state.renderQueued = false;
      doRender();
    });
  }

  function doRender() {
    if (!state.world) return;
    var canvas = els.canvas;
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cssVar("--bg");
    ctx.fillRect(0, 0, W, H);

    drawMap(ctx, W, H);
    drawGrid(ctx, W, H);          // только подсветка ячейки под курсором
    var drawn = drawPoints(ctx, W, H);
    drawLabels(ctx, W, H);
    if (state.pinned) ring(ctx, state.pinned, cssVar("--bright"));
    if (state.hover && state.hover !== state.pinned) ring(ctx, state.hover, cssVar("--found"));

    els.status.textContent = statusText(drawn);
    updateTooltip();
  }

  // ---------------------------------------------------------- подсказка
  function updateTooltip() {
    var p = state.hover;
    if (!p || !state.mouse) { els.tooltip.style.display = "none"; return; }
    var portal = p.length > 5 && p[5] === "p";
    var lines = ["x " + p[0] + "   y " + p[1] + "   z " + p[2]];
    if (portal) {
      lines.push("портал, блоков: " + (p[4] || 1));
    } else if (p[4]) {
      lines.push(String(p[4]));
    }
    if (p[3]) {
      String(p[3]).split(" | ").forEach(function (l) { lines.push(l); });
    } else if (!portal) {
      lines.push("без подписи");
    }
    lines = lines.slice(0, 8).map(function (l) { return l.slice(0, 46); });
    els.tooltip.innerHTML = lines.map(function (l, i) {
      return '<div class="' + (i === 0 ? "tt-head" : "tt-line") + '">' + escapeHtml(l) + "</div>";
    }).join("");
    els.tooltip.style.display = "block";
    var tx = state.mouse[0] + 16, ty = state.mouse[1] + 16;
    var maxW = els.canvas.clientWidth, maxH = els.canvas.clientHeight;
    var rect = els.tooltip.getBoundingClientRect();
    if (tx + rect.width > maxW) tx = state.mouse[0] - rect.width - 16;
    if (ty + rect.height > maxH) ty = state.mouse[1] - rect.height - 16;
    els.tooltip.style.left = tx + "px";
    els.tooltip.style.top = ty + "px";
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------------------------------------------------------- наведение / клики
  function pick(sx, sy) {
    var w = screenToWorld(sx, sy);
    var wx = w[0], wz = w[1];
    var rad = 14 / (state.zoom / state.world.calib.scale);
    var best = null, bestD = rad * rad;
    var pool = [];
    if (state.showSigns) pool = pool.concat(state.signs);
    if (state.showPortals) pool = pool.concat(state.portals);
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      var d = (p[0] - wx) * (p[0] - wx) + (p[2] - wz) * (p[2] - wz);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  // ---------------------------------------------------------- поиск
  function searchClear() {
    els.query.value = "";
    state.found = []; state.hits = [];
    els.results.innerHTML = "";
    els.hitsInfo.textContent = "несколько слов ищутся вместе; можно вписать координаты: 1200 -430";
    render();
  }

  function doSearch() {
    var text = els.query.value.trim().toLowerCase();
    els.results.innerHTML = "";
    state.hits = [];
    if (!text) { searchClear(); return; }

    var parts = text.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    if (parts.length === 2) {
      var x = parseInt(parts[0], 10), z = parseInt(parts[1], 10);
      if (!isNaN(x) && !isNaN(z) && /^-?\d+$/.test(parts[0]) && /^-?\d+$/.test(parts[1])) {
        centerOn(x, z, state.world.calib.scale * 1.5);
        els.hitsInfo.textContent = "перешёл к " + x + " " + z;
        return;
      }
    }

    var pool = state.signs.slice();
    if (state.alsoPortalsInSearch) pool = pool.concat(state.portals);

    function hay(p) {
      var portal = p.length > 5 && p[5] === "p";
      return ((p[3] || "") + " " + (portal ? "портал" : String(p[4] || ""))).toLowerCase();
    }

    var hits = pool.filter(function (p) {
      var h = hay(p);
      return parts.every(function (w) { return h.indexOf(w) !== -1; });
    });
    var loose = false;
    if (!hits.length && parts.length > 1) {
      loose = true;
      hits = pool.filter(function (p) {
        var h = hay(p);
        return parts.some(function (w) { return h.indexOf(w) !== -1; });
      });
    }

    state.found = hits.slice(0, 4000);
    state.hits = hits.slice(0, 400);
    if (!hits.length) {
      els.hitsInfo.textContent = "ничего не нашлось";
    } else {
      els.hitsInfo.textContent = (loose ? "вместе не нашлось, показываю по одному слову: " : "нашлось: ") +
      hits.length + (hits.length > 400 ? " (в списке первые 400)" : "");
    }
    state.hits.forEach(function (p, idx) {
      var portal = p.length > 5 && p[5] === "p";
      var title = String(p[3] || (portal ? "портал" : (p[4] || ""))).replace(/ \| /g, " / ");
      var li = document.createElement("div");
      li.className = "result-row";
      li.textContent = title.slice(0, 46) + "  ·  " + p[0] + " " + p[2];
      li.addEventListener("click", function () {
        state.pinned = p;
        centerOn(p[0], p[2], state.world.calib.scale * 1.5);
      });
      els.results.appendChild(li);
    });
    render();
  }

  var searchTimer = null;
  function searchLater() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 180);
  }

  function loadChips() {
    els.chips.innerHTML = "";
    (state.world.words || []).slice(0, 12).forEach(function (word) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = word;
      b.addEventListener("click", function () {
        els.query.value = word;
        doSearch();
      });
      els.chips.appendChild(b);
    });
  }

  // ---------------------------------------------------------- тема / цвета / точки
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);

    // Подпись рядом с иконкой: показываем ПРОТИВОПОЛОЖНУЮ тему —
    // ту, на которую переключимся при клике.
    var label = state.theme === "dark" ? "светлая" : "тёмная";

    // Гифка — текущей темы.
    var gifSrc = state.theme === "dark" ? THEME_GIFS.dark : THEME_GIFS.light;

    var gif = document.getElementById("themeGif");
    var lbl = document.getElementById("themeLabel");
    if (gif) gif.src = gifSrc;
    if (lbl) lbl.textContent = label;

    render();
  }

  function applyColors() {
    els.signColor.value = state.signColor;
    els.portalColor.value = state.portalColor;
    render();
  }

  // ---------------------------------------------------------- события
  function bindEvents() {
    var canvas = els.canvas;
    canvas.addEventListener("pointerdown", function (e) {
      canvas.setPointerCapture(e.pointerId);
      state.drag = { x: e.clientX, y: e.clientY, moved: false };
    });
    canvas.addEventListener("pointermove", function (e) {
      var rect = canvas.getBoundingClientRect();
      var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      state.mouse = [sx, sy];
      if (state.drag) {
        var dx = e.clientX - state.drag.x, dy = e.clientY - state.drag.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) state.drag.moved = true;
        state.off[0] += dx; state.off[1] += dy;
        state.drag.x = e.clientX; state.drag.y = e.clientY;
        state.hover = null;
        render();
      } else {
        var p = pick(sx, sy);
        if (p !== state.hover) { state.hover = p; }
        // перерисовываем всегда — чтобы подсветка ячейки следовала за курсором
        render();
      }
    });
    function endDrag(e) {
      if (state.drag && !state.drag.moved) {
        var rect = canvas.getBoundingClientRect();
        state.pinned = pick(e.clientX - rect.left, e.clientY - rect.top);
        render();
      }
      state.drag = null;
    }
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", function () { state.drag = null; });
    canvas.addEventListener("pointerleave", function () {
      state.mouse = null; state.hover = null; render();
    });
    canvas.addEventListener("dblclick", function (e) {
      var rect = canvas.getBoundingClientRect();
      var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      var p = pick(sx, sy);
      if (p) {
        state.pinned = p;
        centerOn(p[0], p[2], state.world.calib.scale * 2);
      } else {
        wheelAt(sx, sy, 1);
      }
    });
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      wheelAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    window.addEventListener("resize", render);
    window.addEventListener("keydown", function (e) {
      if (document.activeElement === els.query) return;
      if (e.key === "0") fit();
      else if (e.key === "+" || e.key === "=") wheelAt(cw() / 2, ch() / 2, 1);
      else if (e.key === "-") wheelAt(cw() / 2, ch() / 2, -1);
    });

      els.fitBtn.addEventListener("click", fit);
      els.query.addEventListener("input", searchLater);
      els.alsoPortals.addEventListener("change", function () {
        state.alsoPortalsInSearch = els.alsoPortals.checked;
        doSearch();
      });

      els.showSigns.addEventListener("change", function () { state.showSigns = els.showSigns.checked; render(); });
      els.showPortals.addEventListener("change", function () { state.showPortals = els.showPortals.checked; render(); });
      els.showLabels.addEventListener("change", function () { state.showLabels = els.showLabels.checked; render(); });
      els.showBg.addEventListener("change", function () { state.showBg = els.showBg.checked; render(); });
      els.showGrid.addEventListener("change", function () { state.showGrid = els.showGrid.checked; render(); });

      els.worldSelect.addEventListener("change", function () {
        var meta = state.worlds[els.worldSelect.selectedIndex];
        loadWorld(meta);
      });

      els.themeBtn.addEventListener("click", function () {
        state.theme = state.theme === "dark" ? "light" : "dark";
        savePref("atlas_theme", state.theme);
        applyTheme();
      });

      els.signColor.addEventListener("input", function () {
        state.signColor = els.signColor.value;
        savePref("atlas_sign_color", state.signColor);
        render();
      });
      els.portalColor.addEventListener("input", function () {
        state.portalColor = els.portalColor.value;
        savePref("atlas_portal_color", state.portalColor);
        render();
      });
      els.dotSize.addEventListener("input", function () {
        state.dotScale = parseFloat(els.dotSize.value);
        savePref("atlas_dot_scale", state.dotScale);
        render();
      });
      els.resetColors.addEventListener("click", function () {
        state.signColor = "#ffd23f";
        state.portalColor = "#9b5de5";
        state.dotScale = 1;
        savePref("atlas_sign_color", state.signColor);
        savePref("atlas_portal_color", state.portalColor);
        savePref("atlas_dot_scale", state.dotScale);
        els.dotSize.value = "1";
        applyColors();
      });
  }

  // ---------------------------------------------------------- старт
  function init() {
    els.canvas = $("map");
    els.status = $("status");
    els.tooltip = $("tooltip");
    els.worldSelect = $("worldSelect");
    els.showSigns = $("showSigns");
    els.showPortals = $("showPortals");
    els.showLabels = $("showLabels");
    els.showBg = $("showBg");
    els.showGrid = $("showGrid");
    els.fitBtn = $("fitBtn");
    els.query = $("query");
    els.alsoPortals = $("alsoPortals");
    els.chips = $("chips");
    els.hitsInfo = $("hitsInfo");
    els.results = $("results");
    els.themeBtn = $("themeBtn");
    els.signColor = $("signColor");
    els.portalColor = $("portalColor");
    els.dotSize = $("dotSize");
    els.resetColors = $("resetColors");

    loadPrefs();
    applyTheme();
    els.dotSize.value = String(state.dotScale);
    applyColors();
    bindEvents();

    fetch("atlas_index.json").then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (idx) {
      state.index = idx;
      state.worlds = idx.worlds || [];
      if (!state.worlds.length) {
        els.hitsInfo.textContent = "миров нет — файл atlas_index.json пуст";
        return;
      }
      els.worldSelect.innerHTML = "";
      state.worlds.forEach(function (w) {
        var opt = document.createElement("option");
        opt.textContent = w.name + "  (" + w.counts.signs + " табличек, " + w.counts.portals + " порталов)";
        els.worldSelect.appendChild(opt);
      });
      loadWorld(state.worlds[0]);
    }).catch(function (err) {
      els.hitsInfo.textContent = "не смог загрузить atlas_index.json: " + err +
      " — если открыл файл двойным кликом, страница должна отдаваться веб-сервером (GitHub Pages подходит), а не открываться как file://";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
