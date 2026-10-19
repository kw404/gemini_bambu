import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export const BED_SIZE = { x: 330, y: 320, z: 325 };

export function initScene(container, onTransformEnd, onTransformChange) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x191919);

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

  scene.add(new THREE.AmbientLight(0xffffff, 0.75));

  const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight1.position.set(200, -250, 400);
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0x90b0ff, 0.35);
  dirLight2.position.set(-250, 250, 200);
  scene.add(dirLight2);

  scene.add(createTexturedPEIPlate());

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

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  function animate() {
    requestAnimationFrame(animate);
    orbit.update();
    renderer.render(scene, camera);
  }
  animate();

  return { scene, camera, renderer, orbit, transformControl };
}

function createTexturedPEIPlate() {
  const plateGroup = new THREE.Group();
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

  const borderGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(BED_SIZE.x, BED_SIZE.y, 0.2));
  plateGroup.add(new THREE.LineSegments(borderGeo, new THREE.LineBasicMaterial({ color: 0x00ae42 })));

  const volGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(BED_SIZE.x, BED_SIZE.y, BED_SIZE.z));
  const volLines = new THREE.LineSegments(
    volGeo,
    new THREE.LineBasicMaterial({ color: 0x3a3a3a, transparent: true, opacity: 0.4 })
  );
  volLines.position.set(0, 0, BED_SIZE.z / 2);
  plateGroup.add(volLines);

  const axes = new THREE.AxesHelper(35);
  axes.position.set(-halfX, -halfY, 0.2);
  plateGroup.add(axes);

  return plateGroup;
}

export function snapMeshToBed(mesh) {
  if (!mesh) return;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  if (isFinite(box.min.z)) {
    mesh.position.z -= box.min.z;
    mesh.updateMatrixWorld(true);
  }
}

// 建立百分之百封閉水密（Watertight Manifold）、無共面抵銷、無空層的單一整合教學模型
// 透過 2D 側面輪廓直接拉伸 (ExtrudeGeometry)，保證所有階梯與懸空屋簷在 Bambu Studio 中 100% 連續無空層！
export function createDemoGeometry() {
  // 在 X-Z 平面定義一體成型的「階梯 + 右側懸空屋簷 + 頂部凸台」封閉多邊形輪廓
  // 這樣完全不會有任何兩個獨立方塊在 Z=10, Z=20, Z=26 共面相撞導致 Bambu Studio 報空層錯誤！
  const profile = new THREE.Shape();

  // 從左下角 (-26, 0) 開始逆時針繞一圈：
  profile.moveTo(-26, 0);
  profile.lineTo(18, 0);     // 底座寬 44mm (X: -26 ~ +18)
  profile.lineTo(18, 10);    // 第一階高度 Z = 10mm
  profile.lineTo(0, 10);     // 第一階平台頂面 (X: 0 ~ +18, Z = 10)
  profile.lineTo(0, 20);     // 第二階高度 Z = 20mm
  profile.lineTo(30, 20);    // 懸空屋簷底面！從 X=0 直接向右延伸到 X=+30 (懸空長達 30mm，其中 X=18~30 直接對著熱床懸空)
  profile.lineTo(30, 26);    // 懸空屋簷厚度 6mm (Z: 20 ~ 26)
  profile.lineTo(-8, 26);    // 屋簷右側頂面 (X: -8 ~ +30, Z = 26)
  profile.lineTo(-8, 34);    // 頂部方塔凸台高度 Z = 34mm (X: -22 ~ -8)
  profile.lineTo(-22, 34);   // 頂部凸台頂面 (Z = 34)
  profile.lineTo(-22, 26);   // 回到 Z = 26 左側屋頂
  profile.lineTo(-26, 26);   // 左側邊緣
  profile.closePath();       // 回到 (-26, 0) 完美封閉

  const depthY = 40; // Y 軸深度 40mm
  const geo = new THREE.ExtrudeGeometry(profile, {
    steps: 1,
    depth: depthY,
    bevelEnabled: false
  });

  // ExtrudeGeometry 預設在 X-Y 平面並沿 Z 拉伸，我們將它轉正為 X-Z 輪廓、沿 Y 軸前後對稱
  geo.rotateX(Math.PI / 2);
  geo.translate(0, depthY / 2, 0);
  geo.computeVertexNormals();
  return geo;
}
