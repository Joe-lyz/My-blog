(function (global) {
  'use strict';

  var VERSION = 1;
  var DB_NAME = 'my-blog-drawing-projects';
  var STORE_NAME = 'projects';
  var PROJECT_ID = 'current-doodle';
  var HISTORY_LIMIT = 75;

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function debounce(fn, wait) {
    var timer = 0;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  var ProjectStore = {
    open: function () {
      return new Promise(function (resolve, reject) {
        if (!global.indexedDB) return reject(new Error('IndexedDB is unavailable'));
        var request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || new Error('Unable to open IndexedDB')); };
      });
    },
    get: async function (id) {
      var db = await this.open();
      try {
        return await new Promise(function (resolve, reject) {
          var request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
          request.onsuccess = function () { resolve(request.result || null); };
          request.onerror = function () { reject(request.error); };
        });
      } finally { db.close(); }
    },
    put: async function (project) {
      var db = await this.open();
      try {
        await new Promise(function (resolve, reject) {
          var request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(project);
          request.onsuccess = function () { resolve(); };
          request.onerror = function () { reject(request.error); };
        });
      } finally { db.close(); }
    }
  };

  var state = {
    initialized: false,
    canvases: {}, contexts: {}, board: null, viewport: null,
    project: null, history: { past: [], present: null, future: [] },
    tool: 'pen', color: '#c0392b', width: 6, opacity: 1,
    fill: false, fillColor: '#f8c8c4', dashed: false,
    activeObject: null, selectedId: null, pointerId: null,
    view: { zoom: 1, x: 0, y: 0 }, backgroundImage: null
  };

  function emptyProject() {
    return {
      version: VERSION, id: PROJECT_ID,
      canvas: { width: 980, height: 580, zoom: 1 },
      background: { type: 'color', value: '#ffffff', imageUrl: null, fileName: null },
      objects: [], previewDataUrl: null, updatedAt: Date.now()
    };
  }

  function snapshot() {
    var data = clone(state.project);
    data.previewDataUrl = null;
    return data;
  }

  function commit() {
    var next = snapshot();
    if (state.history.present) state.history.past.push(state.history.present);
    if (state.history.past.length > HISTORY_LIMIT) state.history.past.shift();
    state.history.present = next;
    state.history.future = [];
    render();
    scheduleSave();
  }

  function restoreHistory(project) {
    state.project = clone(project);
    state.history.present = snapshot();
    state.selectedId = null;
    loadBackgroundImage().then(render).catch(function (error) { console.error('Failed to restore drawing background:', error); render(); });
    scheduleSave();
  }

  function undo() {
    if (!state.history.past.length) return;
    state.history.future.unshift(state.history.present);
    restoreHistory(state.history.past.pop());
  }

  function redo() {
    if (!state.history.future.length) return;
    state.history.past.push(state.history.present);
    restoreHistory(state.history.future.shift());
  }

  async function saveLocal() {
    if (!state.project) return;
    try {
      state.project.updatedAt = Date.now();
      state.project.previewDataUrl = exportDataURL('image/webp', .72);
      state.history.present = snapshot();
      await ProjectStore.put(clone(state.project));
      announce('已自动保存');
    } catch (error) {
      console.error('Failed to auto-save drawing project:', error);
      announce('自动保存失败');
    }
  }
  function saveWhenIdle() {
    announce('等待自动保存…');
    if (global.requestIdleCallback) global.requestIdleCallback(saveLocal, { timeout: 2000 });
    else setTimeout(saveLocal, 0);
  }
  // Exporting the preview is relatively expensive. Wait until drawing has paused,
  // then do it in an idle period so persistence never competes with the pen.
  var scheduleSave = debounce(saveWhenIdle, 1200);

  function announce(text) {
    var el = document.getElementById('doodle-save-status');
    if (el) el.textContent = text;
  }

  function setupCanvas(canvas, width, height) {
    var ratio = Math.max(1, global.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = true;
    return ctx;
  }

  function resizeLayers() {
    var size = state.project.canvas;
    state.board.style.width = size.width + 'px';
    state.board.style.height = size.height + 'px';
    Object.keys(state.canvases).forEach(function (key) {
      state.contexts[key] = setupCanvas(state.canvases[key], size.width, size.height);
    });
    applyView();
    render();
  }

  function applyView() {
    state.board.style.transform = 'translate(' + state.view.x + 'px,' + state.view.y + 'px) scale(' + state.view.zoom + ')';
  }

  function point(event) {
    var rect = state.canvases.overlay.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * state.project.canvas.width / rect.width,
      y: (event.clientY - rect.top) * state.project.canvas.height / rect.height,
      pressure: event.pressure || .5
    };
  }

  function configure(ctx, object) {
    ctx.globalCompositeOperation = object.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.globalAlpha = object.opacity == null ? 1 : object.opacity;
    ctx.strokeStyle = object.color || object.stroke || '#111';
    ctx.fillStyle = object.fill && object.fill !== 'transparent' ? object.fill : 'transparent';
    ctx.lineWidth = object.width || object.strokeWidth || 1;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.setLineDash(object.dashed ? [10, 7] : []);
  }

  function transformed(ctx, object, draw) {
    var bounds = objectBounds(object);
    var cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((object.rotation || 0) * Math.PI / 180);
    ctx.scale(object.scaleX || 1, object.scaleY || 1);
    ctx.translate(-cx, -cy);
    configure(ctx, object);
    draw();
    ctx.restore();
  }

  function drawObject(ctx, object) {
    transformed(ctx, object, function () {
      if (object.type === 'path') {
        if (!object.points || !object.points.length) return;
        ctx.beginPath(); ctx.moveTo(object.points[0].x, object.points[0].y);
        for (var i = 1; i < object.points.length; i++) ctx.lineTo(object.points[i].x, object.points[i].y);
        if (object.points.length === 1) ctx.lineTo(object.points[0].x + .1, object.points[0].y + .1);
        ctx.stroke();
      } else if (object.type === 'line' || object.type === 'arrow') {
        ctx.beginPath(); ctx.moveTo(object.x1, object.y1); ctx.lineTo(object.x2, object.y2); ctx.stroke();
        if (object.type === 'arrow') {
          var angle = Math.atan2(object.y2 - object.y1, object.x2 - object.x1), head = Math.max(10, object.width * 3);
          ctx.beginPath(); ctx.moveTo(object.x2, object.y2);
          ctx.lineTo(object.x2 - head * Math.cos(angle - Math.PI / 6), object.y2 - head * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(object.x2, object.y2);
          ctx.lineTo(object.x2 - head * Math.cos(angle + Math.PI / 6), object.y2 - head * Math.sin(angle + Math.PI / 6)); ctx.stroke();
        }
      } else if (object.type === 'rectangle') {
        if (object.fill !== 'transparent') ctx.fillRect(object.x, object.y, object.width, object.height);
        ctx.strokeRect(object.x, object.y, object.width, object.height);
      } else if (object.type === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(object.x + object.width / 2, object.y + object.height / 2, Math.abs(object.width / 2), Math.abs(object.height / 2), 0, 0, Math.PI * 2);
        if (object.fill !== 'transparent') ctx.fill(); ctx.stroke();
      } else if (object.type === 'text') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = (object.fontSize || 28) + 'px ' + (object.fontFamily || 'sans-serif');
        ctx.fillStyle = object.color; ctx.fillText(object.text, object.x, object.y);
      }
    });
  }

  function renderBackground(ctx) {
    ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = state.project.background.value || '#fff';
    ctx.fillRect(0, 0, state.project.canvas.width, state.project.canvas.height);
    if (state.backgroundImage) ctx.drawImage(state.backgroundImage, 0, 0, state.project.canvas.width, state.project.canvas.height);
    ctx.restore();
  }

  function render() {
    if (!state.initialized) return;
    var w = state.project.canvas.width, h = state.project.canvas.height;
    state.contexts.background.clearRect(0, 0, w, h); renderBackground(state.contexts.background);
    state.contexts.drawing.clearRect(0, 0, w, h);
    state.project.objects.forEach(function (object) { drawObject(state.contexts.drawing, object); });
    renderOverlay();
  }

  function renderOverlay(preview) {
    var ctx = state.contexts.overlay, w = state.project.canvas.width, h = state.project.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (preview) drawObject(ctx, preview);
    var selected = state.project.objects.find(function (item) { return item.id === state.selectedId; });
    if (selected) {
      var b = objectBounds(selected);
      ctx.save(); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.strokeRect(b.x - 6, b.y - 6, b.width + 12, b.height + 12); ctx.restore();
    }
  }

  function objectBounds(object) {
    if (object.type === 'path') {
      var xs = object.points.map(function (p) { return p.x; }), ys = object.points.map(function (p) { return p.y; });
      return { x: Math.min.apply(null, xs), y: Math.min.apply(null, ys), width: Math.max(1, Math.max.apply(null, xs) - Math.min.apply(null, xs)), height: Math.max(1, Math.max.apply(null, ys) - Math.min.apply(null, ys)) };
    }
    if (object.type === 'line' || object.type === 'arrow') return { x: Math.min(object.x1, object.x2), y: Math.min(object.y1, object.y2), width: Math.abs(object.x2 - object.x1), height: Math.abs(object.y2 - object.y1) };
    if (object.type === 'text') return { x: object.x, y: object.y - (object.fontSize || 28), width: Math.max(30, object.text.length * (object.fontSize || 28) * .6), height: object.fontSize || 28 };
    return { x: Math.min(object.x, object.x + object.width), y: Math.min(object.y, object.y + object.height), width: Math.abs(object.width), height: Math.abs(object.height) };
  }

  function hitTest(p) {
    for (var i = state.project.objects.length - 1; i >= 0; i--) {
      var object = state.project.objects[i];
      if (object.tool === 'eraser') continue;
      var b = objectBounds(object), pad = Math.max(10, object.width || object.strokeWidth || 1);
      if (p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad) return object;
    }
    return null;
  }

  function baseObject(type) {
    return { id: uid(type), type: type, tool: state.tool, color: state.color, width: state.width, opacity: state.tool === 'highlighter' ? Math.min(.35, state.opacity) : state.opacity, dashed: state.dashed, rotation: 0, scaleX: 1, scaleY: 1 };
  }

  var tools = {
    pen: pathTool('pen'), highlighter: pathTool('highlighter'), eraser: pathTool('eraser'),
    line: shapeTool('line'), arrow: shapeTool('arrow'), rectangle: shapeTool('rectangle'), ellipse: shapeTool('ellipse'),
    text: {
      pointerDown: function (event, p) {
        var value = global.prompt('请输入文字');
        if (!value) return;
        var object = baseObject('text'); object.x = p.x; object.y = p.y; object.text = value; object.fontSize = Math.max(14, state.width * 4); object.fontFamily = 'sans-serif';
        state.project.objects.push(object); commit();
      }, pointerMove: function () {}, pointerUp: function () {}
    },
    select: {
      pointerDown: function (event, p) {
        var object = hitTest(p); state.selectedId = object ? object.id : null;
        state.activeObject = object ? { object: object, start: p, original: clone(object) } : null; renderOverlay();
      },
      pointerMove: function (event, p) {
        if (!state.activeObject) return;
        var item = state.activeObject.object, original = state.activeObject.original;
        moveObject(item, p.x - state.activeObject.start.x, p.y - state.activeObject.start.y, original); render();
      },
      pointerUp: function () { if (state.activeObject) commit(); state.activeObject = null; }
    }
  };

  function pathTool(name) {
    return {
      pointerDown: function (event, p) {
        var object = baseObject('path'); object.tool = name; object.points = [p]; state.activeObject = object;
        renderOverlay();
      },
      pointerMove: function (event, p) {
        if (!state.activeObject) return;
        var points = state.activeObject.points;
        var previous = points[points.length - 1];
        points.push(p);
        // Paint only the new segment. Repainting the complete growing path on every
        // pointer event becomes progressively slower during a long stroke.
        var ctx = state.contexts.overlay;
        ctx.save(); configure(ctx, state.activeObject); ctx.beginPath();
        ctx.moveTo(previous.x, previous.y); ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.restore();
      },
      pointerUp: function (event, p) { if (!state.activeObject) return; state.activeObject.points.push(p); state.project.objects.push(state.activeObject); state.activeObject = null; commit(); }
    };
  }

  function shapeTool(type) {
    return {
      pointerDown: function (event, p) {
        var object = baseObject(type); object.start = p;
        if (type === 'line' || type === 'arrow') { object.x1 = p.x; object.y1 = p.y; object.x2 = p.x; object.y2 = p.y; }
        else { object.x = p.x; object.y = p.y; object.width = 0; object.height = 0; object.strokeWidth = state.width; object.fill = state.fill ? state.fillColor : 'transparent'; }
        state.activeObject = object;
      },
      pointerMove: function (event, p) { updateShape(state.activeObject, p); renderOverlay(state.activeObject); },
      pointerUp: function (event, p) { if (!state.activeObject) return; updateShape(state.activeObject, p); delete state.activeObject.start; state.project.objects.push(state.activeObject); state.activeObject = null; commit(); }
    };
  }

  function updateShape(object, p) {
    if (!object) return;
    if (object.type === 'line' || object.type === 'arrow') { object.x2 = p.x; object.y2 = p.y; }
    else { object.width = p.x - object.start.x; object.height = p.y - object.start.y; }
  }

  function moveObject(object, dx, dy, original) {
    if (object.type === 'path') object.points = original.points.map(function (p) { return { x: p.x + dx, y: p.y + dy, pressure: p.pressure }; });
    else if (object.type === 'line' || object.type === 'arrow') { object.x1 = original.x1 + dx; object.x2 = original.x2 + dx; object.y1 = original.y1 + dy; object.y2 = original.y2 + dy; }
    else { object.x = original.x + dx; object.y = original.y + dy; }
  }

  function pointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault(); state.pointerId = event.pointerId;
    state.canvases.overlay.setPointerCapture(event.pointerId);
    tools[state.tool].pointerDown(event, point(event));
  }
  function pointerMove(event) {
    if (event.pointerId !== state.pointerId) return;
    event.preventDefault();
    var samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    if (!samples.length) samples = [event];
    samples.forEach(function (sample) { tools[state.tool].pointerMove(sample, point(sample)); });
  }
  function pointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    event.preventDefault(); tools[state.tool].pointerUp(event, point(event));
    if (state.canvases.overlay.hasPointerCapture(event.pointerId)) state.canvases.overlay.releasePointerCapture(event.pointerId);
    state.pointerId = null;
  }

  function keyDown(event) {
    if (!state.initialized || !document.getElementById('doodle-view').classList.contains('active')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId && !/INPUT|TEXTAREA/.test(event.target.tagName)) {
      event.preventDefault(); state.project.objects = state.project.objects.filter(function (item) { return item.id !== state.selectedId; }); state.selectedId = null; commit();
    }
  }

  function wheel(event) {
    if (!event.ctrlKey) return;
    event.preventDefault(); state.view.zoom = Math.max(.25, Math.min(3, state.view.zoom * (event.deltaY > 0 ? .9 : 1.1)));
    state.project.canvas.zoom = state.view.zoom; applyView(); scheduleSave();
  }

  function imageFromUrl(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      if (/^https?:/i.test(url)) image.crossOrigin = 'anonymous';
      image.onload = function () { resolve(image); }; image.onerror = function () { reject(new Error('Unable to load image')); }; image.src = url;
    });
  }

  async function loadBackgroundImage() {
    state.backgroundImage = null;
    if (state.project.background.imageUrl) state.backgroundImage = await imageFromUrl(state.project.background.imageUrl);
  }

  async function importBackground(file) {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      var url = await new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = function () { reject(reader.error); }; reader.readAsDataURL(file); });
      var image = await imageFromUrl(url);
      state.backgroundImage = image;
      state.project.background = { type: 'image', value: '#ffffff', imageUrl: url, fileName: file.name };
      commit();
    } catch (error) { console.error('Failed to import drawing background:', error); alert('底图导入失败，请换一张图片重试。'); }
  }

  function compositeCanvas() {
    var canvas = document.createElement('canvas'), ratio = Math.max(1, global.devicePixelRatio || 1), w = state.project.canvas.width, h = state.project.canvas.height;
    canvas.width = w * ratio; canvas.height = h * ratio;
    var ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(state.canvases.background, 0, 0, w, h); ctx.drawImage(state.canvases.drawing, 0, 0, w, h); return canvas;
  }
  function exportDataURL(mime, quality) { return compositeCanvas().toDataURL(mime || 'image/png', quality); }
  function download(format) {
    try { var a = document.createElement('a'); a.href = exportDataURL(format === 'webp' ? 'image/webp' : 'image/png', .92); a.download = 'doodle-' + Date.now() + '.' + format; a.click(); }
    catch (error) { console.error('Failed to export drawing:', error); alert('导出失败；请确认底图允许跨域访问。'); }
  }

  async function loadFlattenedImage(url) {
    try {
      var image = await imageFromUrl(url);
      state.backgroundImage = image;
      state.project = emptyProject(); state.project.background = { type: 'image', value: '#fff', imageUrl: url, fileName: 'saved-doodle' };
      state.history = { past: [], present: snapshot(), future: [] }; render(); scheduleSave();
    } catch (error) { console.error('Failed to load saved drawing:', error); alert('涂鸦加载失败。'); }
  }

  async function init() {
    if (state.initialized) return;
    state.board = document.getElementById('drawing-board'); state.viewport = document.getElementById('doodle-viewport');
    if (!state.board) return;
    state.canvases = { background: document.getElementById('backgroundCanvas'), drawing: document.getElementById('drawingCanvas'), overlay: document.getElementById('overlayCanvas') };
    state.project = emptyProject(); state.initialized = true;
    resizeLayers();
    state.canvases.overlay.addEventListener('pointerdown', pointerDown);
    state.canvases.overlay.addEventListener('pointermove', pointerMove);
    state.canvases.overlay.addEventListener('pointerup', pointerUp);
    state.canvases.overlay.addEventListener('pointercancel', pointerUp);
    state.viewport.addEventListener('wheel', wheel, { passive: false });
    global.addEventListener('keydown', keyDown);
    global.addEventListener('resize', applyView);
    var upload = document.getElementById('doodle-upload-input');
    if (upload) upload.addEventListener('change', function () { if (upload.files[0]) importBackground(upload.files[0]); upload.value = ''; });
    try {
      var saved = await ProjectStore.get(PROJECT_ID);
      if (saved && saved.version === VERSION && saved.canvas && Array.isArray(saved.objects)) { state.project = saved; state.view.zoom = saved.canvas.zoom || 1; await loadBackgroundImage(); resizeLayers(); announce('已恢复上次编辑'); }
    } catch (error) { console.error('Failed to restore drawing project:', error); announce('本地恢复不可用'); }
    state.history.present = snapshot(); initPalette(); render();
  }

  function initPalette() {
    var colors = ['#1a1008','#c0392b','#2563eb','#16a34a','#f59e0b','#7c3aed','#ec4899','#ffffff'];
    var wrap = document.getElementById('doodle-palette'); if (!wrap) return;
    wrap.innerHTML = colors.map(function (color) { return '<button class="doodle-color-chip" type="button" data-color="' + color + '" aria-label="选择 ' + color + '" style="background:' + color + '"></button>'; }).join('');
    wrap.addEventListener('click', function (event) { var button = event.target.closest('[data-color]'); if (button) { setColor(button.dataset.color); document.getElementById('doodle-color').value = button.dataset.color; } });
  }

  function setTool(tool) { if (!tools[tool]) return; state.tool = tool; state.board.dataset.tool = tool; state.selectedId = null; renderOverlay(); }
  function setColor(color) { state.color = color || '#c0392b'; if (state.tool === 'eraser') setTool('pen'); }
  function clear() { if (!state.project.objects.length && !state.project.background.imageUrl) return; state.project.objects = []; state.project.background = { type:'color', value:'#fff', imageUrl:null, fileName:null }; state.backgroundImage = null; commit(); }
  function transformSelected(action) {
    var object = state.project.objects.find(function (item) { return item.id === state.selectedId; }); if (!object) return;
    if (action === 'rotate-left') object.rotation = (object.rotation || 0) - 15;
    if (action === 'rotate-right') object.rotation = (object.rotation || 0) + 15;
    if (action === 'grow') object.scaleX = object.scaleY = Math.min(5, (object.scaleX || 1) * 1.1);
    if (action === 'shrink') object.scaleX = object.scaleY = Math.max(.1, (object.scaleX || 1) * .9);
    commit();
  }

  // Cloud sync extension point: a Worker can persist this JSON to
  // projects/{userId}/{projectId}.json, its preview to previews/...png,
  // and background files to backgrounds/{userId}/{projectId}/{fileName}.
  global.DoodleBoard = {
    init:init, tools:tools, undo:undo, redo:redo, clear:clear, download:download,
    exportDataURL:exportDataURL, loadFlattenedImage:loadFlattenedImage, importBackground:importBackground,
    setTool:setTool, setColor:setColor,
    setWidth:function (value) { state.width = Math.max(1, Number(value) || 1); },
    setOpacity:function (value) { state.opacity = Math.max(.1, Math.min(1, Number(value) || 1)); },
    setFill:function (value) { state.fill = Boolean(value); }, setFillColor:function (value) { state.fillColor = value; },
    setDashed:function (value) { state.dashed = Boolean(value); }, transformSelected:transformSelected,
    getProject:function () { return clone(state.project); }
  };
})(window);
