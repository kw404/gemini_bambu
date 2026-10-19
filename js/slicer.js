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

  // 賦予 3D 擠出線條真實厚度的材質與光影表現
  const matConfig = { roughness: 0.3, metalness: 0.1 };
  const matOuterWall = new THREE.MeshStandardMaterial({ color: 0xff7b24, ...matConfig });
  const matInnerWall = new THREE.MeshStandardMaterial({ color: 0xffd026, ...matConfig });
  const matInfill = new THREE.MeshStandardMaterial({ color: 0xd9383a, ...matConfig });
  const matTopBottom = new THREE.MeshStandardMaterial({ color: 0x9a4dff, ...matConfig });
  const matSupport = new THREE.MeshStandardMaterial({ color: 0x23d160, ...matConfig });
  const matBrim = new THREE.MeshStandardMaterial({ color: 0x2b8cff, ...matConfig });

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

  for (let lIdx = 0; lIdx < totalLayers; lIdx++) {
    const z = layerZs[lIdx];
    const layerObj = new THREE.Group();

    const outerSegments = [];
    const innerSegments = [];
    const infillSegments = [];
    const shellSegments = [];
    const supportSegments = [];
    const brimSegments = [];

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let sumX = 0, sumY = 0, segCount = 0;

    for (let t = 0; t < tris.length; t++) {
      const tri = tris[t];
      if (z < tri.zMin || z > tri.zMax) continue;

      const pts = intersectTriangleZ(tri.a, tri.b, tri.c, z);
      if (pts.length === 2) {
        const p1 = pts[0], p2 = pts[1];
        outerSegments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
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

    if (!cfg.spiralVase && cfg.wallLoops > 1 && outerSegments.length > 0) {
      const loops = Math.min(cfg.wallLoops - 1, 5);
      for (let w = 1; w <= loops; w++) {
        const inset = Math.max(0.75, 1 - w * 0.032);
        for (const seg of outerSegments) {
          innerSegments.push({
            x1: cx + (seg.x1 - cx) * inset,
            y1: cy + (seg.y1 - cy) * inset,
            x2: cx + (seg.x2 - cx) * inset,
            y2: cy + (seg.y2 - cy) * inset
          });
        }
      }
    }

    const isShellLayer =
      !cfg.spiralVase && (lIdx < cfg.bottomLayers || lIdx >= totalLayers - cfg.topLayers);

    const outerVertsForClip = [];
    for (const s of outerSegments) outerVertsForClip.push(s.x1, s.y1, z, s.x2, s.y2, z);

    if (segCount > 0 && isFinite(minX)) {
      if (isShellLayer) {
        const shellStep = cfg.lineWidth * 2.3;
        const angle = lIdx % 2 === 0 ? 0 : Math.PI / 2;
        const len = generateRotatedHatchSegments(
          outerVertsForClip, minX, maxX, minY, maxY, shellStep, angle, shellSegments
        );
        totalExtrusionLengthMM += len;
      } else if (cfg.infillDensity > 0 && !cfg.spiralVase) {
        const spacing = Math.max(2.2, 22 * (1 - cfg.infillDensity / 112));
        const len = generatePatternInfillSegments(
          cfg.infillPattern, outerVertsForClip, minX, maxX, minY, maxY, lIdx, spacing, infillSegments
        );
        totalExtrusionLengthMM += len;
      }
    }

    if (cfg.supportEnable && supportColumns.size > 0) {
      const isTree = cfg.supportType.includes('tree');
      supportColumns.forEach((col) => {
        if (z < col.z - cfg.layerHeight) {
          const r = isTree ? 1.7 * (1 - (z / col.z) * 0.35) : 1.5;
          supportSegments.push(
            { x1: col.x - r, y1: col.y - r, x2: col.x + r, y2: col.y - r },
            { x1: col.x + r, y1: col.y - r, x2: col.x + r, y2: col.y + r },
            { x1: col.x + r, y1: col.y + r, x2: col.x - r, y2: col.y + r },
            { x1: col.x - r, y1: col.y + r, x2: col.x - r, y2: col.y - r }
          );
          totalExtrusionLengthMM += r * 8;
        }
      });
    }

    if (lIdx === 0 && cfg.brimType !== 'no_brim' && cfg.brimWidth > 0 && isFinite(minX)) {
      const rings = Math.min(8, Math.max(2, Math.round(cfg.brimWidth / 0.8)));
      for (let r = 1; r <= rings; r++) {
        const pad = r * 0.8;
        const bx0 = minX - pad, bx1 = maxX + pad;
        const by0 = minY - pad, by1 = maxY + pad;
        brimSegments.push(
          { x1: bx0, y1: by0, x2: bx1, y2: by0 },
          { x1: bx1, y1: by0, x2: bx1, y2: by1 },
          { x1: bx1, y1: by1, x2: bx0, y2: by1 },
          { x1: bx0, y1: by1, x2: bx0, y2: by0 }
        );
        totalExtrusionLengthMM += (bx1 - bx0 + by1 - by0) * 2;
      }
    }

    // 將所有線段以具備真實厚度的 3D 擠出網格（Mesh）加入場景
    addThickSegmentsToGroup(layerObj, outerSegments, z, cfg.lineWidth, matOuterWall);
    addThickSegmentsToGroup(layerObj, innerSegments, z, cfg.lineWidth * 0.9, matInnerWall);
    addThickSegmentsToGroup(layerObj, infillSegments, z, cfg.lineWidth * 0.85, matInfill);
    addThickSegmentsToGroup(layerObj, shellSegments, z, cfg.lineWidth * 0.9, matTopBottom);
    addThickSegmentsToGroup(layerObj, supportSegments, z, cfg.lineWidth * 0.9, matSupport);
    addThickSegmentsToGroup(layerObj, brimSegments, z, cfg.lineWidth, matBrim);

    layerGroups.push(layerObj);
    previewGroup.add(layerObj);
  }

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

// 關鍵核心：將每一條 2D 路徑轉換為帶有寬度與高度的 3D 實心擠出方塊（BoxGeometry），創造厚度並解決穿透
function addThickSegmentsToGroup(group, segments, z, thickness, material) {
  if (!segments || segments.length === 0) return;

  const geometries = [];
  const halfT = Math.max(0.12, thickness * 0.5);
  const layerH = 0.19; // 模擬擠出層高厚度

  for (const seg of segments) {
    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;

    const boxGeo = new THREE.BoxGeometry(len, thickness, layerH);
    const mx = (seg.x1 + seg.x2) * 0.5;
    const my = (seg.y1 + seg.y2) * 0.5;
    const mz = z + layerH * 0.5;

    boxGeo.translate(len * 0.5, 0, 0);
    const angle = Math.atan2(dy, dx);
    boxGeo.rotateZ(angle);
    boxGeo.translate(mx, my, mz);
    geometries.push(boxGeo);
  }

  if (geometries.length > 0) {
    const mergedGeo = mergeBufferGeometriesSafe(geometries);
    const mesh = new THREE.Mesh(mergedGeo, material);
    group.add(mesh);
  }
}

function mergeBufferGeometriesSafe(geos) {
  const positions = [];
  const normals = [];
  const uvs = [];

  for (const g of geos) {
    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (norm) normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      if (uv) uvs.push(uv.getX(i), uv.getY(i));
    }
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length > 0) out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (uvs.length > 0) out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return out;
}

function generatePatternInfillSegments(pattern, outerVerts, minX, maxX, minY, maxY, lIdx, spacing, outSegs) {
  if (pattern === 'honeycomb') {
    return generateHoneycombSegments(outerVerts, minX, maxX, minY, maxY, spacing, outSegs);
  } else if (pattern === 'gyroid') {
    return generateGyroidSegments(outerVerts, minX, maxX, minY, maxY, spacing, outSegs);
  } else if (pattern === 'triangles') {
    let len = 0;
    len += generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, spacing * 1.15, 0, outSegs);
    len += generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, spacing * 1.15, Math.PI / 3, outSegs);
    len += generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, spacing * 1.15, (2 * Math.PI) / 3, outSegs);
    return len;
  } else if (pattern === 'rectilinear') {
    const angle = lIdx % 2 === 0 ? Math.PI / 4 : -Math.PI / 4;
    return generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, spacing * 0.85, angle, outSegs);
  } else {
    let len = 0;
    len += generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, spacing, 0, outSegs);
    len += generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, spacing, Math.PI / 2, outSegs);
    return len;
  }
}

function generateHoneycombSegments(outerVerts, minX, maxX, minY, maxY, spacing, outSegs) {
  let addedLength = 0;
  const R = Math.max(2.0, spacing * 0.65);
  const dx = R * 1.5;
  const dy = R * Math.sqrt(3);

  const cols = Math.ceil((maxX - minX) / dx) + 2;
  const rows = Math.ceil((maxY - minY) / dy) + 2;

  for (let col = -1; col <= cols; col++) {
    const cx = minX + col * dx;
    const yOffset = (col & 1) ? dy * 0.5 : 0;

    for (let row = -1; row <= rows; row++) {
      const cy = minY + row * dy + yOffset;
      const hexCorners = [];
      for (let k = 0; k < 6; k++) {
        const ang = (k * Math.PI) / 3;
        hexCorners.push({ x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) });
      }

      for (let k = 0; k < 3; k++) {
        const p1 = hexCorners[k];
        const p2 = hexCorners[(k + 1) % 6];
        addedLength += clipSubdividedSegmentToSegments(outerVerts, p1.x, p1.y, p2.x, p2.y, outSegs);
      }
    }
  }
  return addedLength;
}

function generateGyroidSegments(outerVerts, minX, maxX, minY, maxY, spacing, outSegs) {
  let addedLength = 0;
  const waveStep = Math.max(2.5, spacing * 0.95);
  const amp = waveStep * 0.38;
  const freq = (2 * Math.PI) / (waveStep * 2.2);
  const segStep = 1.6;

  for (let baseY = minY; baseY <= maxY; baseY += waveStep) {
    let prevX = minX;
    let prevY = baseY + Math.sin(prevX * freq) * amp;
    for (let x = minX + segStep; x <= maxX; x += segStep) {
      const curY = baseY + Math.sin(x * freq) * amp;
      const mx = (prevX + x) * 0.5;
      const my = (prevY + curY) * 0.5;
      if (isPointInPolygon(outerVerts, mx, my)) {
        outSegs.push({ x1: prevX, y1: prevY, x2: x, y2: curY });
        addedLength += Math.hypot(x - prevX, curY - prevY);
      }
      prevX = x;
      prevY = curY;
    }
  }
  return addedLength;
}

function generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, spacing, angleRad, outSegs) {
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
        outSegs.push({ x1, y1, x2, y2 });
        addedLength += ub - ua;
      }
    }
  }
  return addedLength;
}

function clipSubdividedSegmentToSegments(outerVerts, x1, y1, x2, y2, outSegs) {
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
      outSegs.push({ x1: sx0, y1: sy0, x2: sx1, y2: sy1 });
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
