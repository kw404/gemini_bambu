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

// 建立一體成型（無重疊面）、具備階梯頂面、懸空屋簷與頂部圓柱的教學模型
// 請替換 js/scene.js 底部的 createDemoGeometry 函式：
export function createDemoGeometry() {
  const geometries = [];

  // 第 1 層大底盤：X = -30 ~ +22, Z = 0 ~ 10 mm (52 x 46 x 10)
  const step1 = new THREE.BoxGeometry(52, 46, 10);
  step1.translate(-4, 0, 5);
  geometries.push(step1);

  // 第 2 層階梯：X = -30 ~ +4, Z = 10 ~ 20 mm (34 x 46 x 10)，右側留出 Z=10mm 的階梯平台
  const step2 = new THREE.BoxGeometry(34, 46, 10);
  step2.translate(-13, 0, 15);
  geometries.push(step2);

  // 第 3 層懸空屋頂：X = -30 ~ +36, Z = 20 ~ 26 mm (66 x 32 x 6)
  // 其中 X = +4 ~ +22 懸空在第一階平台上；X = +22 ~ +36 則完全懸空在 PEI 熱床上方！
  const roof = new THREE.BoxGeometry(66, 32, 6);
  roof.translate(3, 0, 23);
  geometries.push(roof);

  // 第 4 層頂部圓柱：Z = 26 ~ 34 mm (半徑 9mm，高 8mm)
  const cyl = new THREE.CylinderGeometry(9, 9, 8, 32);
  cyl.rotateX(Math.PI / 2);
  cyl.translate(-13, 0, 30);
  geometries.push(cyl);

  const positions = [];
  for (const g of geometries) {
    const nonIdx = g.index ? g.toNonIndexed() : g;
    const posAttr = nonIdx.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    }
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.computeVertexNormals();
  return out;
}
