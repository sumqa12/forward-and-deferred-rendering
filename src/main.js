import { Scene } from './scene/scene.js';
import { OrbitCamera } from './scene/camera.js';
import { FrameData } from './scene/frame.js';
import { ForwardObjectPass } from './renderers/forward-object-pass.js';
import { ForwardRenderer } from './renderers/forward-renderer.js';
import { DeferredRenderer } from './renderers/deferred-renderer.js';
import { createMarkerProgram } from './renderers/light-markers.js';
import { PostProcess, VIEW_MODES } from './renderers/post-process.js';
import { GpuTimer } from './core/gpu-timer.js';
import { SCENARIOS } from './ui/scenarios.js';

const DEFAULTS = {
  mode: 'split',
  view: 'lit',
  lightCount: 128,
  lightRadius: 4,
  lightIntensity: 4,
  grid: 10,
  transparent: true,
  animate: true,
  markers: true,
  msaa: false,
  prepass: false,
  maxLightsPerPass: 8,
  deferredTransparency: 'hybrid',
  volumeDepthTest: true,
  fxaa: false,
  resolutionScale: 1,
  exposure: 1,
  heatMax: 32,
};

const GPU_PASSES = {
  forward: ['Zプリパス', '不透明+ライティング', '半透明', 'MSAA解決'],
  deferred: ['G-buffer', 'ライティング', '半透明(Forward)'],
};

const opts = { ...DEFAULTS };
let split = 0.5;

const $ = (sel) => document.querySelector(sel);
const canvas = $('#gl-canvas');

function fatal(message) {
  const el = $('#fatal');
  el.textContent = message;
  el.hidden = false;
  throw new Error(message);
}

const gl = canvas.getContext('webgl2', {
  antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance',
});
if (!gl) fatal('このブラウザは WebGL2 に対応していません。');
if (!gl.getExtension('EXT_color_buffer_float')) {
  fatal('EXT_color_buffer_float 拡張が必要です (HDR バッファと G-buffer に浮動小数点ターゲットを使うため)。');
}
const MAX_TARGET_SIZE = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));

let scene, camera, frameData, renderers, post, timer;
try {
  scene = new Scene(gl);
  camera = new OrbitCamera(canvas);
  frameData = new FrameData();
  const objectPass = new ForwardObjectPass(gl);
  const markerProgram = createMarkerProgram(gl);
  renderers = {
    forward: new ForwardRenderer(gl, objectPass, markerProgram),
    deferred: new DeferredRenderer(gl, objectPass, markerProgram),
  };
  post = new PostProcess(gl);
  timer = new GpuTimer(gl);
} catch (e) {
  console.error(e);
  fatal(`初期化に失敗しました: ${e.message}`);
}

// ------------------------------------------------------------------ 計測

function emptyStats() {
  return { drawCalls: 0, triangles: 0, lightPairs: 0, extraPasses: 0, targetBytes: 0, samples: 0 };
}

const perf = {
  forward: { cpu: 0, stats: emptyStats(), lastFrame: -Infinity },
  deferred: { cpu: 0, stats: emptyStats(), lastFrame: -Infinity },
};
let fps = 0;

// ------------------------------------------------------------------ 描画ループ

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function sourceFor(output) {
  const v = opts.view;
  if (v === 'lit' || v === 'heatmap' || !output.gbuffer) {
    // Forward には G-buffer が存在しないので通常表示にフォールバック
    return { texture: output.color, mode: v === 'heatmap' ? VIEW_MODES.heatmap : VIEW_MODES.lit };
  }
  const g = output.gbuffer;
  switch (v) {
    case 'albedo': return { texture: g.albedo, mode: VIEW_MODES.albedo };
    case 'normal': return { texture: g.normal, mode: VIEW_MODES.normal };
    case 'depth': return { texture: g.depth, mode: VIEW_MODES.depth };
    default: return { texture: g.albedo, aux: g.normal, mode: VIEW_MODES.specular };
  }
}

let lastTime = performance.now();
let simTime = 0;
let lastUi = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  if (dt > 0) fps = fps ? fps * 0.93 + (1 / dt) * 0.07 : 1 / dt;

  resizeCanvas();
  scene.configure(opts);
  if (opts.animate) simTime += dt;
  scene.update(simTime);
  scene.uploadLights();

  const rw = Math.min(MAX_TARGET_SIZE, Math.max(1, Math.round(canvas.width * opts.resolutionScale)));
  const rh = Math.min(MAX_TARGET_SIZE, Math.max(1, Math.round(canvas.height * opts.resolutionScale)));
  camera.update(canvas.width / canvas.height);
  frameData.build(scene, camera, rw, rh);
  timer.poll(now);

  const active = opts.mode === 'split' ? ['forward', 'deferred'] : [opts.mode];
  const outputs = {};
  for (const key of active) {
    const stats = emptyStats();
    const t0 = performance.now();
    outputs[key] = renderers[key].render(frameData, opts, timer, stats);
    const cpu = performance.now() - t0;
    const p = perf[key];
    p.cpu = now - p.lastFrame < 500 ? p.cpu * 0.9 + cpu * 0.1 : cpu;
    p.stats = stats;
    p.lastFrame = now;
  }

  const W = canvas.width, H = canvas.height;
  const sumStats = emptyStats();
  if (opts.mode === 'split') {
    const x = Math.round(W * split);
    post.present(sourceFor(outputs.forward), frameData, [W, H], [0, 0, x, H], opts, sumStats);
    post.present(sourceFor(outputs.deferred), frameData, [W, H], [x, 0, W - x, H], opts, sumStats);
    post.drawDivider(x, H, Math.max(2, Math.round(2 * (window.devicePixelRatio || 1))));
  } else {
    post.present(sourceFor(outputs[opts.mode]), frameData, [W, H], [0, 0, W, H], opts, sumStats);
  }
  gl.bindVertexArray(null);

  updateOverlay();
  if (now - lastUi > 250) {
    lastUi = now;
    updateStats(now, rw, rh);
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ 分割線のドラッグ

let draggingDivider = false;
function nearDivider(e) {
  if (opts.mode !== 'split') return false;
  const rect = canvas.getBoundingClientRect();
  return Math.abs(e.clientX - (rect.left + rect.width * split)) < 14;
}
camera.shouldIgnorePointer = (e) => {
  if (!nearDivider(e)) return false;
  draggingDivider = true;
  canvas.setPointerCapture(e.pointerId);
  return true;
};
canvas.addEventListener('pointermove', (e) => {
  canvas.style.cursor = draggingDivider || nearDivider(e) ? 'col-resize' : 'grab';
  if (!draggingDivider) return;
  const rect = canvas.getBoundingClientRect();
  split = Math.min(0.95, Math.max(0.05, (e.clientX - rect.left) / rect.width));
});
const endDrag = () => { draggingDivider = false; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ------------------------------------------------------------------ UI

function readValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'range' || el.dataset.number !== undefined) return Number(el.value);
  return el.value;
}

const FORMAT = {
  lightRadius: (v) => v.toFixed(1),
  lightIntensity: (v) => v.toFixed(1),
  grid: (v) => `${v}×${v} (${v * v} 個)`,
  resolutionScale: (v) => `×${v.toFixed(2)}`,
  exposure: (v) => v.toFixed(2),
};

function syncInputs() {
  document.querySelectorAll('[data-opt]').forEach((el) => {
    const v = opts[el.dataset.opt];
    if (el.type === 'checkbox') el.checked = v;
    else el.value = String(v);
  });
  document.querySelectorAll('[data-out]').forEach((el) => {
    const key = el.dataset.out;
    el.textContent = FORMAT[key] ? FORMAT[key](opts[key]) : String(opts[key]);
  });
  document.querySelectorAll('[data-set-mode]').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.setMode === opts.mode));
  });
  $('#heat-legend').hidden = opts.view !== 'heatmap';
  $('#heat-max').textContent = String(opts.heatMax);
  $('#heat-mid').textContent = String(Math.round(opts.heatMax / 2));
  updateHints();
}

document.querySelectorAll('[data-opt]').forEach((el) => {
  const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
  el.addEventListener(evt, () => {
    opts[el.dataset.opt] = readValue(el);
    syncInputs();
  });
});

document.querySelectorAll('[data-set-mode]').forEach((el) => {
  el.addEventListener('click', () => {
    opts.mode = el.dataset.setMode;
    syncInputs();
  });
});

const scenarioList = $('#scenarios');
for (const s of SCENARIOS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'scenario';
  btn.innerHTML = `<span class="scenario-title"></span><span class="scenario-tag"></span>`;
  btn.querySelector('.scenario-title').textContent = s.title;
  const tag = btn.querySelector('.scenario-tag');
  tag.textContent = s.tag;
  tag.dataset.side = s.tag.startsWith('Forward') ? 'forward' : 'deferred';
  btn.addEventListener('click', () => {
    Object.assign(opts, DEFAULTS, s.options);
    split = 0.5;
    scenarioList.querySelectorAll('.scenario').forEach((b) => b.removeAttribute('aria-current'));
    btn.setAttribute('aria-current', 'true');
    const note = $('#scenario-note');
    note.hidden = false;
    note.querySelector('strong').textContent = s.title;
    note.querySelector('p').textContent = s.note;
    syncInputs();
  });
  scenarioList.appendChild(btn);
}

$('#reset').addEventListener('click', () => {
  Object.assign(opts, DEFAULTS);
  split = 0.5;
  $('#scenario-note').hidden = true;
  scenarioList.querySelectorAll('.scenario').forEach((b) => b.removeAttribute('aria-current'));
  syncInputs();
});

$('#panel-toggle').addEventListener('click', () => {
  document.body.classList.toggle('panel-collapsed');
});

// ------------------------------------------------------------------ オーバーレイと統計

function updateOverlay() {
  const left = $('#label-left');
  const right = $('#label-right');
  const gbufferView = !['lit', 'heatmap'].includes(opts.view);
  const notes = {
    forward: [
      opts.msaa ? `MSAA ×${perf.forward.stats.samples}` : '',
      gbufferView ? 'G-buffer なし → 通常表示' : '',
    ],
    deferred: [
      opts.msaa ? 'MSAA 非対応' : '',
      opts.transparent && opts.deferredTransparency === 'gbuffer' ? '半透明 → 不透明化' : '',
      opts.transparent && opts.deferredTransparency === 'skip' ? '半透明を省略' : '',
    ],
  };
  const fill = (el, key) => {
    el.hidden = false;
    el.querySelector('b').textContent = key === 'forward' ? 'FORWARD' : 'DEFERRED';
    el.querySelector('small').textContent = notes[key].filter(Boolean).join(' / ');
  };
  if (opts.mode === 'split') {
    fill(left, 'forward');
    fill(right, 'deferred');
    right.style.left = `calc(${split * 100}% + 12px)`;
  } else {
    fill(left, opts.mode);
    right.hidden = true;
  }
}

const fmtMs = (v) => (v == null ? '—' : `${v.toFixed(2)} ms`);
const fmtInt = (v) => v.toLocaleString('ja-JP');
const fmtMB = (b) => `${(b / (1024 * 1024)).toFixed(1)} MB`;

function updateStats(now, rw, rh) {
  $('#fps').textContent = fps.toFixed(0);
  $('#render-size').textContent = `${rw}×${rh}`;
  $('#gpu-support').hidden = timer.available;
  for (const key of ['forward', 'deferred']) {
    const card = $(`#stats-${key}`);
    const p = perf[key];
    const active = now - p.lastFrame < 500;
    card.classList.toggle('inactive', !active);
    const s = p.stats;
    const gpuParts = GPU_PASSES[key].map((label) => [label, timer.get(`${key}:${label}`, now)]);
    const known = gpuParts.filter(([, v]) => v != null);
    const gpuTotal = known.length ? known.reduce((a, [, v]) => a + v, 0) : null;
    const rows = [
      ['CPU (コマンド発行)', active ? fmtMs(p.cpu) : '—'],
      ['GPU 合計', active && timer.available ? fmtMs(gpuTotal) : '—'],
      ...(active && timer.available ? known.map(([l, v]) => [`└ ${l}`, fmtMs(v), 'sub']) : []),
      ['ドローコール', active ? fmtInt(s.drawCalls) : '—'],
      key === 'forward'
        ? ['うち追加ライトパス', active ? fmtInt(s.extraPasses) : '—']
        : ['ライトボリューム', active ? `${fmtInt(scene.lightCount)} (1 ドロー)` : '—'],
      ['ライト×物体の判定ヒット', active ? fmtInt(s.lightPairs) : '—'],
      ['三角形', active ? fmtInt(s.triangles) : '—'],
      ['レンダーターゲット', active ? fmtMB(s.targetBytes) : '—'],
    ];
    card.querySelector('dl').innerHTML = rows
      .map(([k, v, cls]) => `<dt class="${cls ?? ''}">${k}</dt><dd class="${cls ?? ''}">${v}</dd>`)
      .join('');
  }
  updateHints();
}

function updateHints() {
  const hints = [];
  const showsForward = opts.mode !== 'deferred';
  const showsDeferred = opts.mode !== 'forward';
  const fs = perf.forward.stats;
  if (showsForward && fs.extraPasses > 0) {
    hints.push(`Forward: 1 ドローで扱えるライトは ${opts.maxLightsPerPass} 個まで。超えた分の追加パスが ${fmtInt(fs.extraPasses)} 回発生し、ドローコールが増えています。`);
  }
  if (showsForward && opts.prepass) {
    hints.push('Forward: Z プリパスで隠れるピクセルのライティングを省いています (代わりにジオメトリを 2 回描画)。');
  }
  if (showsDeferred && opts.msaa) {
    hints.push('Deferred: MSAA が効きません。WebGL2 ではマルチサンプルの G-buffer をサンプル単位で読み出せないため、FXAA などのポストプロセス AA を使います。');
  }
  if (showsDeferred && opts.transparent) {
    hints.push({
      hybrid: 'Deferred: 半透明は Forward パスで追加描画しています (ハイブリッド)。ライティングのコードパスが 2 系統必要です。',
      gbuffer: 'Deferred: 半透明を G-buffer に書いたため不透明になっています。G-buffer は 1 ピクセルに 1 面しか保持できません。',
      skip: 'Deferred: 半透明オブジェクトを描画していません。',
    }[opts.deferredTransparency]);
  }
  if (!['lit', 'heatmap'].includes(opts.view) && showsForward) {
    hints.push('Forward には G-buffer がないため、G-buffer 表示は Deferred 側だけに反映されます。');
  }
  if (opts.view === 'heatmap') {
    hints.push('ヒートマップ: 1 ピクセルあたりのライト計算回数 (オーバードロー込み)。明るいほど重い。');
  }
  const ul = $('#hints');
  ul.innerHTML = '';
  for (const h of hints) {
    const li = document.createElement('li');
    li.textContent = h;
    ul.appendChild(li);
  }
  $('#hints-section').hidden = hints.length === 0;
}

syncInputs();
requestAnimationFrame(frame);
