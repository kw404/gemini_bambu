import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// Bambu Lab A2L 成型空間尺寸 (mm)
export const BED_SIZE = { x: 330, y: 320, z: 325 };

export function initScene(container, onTransformEnd, onTransformChange) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x191919);

  // 設定 Z 軸朝上，與 Bambu Studio 3D 列印座標系一致
  THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

  const camera = new THREE.PerspectiveCamera(
    42,
    container.clientWidth / container.clientHeight,
    1,
    3000
  );
  camera.position.set(0, -430, 310);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.target.set(0, 0, 30);
  orbit.maxPolarAngle = Math.PI / 2 + 0.15;

  // 燈光配置
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));

  const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight1.position.set(200, -250, 400);
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0x90b0ff, 0.35);
  dirLight2.position.set(-250, 250, 200);
  scene.add(dirLight2);

  // 建立 A2L 紋理 PEI 熱床板
  scene.add(createTexturedPEIPlate());

  // 模型移動/旋轉/縮放控制器
  const transformControl = new TransformControls(camera, renderer.domElement);
  transformControl.setSpace('world');
  transformControl.addEventListener('dragging-changed', (event) => {
    orbit.enabled = !event.value;
    if (!event.value && onTransformEnd) onTransformEnd();
  });
  transformControl.addEventListener('change', () => {
    if (onTransformChange) onTransformChange();
  });
  scene.add(transformControl);

  // 視窗大小自適應
  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  // 啟動渲染迴圈
  function animate() {
    requestAnimationFrame(animate);
    orbit.update();
    renderer.render(scene, camera);
  }
  animate();

  return { scene, camera, renderer, orbit, transformControl };
}

// 建立 Textured PEI Plate 視覺模型
function createTexturedPEIPlate() {
  const plateGroup = new THREE.Group();

  // 產生深灰金屬磨砂紋理貼圖
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#252629';
  ctx.fillRect(0, 0, 512, 512);

  for (let i = 0; i < 28000; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const v = 35 + Math.floor(Math.random() * 35);
    ctx.fillStyle = `rgb(${v},${v},${v + 3})`;
    ctx.fillRect(x, y, 1.5, 1.5);
  }

  const peiTexture = new THREE.CanvasTexture(canvas);
  peiTexture.wrapS = THREE.RepeatWrapping;
  peiTexture.wrapT = THREE.RepeatWrapping;
  peiTexture.repeat.set(4, 4);

  const plateGeo = new THREE.BoxGeometry(BED_SIZE.x, BED_SIZE.y, 2);
  const plateMat = new THREE.MeshStandardMaterial({
    map: peiTexture,
    roughness: 0.65,
    metalness: 0.35
  });
  const plateMesh = new THREE.Mesh(plateGeo, plateMat);
  plateMesh.position.set(0, 0, -1.05);
  plateGroup.add(plateMesh);

  // 每 10mm 繪製格線
  const gridVertices = [];
  const halfX = BED_SIZE.x / 2;
  const halfY = BED_SIZE.y / 2;

  for (let x = -halfX; x <= halfX; x += 10) {
    gridVertices.push(x, -halfY, 0.05, x, halfY, 0.05);
  }
  for (let y = -halfY; y <= halfY; y += 10) {
    gridVertices.push(-halfX, y, 0.05, halfX, y, 0.05);
  }
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridVertices, 3));
  plateGroup.add(
    new THREE.LineSegments(
      gridGeo,
      new THREE.LineBasicMaterial({ color: 0x45484c, transparent: true, opacity: 0.55 })
    )
  );

  // 綠色熱床外框與成型高度外框
  const borderGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(BED_SIZE.x, BED_SIZE.y, 0.2));
  plateGroup.add(new THREE.LineSegments(borderGeo, new THREE.LineBasicMaterial({ color: 0x00ae42 })));

  const volGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(BED_SIZE.x, BED_SIZE.y, BED_SIZE.z));
  const volLines = new THREE.LineSegments(
    volGeo,
    new THREE.LineBasicMaterial({ color: 0x3a3a3a, transparent: true, opacity: 0.4 })
  );
  volLines.position.set(0, 0, BED_SIZE.z / 2);
  plateGroup.add(volLines);

  // 左下角原點座標軸指示器
  const axes = new THREE.AxesHelper(35);
  axes.position.set(-halfX, -halfY, 0.2);
  plateGroup.add(axes);

  return plateGroup;
}

// 讓模型底部自動貼齊 Z=0 熱床表面
export function snapMeshToBed(mesh) {
  if (!mesh) return;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  if (isFinite(box.min.z)) {
    mesh.position.z -= box.min.z;
    mesh.updateMatrixWorld(true);
  }
}

// 建立內建教學範例模型（含懸空結構與大面積內部空間，方便觀察蜂巢填充與支撐）
export function createDemoGeometry() {
  const geometries = [];

  // 寬底板主體 (60 x 50 x 12 mm) - 內部空間大，非常適合觀察蜂巢與陀螺儀填充
  const base = new THREE.BoxGeometry(60, 50, 12);
  base.translate(0, 0, 6);
  geometries.push(base);

  // 第二階方塊 (34 x 36 x 10 mm)
  const mid = new THREE.BoxGeometry(34, 36, 10);
  mid.translate(-10, 0, 17);
  geometries.push(mid);

  // 懸空屋頂 (52 x 26 x 5 mm) - 用於練習啟用支撐
  const roof = new THREE.BoxGeometry(52, 26, 5);
  roof.translate(4, 0, 24.5);
  geometries.push(roof);

  // 頂部圓柱 (直徑 16mm)
  const cyl = new THREE.CylinderGeometry(8, 8, 8, 28);
  cyl.rotateX(Math.PI / 2);
  cyl.translate(-8, 0, 31);
  geometries.push(cyl);

  const positions = [];
  for (const g of geometries) {
    const nonIdx = g.index ? g.toNonIndexed() : g;
    const posAttr = nonIdx.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.computeVertexNormals();
  return out;
}
