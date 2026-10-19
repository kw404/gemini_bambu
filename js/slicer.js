import * as THREE from 'three';

const PATTERN_LABELS = {
  grid: '網格 (Grid)',
  honeycomb: '蜂巢 (Honeycomb)',
  gyroid: '陀螺儀 (Gyroid)',
  triangles: '三角形 (Triangles)',
  rectilinear: '直線 (Rectilinear)'
};

export function sliceMesh(modelMesh, cfg) {
  modelMesh.updateMatrixWorld(true);

  const geom = modelMesh.geometry;
  const nonIndexed = geom.index ? geom.toNonIndexed() : geom;
  const posAttr = nonIndexed.attributes.position;
  const matrix = modelMesh.matrixWorld;

  const triCount = Math.floor(posAttr.count / 3);
  const tris = [];
  const box = new THREE.Box3();

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();

  const overhangPoints = [];
  const cosThreshold = Math.cos(((90 - cfg.supportAngle) * Math.PI) / 180);

  for (let i = 0; i < triCount; i++) {
    vA.fromBufferAttribute(posAttr, i * 3).applyMatrix4(matrix);
    vB.fromBufferAttribute(posAttr, i * 3 + 1).applyMatrix4(matrix);
    vC.fromBufferAttribute(posAttr, i * 3 + 2).applyMatrix4(matrix);

    box.expandByPoint(vA);
    box.expandByPoint(vB);
    box.expandByPoint(vC);

    const zMin = Math.min(vA.z, vB.z, vC.z);
    const zMax = Math.max(vA.z, vB.z, vC.z);

    tris.push({ a: vA.clone(), b: vB.clone(), c: vC.clone(), zMin, zMax });

    // 偵測懸空面以生成支撐
    if (cfg.supportEnable && zMin > 1.5) {
      cb.subVectors(vC, vB);
      ab.subVectors(vA, vB);
      cb.cross(ab).normalize();
      if (cb.z < -cosThreshold) {
        overhangPoints.push({
          x: (vA.x + vB.x + vC.x) / 3,
          y: (vA.y + vB.y + vC.y) / 3,
          z: (vA.z + vB.z + vC.z) / 3
        });
      }
    }
  }

  // 計算各層 Z 高度
  const maxZ = Math.max(0.4, box.max.z);
  const layerZs = [];
  let currentZ = cfg.initialLayerHeight;
  while (currentZ <= maxZ + 0.001) {
    layerZs.push(Number(currentZ.toFixed(3)));
    currentZ += cfg.layerHeight;
  }
  if (layerZs.length === 0) layerZs.push(cfg.initialLayerHeight);
  const totalLayers = layerZs.length;

  const previewGroup = new THREE.Group();
  const layerGroups = [];

  // Bambu Studio 標準線型顏色
  const matOuterWall = new THREE.LineBasicMaterial({ color: 0xff7b24 });
  const matInnerWall = new THREE.LineBasicMaterial({ color: 0xffd026 });
  const matInfill = new THREE.LineBasicMaterial({ color: 0xd9383a });
  const matTopBottom = new THREE.LineBasicMaterial({ color: 0x9a4dff });
  const matSupport = new THREE.LineBasicMaterial({ color: 0x23d160 });
  const matBrim = new THREE.LineBasicMaterial({ color: 0x2b8cff });

  // 支撐柱格點合併
  const supportColumns = new Map();
  if (cfg.supportEnable && overhangPoints.length > 0) {
    for (const pt of overhangPoints) {
      const gx = Math.round(pt.x / 4) * 4;
      const gy = Math.round(pt.y / 4) * 4;
      const key = `${gx},${gy}`;
      if (!supportColumns.has(key) || supportColumns.get(key).z < pt.z) {
        supportColumns.set(key, { x: gx, y: gy, z: pt.z });
      }
    }
  }

  let totalExtrusionLengthMM = 0;

  // 逐層切平面運算
  for (let lIdx = 0; lIdx < totalLayers; lIdx++) {
    const z = layerZs[lIdx];
    const layerObj = new THREE.Group();

    const outerVerts = [];
    const innerVerts = [];
    const infillVerts = [];
    const shellVerts = [];
    const supportVerts = [];
    const brimVerts = [];

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let sumX = 0, sumY = 0, segCount = 0;

    // 1. 外牆輪廓交線
    for (let t = 0; t < tris.length; t++) {
      const tri = tris[t];
      if (z < tri.zMin || z > tri.zMax) continue;

      const pts = intersectTriangleZ(tri.a, tri.b, tri.c, z);
      if (pts.length === 2) {
        const p1 = pts[0], p2 = pts[1];
        outerVerts.push(p1.x, p1.y, z, p2.x, p2.y, z);
        totalExtrusionLengthMM += Math.hypot(p2.x - p1.x, p2.y - p1.y) * cfg.wallLoops;

        minX = Math.min(minX, p1.x, p2.x);
        maxX = Math.max(maxX, p1.x, p2.x);
        minY = Math.min(minY, p1.y, p2.y);
        maxY = Math.max(maxY, p1.y, p2.y);
        sumX += (p1.x + p2.x) * 0.5;
        sumY += (p1.y + p2.y) * 0.5;
        segCount++;
      }
    }

    const cx = segCount > 0 ? sumX / segCount : 0;
    const cy = segCount > 0 ? sumY / segCount : 0;

    // 2. 內牆圈數 (Inner Wall Loops)
    if (!cfg.spiralVase && cfg.wallLoops > 1 && outerVerts.length > 0) {
      const loops = Math.min(cfg.wallLoops - 1, 5);
      for (let w = 1; w <= loops; w++) {
        const inset = Math.max(0.75, 1 - w * 0.032);
        for (let i = 0; i < outerVerts.length; i += 6) {
          innerVerts.push(
            cx + (outerVerts[i] - cx) * inset,
            cy + (outerVerts[i + 1] - cy) * inset,
            z,
            cx + (outerVerts[i + 3] - cx) * inset,
            cy + (outerVerts[i + 4] - cy) * inset,
            z
          );
        }
      }
    }

    // 3. 頂部/底部實心殼層 vs 內部稀疏填充 (含蜂巢、陀螺儀等 5 種演算法)
    const isShellLayer =
      !cfg.spiralVase && (lIdx < cfg.bottomLayers || lIdx >= totalLayers - cfg.topLayers);

    if (segCount > 0 && isFinite(minX)) {
      if (isShellLayer) {
        // 頂底殼層：高密度平行線
        const shellStep = cfg.lineWidth * 2.3;
        const angle = lIdx % 2 === 0 ? 0 : Math.PI / 2;
        const len = generateRotatedHatch(
          outerVerts, minX, maxX, minY, maxY, z, shellStep, angle, shellVerts
        );
        totalExtrusionLengthMM += len;
      } else if (cfg.infillDensity > 0 && !cfg.spiralVase) {
        // 計算填充間距 (密度越高間距越小)
        const spacing = Math.max(2.2, 22 * (1 - cfg.infillDensity / 112));
        const len = generatePatternInfill(
          cfg.infillPattern,
          outerVerts,
          minX,
          maxX,
          minY,
          maxY,
          z,
          lIdx,
          spacing,
          infillVerts
        );
        totalExtrusionLengthMM += len;
      }
    }

    // 4. 支撐結構
    if (cfg.supportEnable && supportColumns.size > 0) {
      const isTree = cfg.supportType.includes('tree');
      supportColumns.forEach((col) => {
        if (z < col.z - cfg.layerHeight) {
          const r = isTree ? 1.7 * (1 - (z / col.z) * 0.35) : 1.5;
          supportVerts.push(
            col.x - r, col.y - r, z, col.x + r, col.y - r, z,
            col.x + r, col.y - r, z, col.x + r, col.y + r, z,
            col.x + r, col.y + r, z, col.x - r, col.y + r, z,
            col.x - r, col.y + r, z, col.x - r, col.y - r, z
          );
          totalExtrusionLengthMM += r * 8;
        }
      });
    }

    // 5. 第一層裙邊 (Brim)
    if (lIdx === 0 && cfg.brimType !== 'no_brim' && cfg.brimWidth > 0 && isFinite(minX)) {
      const rings = Math.min(8, Math.max(2, Math.round(cfg.brimWidth / 0.8)));
      for (let r = 1; r <= rings; r++) {
        const pad = r * 0.8;
        const bx0 = minX - pad, bx1 = maxX + pad;
        const by0 = minY - pad, by1 = maxY + pad;
        brimVerts.push(
          bx0, by0, z, bx1, by0, z,
          bx1, by0, z, bx1, by1, z,
          bx1, by1, z, bx0, by1, z,
          bx0, by1, z, bx0, by0, z
        );
        totalExtrusionLengthMM += (bx1 - bx0 + by1 - by0) * 2;
      }
    }

    addLinesToGroup(layerObj, outerVerts, matOuterWall);
    addLinesToGroup(layerObj, innerVerts, matInnerWall);
    addLinesToGroup(layerObj, infillVerts, matInfill);
    addLinesToGroup(layerObj, shellVerts, matTopBottom);
    addLinesToGroup(layerObj, supportVerts, matSupport);
    addLinesToGroup(layerObj, brimVerts, matBrim);

    layerGroups.push(layerObj);
    previewGroup.add(layerObj);
  }

  // 計算預估耗材與時間
  const filamentArea = Math.PI * Math.pow(1.75 / 2, 2);
  const extrusionVolumeMM3 = totalExtrusionLengthMM * cfg.lineWidth * cfg.layerHeight;
  const filamentLengthM = extrusionVolumeMM3 / filamentArea / 1000;
  const weightGrams = (extrusionVolumeMM3 / 1000) * 1.24;
  const avgSpeed = (cfg.speedOuter + cfg.speedInner + cfg.speedInfill) / 3;
  const timeSeconds = totalExtrusionLengthMM / (avgSpeed * 0.55) + totalLayers * 1.8;

  return {
    previewGroup,
    layerZs,
    layerGroups,
    totalLayers,
    filamentLengthM: Math.max(0.15, filamentLengthM),
    weightGrams: Math.max(0.5, weightGrams),
    timeSeconds: Math.max(60, timeSeconds),
    patternLabel: PATTERN_LABELS[cfg.infillPattern] || cfg.infillPattern,
    settings: cfg
  };
}

// ============================================================================
// 5 種真實幾何填充圖案產生器 (皆自動裁切於該層輪廓多邊形內)
// ============================================================================
function generatePatternInfill(pattern, outerVerts, minX, maxX, minY, maxY, z, lIdx, spacing, outVerts) {
  if (pattern === 'honeycomb') {
    // 正六角形蜂巢結構 (Honeycomb Hexagonal Grid)
    return generateHoneycombInfill(outerVerts, minX, maxX, minY, maxY, z, spacing, outVerts);
  } else if (pattern === 'gyroid') {
    // 陀螺儀波浪結構 (Gyroid - 隨 Z 層高度相位移動的正交正弦曲線)
    return generateGyroidInfill(outerVerts, minX, maxX, minY, maxY, z, spacing, outVerts);
  } else if (pattern === 'triangles') {
    // 三角形網格 (0°, 60°, 120° 三向交叉)
    let len = 0;
    len += generateRotatedHatch(outerVerts, minX, maxX, minY, maxY, z, spacing * 1.15, 0, outVerts);
    len += generateRotatedHatch(outerVerts, minX, maxX, minY, maxY, z, spacing * 1.15, Math.PI / 3, outVerts);
    len += generateRotatedHatch(outerVerts, minX, maxX, minY, maxY, z, spacing * 1.15, (2 * Math.PI) / 3, outVerts);
    return len;
  } else if (pattern === 'rectilinear') {
    // 直線交替 (奇偶層 ±45° 交替)
    const angle = lIdx % 2 === 0 ? Math.PI / 4 : -Math.PI / 4;
    return generateRotatedHatch(outerVerts, minX, maxX, minY, maxY, z, spacing * 0.85, angle, outVerts);
  } else {
    // 預設網格 (Grid - 雙向正交)
    let len = 0;
    len += generateRotatedHatch(outerVerts, minX, maxX, minY, maxY, z, spacing, 0, outVerts);
    len += generateRotatedHatch(outerVerts, minX, maxX, minY, maxY, z, spacing, Math.PI / 2, outVerts);
    return len;
  }
}

// 1. 蜂巢 (Honeycomb) 正六角形幾何生成與多邊形內部裁切
function generateHoneycombInfill(outerVerts, minX, maxX, minY, maxY, z, spacing, outVerts) {
  let addedLength = 0;
  const R = Math.max(2.0, spacing * 0.65); // 六角形邊長半徑
  const dx = R * 1.5;
  const dy = R * Math.sqrt(3);

  const cols = Math.ceil((maxX - minX) / dx) + 2;
  const rows = Math.ceil((maxY - minY) / dy) + 2;

  for (let col = -1; col <= cols; col++) {
    const cx = minX + col * dx;
    const yOffset = (col & 1) ? dy * 0.5 : 0;

    for (let row = -1; row <= rows; row++) {
      const cy = minY + row * dy + yOffset;

      // 每個六角形繪製左半與水平三條邊，避免相鄰六角形重複繪製
      const hexCorners = [];
      for (let k = 0; k < 6; k++) {
        const ang = (k * Math.PI) / 3;
        hexCorners.push({
          x: cx + R * Math.cos(ang),
          y: cy + R * Math.sin(ang)
        });
      }

      for (let k = 0; k < 3; k++) {
        const p1 = hexCorners[k];
        const p2 = hexCorners[(k + 1) % 6];
        addedLength += clipSubdividedSegment(outerVerts, p1.x, p1.y, p2.x, p2.y, z, outVerts);
      }
    }
  }
  return addedLength;
}

// 2. 陀螺儀 (Gyroid) 隨 Z 高度相位擺動之正弦波路徑
function generateGyroidInfill(outerVerts, minX, maxX, minY, maxY, z, spacing, outVerts) {
  let addedLength = 0;
  const waveStep = Math.max(2.5, spacing * 0.95);
  const amp = waveStep * 0.38;
  const freq = (2 * Math.PI) / (waveStep * 2.2);
  const phaseZ = z * 0.65;
  const segStep = 1.6;

  // 水平方向波浪
  for (let baseY = minY; baseY <= maxY; baseY += waveStep) {
    let prevX = minX;
    let prevY = baseY + Math.sin(prevX * freq + phaseZ) * amp;
    for (let x = minX + segStep; x <= maxX; x += segStep) {
      const curY = baseY + Math.sin(x * freq + phaseZ) * amp;
      const mx = (prevX + x) * 0.5;
      const my = (prevY + curY) * 0.5;
      if (isPointInPolygon(outerVerts, mx, my)) {
        outVerts.push(prevX, prevY, z, x, curY, z);
        addedLength += Math.hypot(x - prevX, curY - prevY);
      }
      prevX = x;
      prevY = curY;
    }
  }

  // 垂直方向正交相位波浪
  for (let baseX = minX; baseX <= maxX; baseX += waveStep) {
    let prevY = minY;
    let prevX = baseX + Math.cos(prevY * freq - phaseZ) * amp;
    for (let y = minY + segStep; y <= maxY; y += segStep) {
      const curX = baseX + Math.cos(y * freq - phaseZ) * amp;
      const mx = (prevX + curX) * 0.5;
      const my = (prevY + y) * 0.5;
      if (isPointInPolygon(outerVerts, mx, my)) {
        outVerts.push(prevX, prevY, z, curX, y, z);
        addedLength += Math.hypot(curX - prevX, y - prevY);
      }
      prevY = y;
      prevX = curX;
    }
  }

  return addedLength;
}

// 3. 任意角度平行掃描線裁切 (支援 0°, 45°, 60°, 90°, 120° 等)
function generateRotatedHatch(outerVerts, minX, maxX, minY, maxY, z, spacing, angleRad, outVerts) {
  let addedLength = 0;
  const cosA = Math.cos(-angleRad);
  const sinA = Math.sin(-angleRad);
  const cosInv = Math.cos(angleRad);
  const sinInv = Math.sin(angleRad);

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const radius = Math.hypot(maxX - minX, maxY - minY) * 0.55;

  for (let v = -radius; v <= radius; v += spacing) {
    const uHits = [];

    for (let i = 0; i < outerVerts.length; i += 6) {
      const dx1 = outerVerts[i] - cx;
      const dy1 = outerVerts[i + 1] - cy;
      const dx2 = outerVerts[i + 3] - cx;
      const dy2 = outerVerts[i + 4] - cy;

      const u1 = dx1 * cosA - dy1 * sinA;
      const v1 = dx1 * sinA + dy1 * cosA;
      const u2 = dx2 * cosA - dy2 * sinA;
      const v2 = dx2 * sinA + dy2 * cosA;

      if ((v1 <= v && v2 > v) || (v2 <= v && v1 > v)) {
        const t = (v - v1) / (v2 - v1);
        uHits.push(u1 + t * (u2 - u1));
      }
    }

    uHits.sort((a, b) => a - b);
    for (let k = 0; k + 1 < uHits.length; k += 2) {
      const ua = uHits[k] + 0.35;
      const ub = uHits[k + 1] - 0.35;
      if (ub > ua) {
        const x1 = cx + ua * cosInv - v * sinInv;
        const y1 = cy + ua * sinInv + v * cosInv;
        const x2 = cx + ub * cosInv - v * sinInv;
        const y2 = cy + ub * sinInv + v * cosInv;
        outVerts.push(x1, y1, z, x2, y2, z);
        addedLength += ub - ua;
      }
    }
  }
  return addedLength;
}

// 將短線段細分並判斷是否位於輪廓多邊形內部 (奇偶射線法 Even-Odd Rule)
function clipSubdividedSegment(outerVerts, x1, y1, x2, y2, z, outVerts) {
  const subs = 3;
  let len = 0;
  for (let s = 0; s < subs; s++) {
    const t0 = s / subs;
    const t1 = (s + 1) / subs;
    const sx0 = x1 + (x2 - x1) * t0;
    const sy0 = y1 + (y2 - y1) * t0;
    const sx1 = x1 + (x2 - x1) * t1;
    const sy1 = y1 + (y2 - y1) * t1;
    const mx = (sx0 + sx1) * 0.5;
    const my = (sy0 + sy1) * 0.5;

    if (isPointInPolygon(outerVerts, mx, my)) {
      outVerts.push(sx0, sy0, z, sx1, sy1, z);
      len += Math.hypot(sx1 - sx0, sy1 - sy0);
    }
  }
  return len;
}

function isPointInPolygon(outerVerts, px, py) {
  let inside = false;
  for (let i = 0; i < outerVerts.length; i += 6) {
    const x1 = outerVerts[i], y1 = outerVerts[i + 1];
    const x2 = outerVerts[i + 3], y2 = outerVerts[i + 4];
    if ((y1 > py) !== (y2 > py)) {
      const xIntersect = ((x2 - x1) * (py - y1)) / (y2 - y1) + x1;
      if (px < xIntersect) inside = !inside;
    }
  }
  return inside;
}

function intersectTriangleZ(a, b, c, z) {
  const pts = [];
  checkEdge(a, b, z, pts);
  checkEdge(b, c, z, pts);
  checkEdge(c, a, z, pts);
  return pts.slice(0, 2);
}

function checkEdge(p1, p2, z, out) {
  if ((p1.z <= z && p2.z > z) || (p2.z <= z && p1.z > z)) {
    const t = (z - p1.z) / (p2.z - p1.z);
    out.push({
      x: p1.x + t * (p2.x - p1.x),
      y: p1.y + t * (p2.y - p1.y)
    });
  }
}

function addLinesToGroup(group, verts, mat) {
  if (verts.length === 0) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  group.add(new THREE.LineSegments(geo, mat));
}
