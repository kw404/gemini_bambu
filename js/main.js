import * as THREE from 'three';
import { initScene, snapMeshToBed, createDemoGeometry } from './scene.js';
import { sliceMesh } from './slicer.js';
import { parseImportedFile, exportTo3MF } from './io.js';

const state = {
  mode: 'prepare',
  activeTool: null,
  modelMesh: null,
  modelName: 'Bambu_A2L_Teaching_Demo',
  isSliced: false,
  sliceData: null,
  slicePreviewGroup: null,
  layerPlayTimer: null
};

const container = document.getElementById('canvas-holder');
const { scene, camera, orbit, transformControl } = initScene(
  container,
  () => {
    if (state.modelMesh) {
      snapMeshToBed(state.modelMesh);
      invalidateSlice();
      updateTransformUI();
    }
  },
  () => {
    if (state.modelMesh) updateTransformUI();
  }
);

// 載入模型至熱床
function setLoadedGeometry(geometry, name = 'Imported_Model') {
  if (state.modelMesh) {
    transformControl.detach();
    scene.remove(state.modelMesh);
    state.modelMesh.geometry.dispose();
    state.modelMesh.material.dispose();
  }

  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);
  geometry.translate(-center.x, -center.y, -box.min.z);

  const filamentColor = document.getElementById('filament-color').value;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(filamentColor),
    roughness: 0.35,
    metalness: 0.1,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, 0, 0);
  scene.add(mesh);

  state.modelMesh = mesh;
  state.modelName = name.replace(/\.(stl|3mf)$/i, '');

  switchMode('prepare');
  enableModelTools(true);
  snapMeshToBed(state.modelMesh);
  updateTransformUI();
  invalidateSlice();

  document.getElementById('empty-prompt').classList.add('hidden');
  document.getElementById('transform-panel').classList.remove('hidden');
  showToast(`已載入模型：${state.modelName}`);
}

// 讀取左側面板所有參數
function readSlicerSettings() {
  return {
    printer: 'Bambu Lab A2L',
    bedType: 'Textured PEI Plate',
    filament: 'Generic PLA',
    preset: document.getElementById('preset-select').value,
    layerHeight: parseFloat(document.getElementById('param-layer-height').value) || 0.2,
    initialLayerHeight: parseFloat(document.getElementById('param-initial-layer-height').value) || 0.2,
    lineWidth: parseFloat(document.getElementById('param-line-width').value) || 0.42,
    initialLineWidth: parseFloat(document.getElementById('param-initial-line-width').value) || 0.5,
    seamPosition: document.getElementById('param-seam-position').value,
    ironing: document.getElementById('param-ironing').value,
    wallLoops: parseInt(document.getElementById('param-wall-loops').value, 10) || 2,
    topLayers: parseInt(document.getElementById('param-top-layers').value, 10) || 3,
    bottomLayers: parseInt(document.getElementById('param-bottom-layers').value, 10) || 3,
    infillDensity: parseFloat(document.getElementById('param-infill-density').value) || 15,
    infillPattern: document.getElementById('param-infill-pattern').value,
    speedInitial: parseFloat(document.getElementById('param-speed-initial').value) || 50,
    speedOuter: parseFloat(document.getElementById('param-speed-outer').value) || 200,
    speedInner: parseFloat(document.getElementById('param-speed-inner').value) || 300,
    speedInfill: parseFloat(document.getElementById('param-speed-infill').value) || 270,
    speedTravel: parseFloat(document.getElementById('param-speed-travel').value) || 500,
    supportEnable: document.getElementById('param-support-enable').checked,
    supportType: document.getElementById('param-support-type').value,
    supportStyle: document.getElementById('param-support-style').value,
    supportAngle: parseFloat(document.getElementById('param-support-angle').value) || 30,
    supportBuildPlateOnly: document.getElementById('param-support-buildplate-only').checked,
    brimType: document.getElementById('param-brim-type').value,
    brimWidth: parseFloat(document.getElementById('param-brim-width').value) || 5,
    printSequence: document.getElementById('param-print-sequence').value,
    spiralVase: document.getElementById('param-spiral-vase').checked
  };
}

// 執行切片並切換至預覽
function runSlicer() {
  if (!state.modelMesh) {
    alert('請先匯入模型或載入範例模型！');
    return;
  }

  snapMeshToBed(state.modelMesh);
  const cfg = readSlicerSettings();

  if (state.slicePreviewGroup) {
    scene.remove(state.slicePreviewGroup);
    state.slicePreviewGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
  }

  const result = sliceMesh(state.modelMesh, cfg);
  scene.add(result.previewGroup);

  state.slicePreviewGroup = result.previewGroup;
  state.sliceData = result;
  state.isSliced = true;

  updatePreviewStatsUI();
  switchMode('preview');

  // 若有頂部實心殼層，自動將預覽拉桿退開頂部殼層 4 層，讓學生直接看到內部的蜂巢/陀螺儀填充！
  const inspectLayer = Math.max(1, result.totalLayers - cfg.topLayers - 2);
  document.getElementById('layer-slider').value = inspectLayer;
  filterVisibleLayers(inspectLayer);

  showToast(`切片完成（${result.patternLabel}）！已自動剖開頂蓋方便觀察內部填充`);
}

function updatePreviewStatsUI() {
  const d = state.sliceData;
  if (!d) return;

  const slider = document.getElementById('layer-slider');
  slider.max = d.totalLayers;
  slider.value = d.totalLayers;

  document.getElementById('layer-max-label').textContent = d.totalLayers;
  document.getElementById('stat-pattern-badge').textContent = d.patternLabel;
  document.getElementById('stat-total-layers').textContent = `${d.totalLayers} 層`;
  document.getElementById('stat-weight').textContent =
    `${d.weightGrams.toFixed(1)} g (${d.filamentLengthM.toFixed(2)} m)`;

  const hrs = Math.floor(d.timeSeconds / 3600);
  const mins = Math.ceil((d.timeSeconds % 3600) / 60);
  document.getElementById('stat-time').textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins} 分鐘`;

  document.getElementById('stat-support-pct').textContent = d.settings.supportEnable ? '12%' : '0%';
  document.getElementById('stat-brim-pct').textContent = d.settings.brimType !== 'no_brim' ? '4%' : '0%';
}

function filterVisibleLayers(maxLayerIndex) {
  if (!state.sliceData) return;
  const groups = state.sliceData.layerGroups;
  for (let i = 0; i < groups.length; i++) {
    groups[i].visible = i < maxLayerIndex;
  }
  const z = state.sliceData.layerZs[maxLayerIndex - 1] || 0;
  document.getElementById('layer-current-label').textContent = maxLayerIndex;
  document.getElementById('layer-z-label').textContent = `${z.toFixed(2)} mm`;
}

function invalidateSlice() {
  state.isSliced = false;
}

function switchMode(targetMode) {
  if (targetMode === 'preview' && !state.isSliced) {
    runSlicer();
    return;
  }

  state.mode = targetMode;
  const isPrepare = targetMode === 'prepare';

  document.getElementById('btn-mode-prepare').classList.toggle('active', isPrepare);
  document.getElementById('btn-mode-preview').classList.toggle('active', !isPrepare);

  document.getElementById('prepare-toolbar').classList.toggle('opacity-40', !isPrepare);
  document.getElementById('prepare-toolbar').classList.toggle('pointer-events-none', !isPrepare);

  document.getElementById('preview-layer-control').classList.toggle('hidden', isPrepare);
  document.getElementById('preview-stats-panel').classList.toggle('hidden', isPrepare);

  if (state.modelMesh) {
    state.modelMesh.visible = isPrepare;
    document.getElementById('transform-panel').classList.toggle('hidden', !isPrepare);
    if (!isPrepare) transformControl.detach();
  }

  if (state.slicePreviewGroup) {
    state.slicePreviewGroup.visible = !isPrepare;
  }
}

function enableModelTools(enabled) {
  ['tool-move', 'tool-rotate', 'tool-scale', 'tool-lay-flat', 'tool-center', 'tool-delete'].forEach(
    (id) => {
      document.getElementById(id).disabled = !enabled;
    }
  );
}

function setActiveTool(mode) {
  if (!state.modelMesh) return;
  ['tool-move', 'tool-rotate', 'tool-scale'].forEach((id) =>
    document.getElementById(id).classList.remove('active')
  );

  if (state.activeTool === mode) {
    state.activeTool = null;
    transformControl.detach();
    return;
  }

  state.activeTool = mode;
  transformControl.setMode(mode);
  transformControl.attach(state.modelMesh);

  if (mode === 'translate') document.getElementById('tool-move').classList.add('active');
  if (mode === 'rotate') document.getElementById('tool-rotate').classList.add('active');
  if (mode === 'scale') document.getElementById('tool-scale').classList.add('active');
}

function updateTransformUI() {
  if (!state.modelMesh) return;
  const m = state.modelMesh;
  document.getElementById('selected-model-name').textContent = state.modelName;
  document.getElementById('tf-pos-x').value = m.position.x.toFixed(1);
  document.getElementById('tf-pos-y').value = m.position.y.toFixed(1);
  document.getElementById('tf-pos-z').value = m.position.z.toFixed(1);

  document.getElementById('tf-rot-x').value = Math.round(THREE.MathUtils.radToDeg(m.rotation.x));
  document.getElementById('tf-rot-y').value = Math.round(THREE.MathUtils.radToDeg(m.rotation.y));
  document.getElementById('tf-rot-z').value = Math.round(THREE.MathUtils.radToDeg(m.rotation.z));
  document.getElementById('tf-scale').value = Math.round(m.scale.x * 100);

  const box = new THREE.Box3().setFromObject(m);
  const size = new THREE.Vector3();
  box.getSize(size);
  document.getElementById('model-dimensions').textContent =
    `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`;
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

// ================= 事件綁定 =================
document.getElementById('file-input').addEventListener('change', async (e) => {
  if (e.target.files.length > 0) {
    try {
      const { geometry, name } = await parseImportedFile(e.target.files[0]);
      setLoadedGeometry(geometry, name);
    } catch (err) {
      alert(err.message);
    }
  }
  e.target.value = '';
});

document.getElementById('btn-demo-model').addEventListener('click', () => {
  setLoadedGeometry(createDemoGeometry(), 'Bambu_A2L_Teaching_Demo');
});

document.getElementById('btn-mode-prepare').addEventListener('click', () => switchMode('prepare'));
document.getElementById('btn-mode-preview').addEventListener('click', () => switchMode('preview'));

document.getElementById('tool-move').addEventListener('click', () => setActiveTool('translate'));
document.getElementById('tool-rotate').addEventListener('click', () => setActiveTool('rotate'));
document.getElementById('tool-scale').addEventListener('click', () => setActiveTool('scale'));

document.getElementById('tool-lay-flat').addEventListener('click', () => {
  if (!state.modelMesh) return;
  state.modelMesh.rotation.x = Math.round(state.modelMesh.rotation.x / (Math.PI / 2)) * (Math.PI / 2);
  state.modelMesh.rotation.y = Math.round(state.modelMesh.rotation.y / (Math.PI / 2)) * (Math.PI / 2);
  snapMeshToBed(state.modelMesh);
  updateTransformUI();
  invalidateSlice();
  showToast('已自動貼平模型底面');
});

document.getElementById('tool-center').addEventListener('click', () => {
  if (!state.modelMesh) return;
  state.modelMesh.position.set(0, 0, 0);
  snapMeshToBed(state.modelMesh);
  updateTransformUI();
  invalidateSlice();
  showToast('已自動置中於 A2L 熱床中央');
});

document.getElementById('tool-delete').addEventListener('click', () => {
  if (!state.modelMesh) return;
  transformControl.detach();
  scene.remove(state.modelMesh);
  state.modelMesh = null;
  enableModelTools(false);
  invalidateSlice();
  document.getElementById('transform-panel').classList.add('hidden');
  document.getElementById('empty-prompt').classList.remove('hidden');
  showToast('已刪除模型');
});

document.getElementById('btn-slice').addEventListener('click', runSlicer);

document.getElementById('btn-export-3mf').addEventListener('click', async () => {
  if (!state.modelMesh) {
    alert('熱床上沒有模型，無法匯出 .3mf 檔案！');
    return;
  }
  await exportTo3MF(state.modelMesh, state.modelName, readSlicerSettings());
  showToast(`已成功匯出 ${state.modelName}_BBL_A2L.3mf！`);
});

// 當學生在預覽模式下修改填充圖案或參數時，自動標記需要重新切片（若已在預覽模式則直接更新切片）
document.querySelectorAll('.param-panel input, .param-panel select').forEach((el) => {
  el.addEventListener('change', () => {
    invalidateSlice();
    if (state.mode === 'preview' && state.modelMesh) {
      runSlicer();
    }
  });
});

// 座標面板輸入連動
['tf-pos-x', 'tf-pos-y', 'tf-rot-x', 'tf-rot-y', 'tf-rot-z', 'tf-scale'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    if (!state.modelMesh) return;
    const m = state.modelMesh;
    m.position.x = parseFloat(document.getElementById('tf-pos-x').value) || 0;
    m.position.y = parseFloat(document.getElementById('tf-pos-y').value) || 0;
    m.rotation.x = THREE.MathUtils.degToRad(parseFloat(document.getElementById('tf-rot-x').value) || 0);
    m.rotation.y = THREE.MathUtils.degToRad(parseFloat(document.getElementById('tf-rot-y').value) || 0);
    m.rotation.z = THREE.MathUtils.degToRad(parseFloat(document.getElementById('tf-rot-z').value) || 0);
    const s = Math.max(0.1, (parseFloat(document.getElementById('tf-scale').value) || 100) / 100);
    m.scale.set(s, s, s);
    snapMeshToBed(m);
    updateTransformUI();
    invalidateSlice();
  });
});

// 線材顏色選擇器
document.getElementById('filament-color').addEventListener('input', (e) => {
  document.getElementById('filament-dot').style.backgroundColor = e.target.value;
  if (state.modelMesh) state.modelMesh.material.color.set(e.target.value);
});

// 工藝預設切換
document.getElementById('preset-select').addEventListener('change', (e) => {
  document.getElementById('param-layer-height').value = e.target.value;
  invalidateSlice();
});

// 左側五大分頁切換
document.querySelectorAll('.param-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.param-tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.param-panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// 右側層數拉桿與自動播放
document.getElementById('layer-slider').addEventListener('input', (e) => {
  filterVisibleLayers(parseInt(e.target.value, 10));
});

document.getElementById('btn-play-layers').addEventListener('click', () => {
  if (!state.sliceData) return;
  const icon = document.getElementById('play-icon');
  const slider = document.getElementById('layer-slider');

  if (state.layerPlayTimer) {
    clearInterval(state.layerPlayTimer);
    state.layerPlayTimer = null;
    icon.className = 'fa-solid fa-play';
    return;
  }

  icon.className = 'fa-solid fa-pause';
  let cur = parseInt(slider.value, 10);
  if (cur >= state.sliceData.totalLayers) cur = 1;

  state.layerPlayTimer = setInterval(() => {
    cur++;
    if (cur > state.sliceData.totalLayers) {
      clearInterval(state.layerPlayTimer);
      state.layerPlayTimer = null;
      icon.className = 'fa-solid fa-play';
      return;
    }
    slider.value = cur;
    filterVisibleLayers(cur);
  }, 45);
});

// 視角快速按鈕
document.getElementById('cam-iso').addEventListener('click', () => {
  camera.position.set(0, -430, 310);
  orbit.target.set(0, 0, 30);
});
document.getElementById('cam-top').addEventListener('click', () => {
  camera.position.set(0, -1, 520);
  orbit.target.set(0, 0, 0);
});
document.getElementById('cam-front').addEventListener('click', () => {
  camera.position.set(0, -480, 80);
  orbit.target.set(0, 0, 60);
});
document.getElementById('cam-right').addEventListener('click', () => {
  camera.position.set(480, 0, 80);
  orbit.target.set(0, 0, 60);
});

// 拖曳上傳支援
const dropOverlay = document.getElementById('drop-overlay');
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('hidden');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) dropOverlay.classList.add('hidden');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropOverlay.classList.add('hidden');
  if (e.dataTransfer.files.length > 0) {
    try {
      const { geometry, name } = await parseImportedFile(e.dataTransfer.files[0]);
      setLoadedGeometry(geometry, name);
    } catch (err) {
      alert(err.message);
    }
  }
});

// 預設載入教學模型
setLoadedGeometry(createDemoGeometry(), 'Bambu_A2L_Teaching_Demo');
