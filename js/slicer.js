import * as THREE from 'three';

const PATTERN_LABELS = {
  grid: '網格 (Grid)',
  honeycomb: '蜂巢 (Honeycomb)',
  gyroid: '陀螺儀 (Gyroid)',
  triangles: '三角形 (Triangles)',
  rectilinear: '直線 (Rectilinear)'
};

const UNIT_EXTRUSION_GEO = new THREE.BoxGeometry(1, 1, 1);

export function sliceMesh(modelMesh, cfg) {
  modelMesh.updateMatrixWorld(true);

  const geom = modelMesh.geometry;
  const nonIndexed = geom.index ? geom.toNonIndexed() : geom;
  const posAttr = nonIndexed.attributes.position;
  const matrix = modelMesh.matrixWorld;

  const triCount = Math.floor(posAttr.count / 3);
  const tris = [];
  const flatZTris = [];
  const box = new THREE.Box3();

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();

  // 判斷懸空角度：水平懸空面法向量 nz = -1，當 nz < -sin(thresholdAngle) 時需要支撐
  const supportNzLimit = -Math.sin((Math.max(5, cfg.supportAngle) * Math.PI) / 180);

  for (let i = 0; i < triCount; i++) {
    vA.fromBufferAttribute(posAttr, i * 3).applyMatrix4(matrix);
    vB.fromBufferAttribute(posAttr, i * 3 + 1).applyMatrix4(matrix);
    vC.fromBufferAttribute(posAttr, i * 3 + 2).applyMatrix4(matrix);

    box.expandByPoint(vA);
    box.expandByPoint(vB);
    box.expandByPoint(vC);

    const zMin = Math.min(vA.z, vB.z, vC.z);
    const zMax = Math.max(vA.z, vB.z, vC.z);

    cb.subVectors(vC, vB);
    ab.subVectors(vA, vB);
    cb.cross(ab).normalize();

    const triObj = {
      a: vA.clone(),
      b: vB.clone(),
      c: vC.clone(),
      zMin,
      zMax,
      nz: cb.z,
      minX: Math.min(vA.x, vB.x, vC.x),
      maxX: Math.max(vA.x, vB.x, vC.x),
      minY: Math.min(vA.y, vB.y, vC.y),
      maxY: Math.max(vA.y, vB.y, vC.y)
    };
    tris.push(triObj);

    if (Math.abs(cb.z) > 0.35) {
      flatZTris.push(triObj);
    }
  }

  // ============================================================================
  // 真實 2D 網格垂直射線支撐偵測 (Raycasting Support Columns)
  // ============================================================================
  const supportSpans = [];
  if (cfg.supportEnable && isFinite(box.min.x)) {
    const gridStep = 3.6; // 支撐柱格點間距 (mm)
    for (let gx = box.min.x + 1.5; gx <= box.max.x - 1.5; gx += gridStep) {
      for (let gy = box.min.y + 1.5; gy <= box.max.y - 1.5; gy += gridStep) {
        // 收集通過 (gx, gy) 的所有頂面與底面交點
        const hits = [];
        for (let i = 0; i < flatZTris.length; i++) {
          const t = flatZTris[i];
          if (gx < t.minX || gx > t.maxX || gy < t.minY || gy > t.maxY) continue;
          if (pointInTri2D(gx, gy, t.a, t.b, t.c)) {
            const zHit = interpolateZOnTri(gx, gy, t.a, t.b, t.c);
            hits.push({ z: zHit, nz: t.nz });
          }
        }
        if (hits.length === 0) continue;

        // 依高度由低到高排序並去除重疊面
        hits.sort((a, b) => a.z - b.z);

        for (let h = 0; h < hits.length; h++) {
          const hit = hits[h];
          // 若是朝下的懸空面 (nz <= supportNzLimit) 且距離底部超過 1.2mm
          if (hit.nz <= supportNzLimit && hit.z > 1.2) {
            // 往下方尋找最近的一個朝上模型頂面 (nz > 0.2)
            let zBase = 0;
            for (let k = h - 1; k >= 0; k--) {
              if (hits[k].nz > 0.2 && hits[k].z < hit.z - 0.8) {
                zBase = hits[k].z;
                break;
              }
            }

            // 檢查這個區間中點是否誤處於其他疊加方塊的內部
            if (hit.z - zBase > 1.2) {
              // 若勾選「僅在列印板生成」，則只允許 zBase 接近 0 (熱床) 的支撐柱
              if (cfg.supportBuildPlateOnly && zBase > 0.6) continue;

              supportSpans.push({
                x: gx,
                y: gy,
                zBottom: zBase,
                zTop: hit.z
              });
            }
          }
        }
      }
    }
  }

  const maxZ = Math.max(0.4, box.max.z);
  const layerZs = [];
  let currentZ = cfg.initialLayerHeight;
  while (currentZ <= maxZ - 0.02) {
    layerZs.push(Number(currentZ.toFixed(3)));
    currentZ += cfg.layerHeight;
  }
  if (layerZs.length === 0) layerZs.push(cfg.initialLayerHeight);
  const totalLayers = layerZs.length;

  const previewGroup = new THREE.Group();
  const layerGroups = [];

  const matConfig = { roughness: 0.35, metalness: 0.08 };
  const matOuterWall = new THREE.MeshStandardMaterial({ color: 0xff7b24, ...matConfig });
  const matInnerWall = new THREE.MeshStandardMaterial({ color: 0xffd026, ...matConfig });
  const matInfill = new THREE.MeshStandardMaterial({ color: 0xd9383a, ...matConfig });
  const matTopBottom = new THREE.MeshStandardMaterial({ color: 0x9a4dff, ...matConfig });
  const matSupport = new THREE.MeshStandardMaterial({ color: 0x23d160, ...matConfig });
  const matBrim = new THREE.MeshStandardMaterial({ color: 0x2b8cff, ...matConfig });

  let totalExtrusionLengthMM = 0;
  let supportExtrusionLengthMM = 0;
  const topShellThicknessZ = cfg.topLayers * cfg.layerHeight + 0.05;
  const bottomShellThicknessZ = cfg.bottomLayers * cfg.layerHeight + 0.05;

  const densityRatio = Math.max(0.02, Math.min(0.98, cfg.infillDensity / 100));
  const realInfillSpacing = Math.max(cfg.lineWidth * 1.3, (cfg.lineWidth * 1.95) / densityRatio);

  for (let lIdx = 0; lIdx < totalLayers; lIdx++) {
    const z = layerZs[lIdx];
    const zSafe = z + 0.0037;
    const layerObj = new THREE.Group();

    const outerSegments = [];
    const innerSegments = [];
    const infillSegments = [];
    const shellSegments = [];
    const supportSegments = [];
    const brimSegments = [];

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let segCount = 0;

    // 1. 外牆交線
    for (let t = 0; t < tris.length; t++) {
      const tri = tris[t];
      if (zSafe < tri.zMin || zSafe > tri.zMax) continue;

      const pts = intersectTriangleZ(tri.a, tri.b, tri.c, zSafe);
      if (pts.length === 2) {
        const p1 = pts[0], p2 = pts[1];
        const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (segLen < 0.02) continue;

        outerSegments.push({
          x1: p1.x,
          y1: p1.y,
          x2: p2.x,
          y2: p2.y,
          nx: -(p2.y - p1.y) / segLen,
          ny: (p2.x - p1.x) / segLen
        });
        totalExtrusionLengthMM += segLen * cfg.wallLoops;

        minX = Math.min(minX, p1.x, p2.x);
        maxX = Math.max(maxX, p1.x, p2.x);
        minY = Math.min(minY, p1.y, p2.y);
        maxY = Math.max(maxY, p1.y, p2.y);
        segCount++;
      }
    }

    const outerVertsForClip = [];
    for (const s of outerSegments) {
      outerVertsForClip.push(s.x1, s.y1, z, s.x2, s.y2, z);
    }

    // 2. 內牆圈數
    if (!cfg.spiralVase && cfg.wallLoops > 1 && outerSegments.length > 0) {
      const loops = Math.min(cfg.wallLoops - 1, 5);
      for (let w = 1; w <= loops; w++) {
        const offsetDist = w * (cfg.lineWidth * 0.92);
        for (const seg of outerSegments) {
          const mx = (seg.x1 + seg.x2) * 0.5;
          const my = (seg.y1 + seg.y2) * 0.5;
          const testX = mx + seg.nx * 0.3;
          const testY = my + seg.ny * 0.3;
          const dir = isPointInPolygon(outerVertsForClip, testX, testY) ? 1 : -1;

          const ox = seg.nx * offsetDist * dir;
          const oy = seg.ny * offsetDist * dir;

          const dx = seg.x2 - seg.x1;
          const dy = seg.y2 - seg.y1;
          const len = Math.hypot(dx, dy);
          const shrink = Math.min(0.35, offsetDist / Math.max(1, len));

          const sx1 = seg.x1 + dx * shrink + ox;
          const sy1 = seg.y1 + dy * shrink + oy;
          const sx2 = seg.x2 - dx * shrink + ox;
          const sy2 = seg.y2 - dy * shrink + oy;

          if (isSegmentStrictlyInside(outerVertsForClip, sx1, sy1, sx2, sy2, 0.15)) {
            innerSegments.push({ x1: sx1, y1: sy1, x2: sx2, y2: sy2 });
          }
        }
      }
    }

    // 3. 頂底封頂殼層 vs 內部稀疏填充
    const isGlobalBottomOrTop =
      !cfg.spiralVase && (lIdx < cfg.bottomLayers || lIdx >= totalLayers - cfg.topLayers);

    if (segCount > 0 && isFinite(minX) && !cfg.spiralVase) {
      const wallInset = cfg.wallLoops * cfg.lineWidth * 0.95;
      const shellStep = cfg.lineWidth * 1.4;
      const shellAngle = lIdx % 2 === 0 ? Math.PI / 4 : -Math.PI / 4;

      if (isGlobalBottomOrTop) {
        totalExtrusionLengthMM += generateRotatedHatchSegments(
          outerVertsForClip, minX, maxX, minY, maxY, shellStep, shellAngle, wallInset, shellSegments
        );
      } else {
        const localShellCandidates = [];
        generateRotatedHatchSegments(
          outerVertsForClip, minX, maxX, minY, maxY, shellStep, shellAngle, wallInset, localShellCandidates
        );

        for (const cand of localShellCandidates) {
          const length = Math.hypot(cand.x2 - cand.x1, cand.y2 - cand.y1);
          const steps = Math.max(1, Math.ceil(length / 2.8));
          for (let s = 0; s < steps; s++) {
            const t0 = s / steps;
            const t1 = (s + 1) / steps;
            const x1 = cand.x1 + (cand.x2 - cand.x1) * t0;
            const y1 = cand.y1 + (cand.y2 - cand.y1) * t0;
            const x2 = cand.x1 + (cand.x2 - cand.x1) * t1;
            const y2 = cand.y1 + (cand.y2 - cand.y1) * t1;
            const mx = (x1 + x2) * 0.5;
            const my = (y1 + y2) * 0.5;

            if (isNearTopOrBottomSurface(flatZTris, mx, my, z, topShellThicknessZ, bottomShellThicknessZ)) {
              shellSegments.push({ x1, y1, x2, y2 });
              totalExtrusionLengthMM += Math.hypot(x2 - x1, y2 - y1);
            }
          }
        }

        if (cfg.infillDensity > 0) {
          const rawInfill = [];
          generatePatternInfillSegments(
            cfg.infillPattern,
            outerVertsForClip,
            minX,
            maxX,
            minY,
            maxY,
            z,
            lIdx,
            realInfillSpacing,
            wallInset,
            rawInfill
          );

          for (const seg of rawInfill) {
            const mx = (seg.x1 + seg.x2) * 0.5;
            const my = (seg.y1 + seg.y2) * 0.5;
            if (!isNearTopOrBottomSurface(flatZTris, mx, my, z, topShellThicknessZ, bottomShellThicknessZ)) {
              infillSegments.push(seg);
              totalExtrusionLengthMM += Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
            }
          }
        }
      }
    }

    // 4. 生成支撐結構（普通方格柱狀 Normal vs 樹狀有機圓環分支 Tree）
    if (cfg.supportEnable && supportSpans.length > 0) {
      const isTree = cfg.supportType.includes('tree') || cfg.supportStyle === 'organic';

      for (let s = 0; s < supportSpans.length; s++) {
        const sp = supportSpans[s];
        if (z > sp.zBottom + 0.05 && z < sp.zTop - cfg.layerHeight * 0.6) {
          // 確保支撐點不會畫進該層已經存在的模型實體多邊形內
          if (outerVertsForClip.length > 0 && isPointInPolygon(outerVertsForClip, sp.x, sp.y)) {
            continue;
          }

          const progress = (z - sp.zBottom) / Math.max(1, sp.zTop - sp.zBottom);

          if (isTree) {
            // 樹狀支撐：底部粗、往上漸細並略微向中心聚攏的八角形樹幹
            const radius = 1.9 * (1 - progress * 0.42);
            const trunkShiftX = Math.sin(progress * Math.PI) * 0.6;
            const cx = sp.x + trunkShiftX;
            const cy = sp.y;
            const sides = 6;
            for (let k = 0; k < sides; k++) {
              const a1 = (k * 2 * Math.PI) / sides;
              const a2 = ((k + 1) * 2 * Math.PI) / sides;
              supportSegments.push({
                x1: cx + radius * Math.cos(a1),
                y1: cy + radius * Math.sin(a1),
                x2: cx + radius * Math.cos(a2),
                y2: cy + radius * Math.sin(a2)
              });
            }
            supportExtrusionLengthMM += radius * 6;
          } else {
            // 普通支撐 (Normal)：蛇行波浪折線支撐牆 + 頂部接觸介面層
            const r = 1.55;
            const isInterfaceLayer = z > sp.zTop - cfg.layerHeight * 3.2;
            if (isInterfaceLayer) {
              // 支撐頂部接觸層（密集格線）
              supportSegments.push(
                { x1: sp.x - r, y1: sp.y - r, x2: sp.x + r, y2: sp.y - r },
                { x1: sp.x - r, y1: sp.y, x2: sp.x + r, y2: sp.y },
                { x1: sp.x - r, y1: sp.y + r, x2: sp.x + r, y2: sp.y + r }
              );
            } else {
              // 普通支撐主體（方柱加對角支撐肋）
              supportSegments.push(
                { x1: sp.x - r, y1: sp.y - r, x2: sp.x + r, y2: sp.y - r },
                { x1: sp.x + r, y1: sp.y - r, x2: sp.x + r, y2: sp.y + r },
                { x1: sp.x + r, y1: sp.y + r, x2: sp.x - r, y2: sp.y + r },
                { x1: sp.x - r, y1: sp.y + r, x2: sp.x - r, y2: sp.y - r }
              );
            }
            supportExtrusionLengthMM += r * 8;
          }
        }
      }
      totalExtrusionLengthMM += supportExtrusionLengthMM;
    }

    // 5. 第一層裙邊 (Brim)
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

    const h = cfg.layerHeight * 0.92;
    addInstancedExtrusions(layerObj, outerSegments, z, cfg.lineWidth, h, matOuterWall);
    addInstancedExtrusions(layerObj, innerSegments, z, cfg.lineWidth * 0.9, h, matInnerWall);
    addInstancedExtrusions(layerObj, infillSegments, z, cfg.lineWidth * 0.85, h, matInfill);
    addInstancedExtrusions(layerObj, shellSegments, z, cfg.lineWidth * 0.95, h, matTopBottom);
    addInstancedExtrusions(layerObj, supportSegments, z, cfg.lineWidth * 0.88, h, matSupport);
    addInstancedExtrusions(layerObj, brimSegments, z, cfg.initialLineWidth, h, matBrim);

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
    hasSupportGenerated: supportSpans.length > 0,
    settings: cfg
  };
}

// 計算平面三角形在 (px, py) 處的精確 Z 高度
function interpolateZOnTri(px, py, a, b, c) {
  const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(det) < 1e-6) return (a.z + b.z + c.z) / 3;
  const l1 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / det;
  const l2 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / det;
  const l3 = 1 - l1 - l2;
  return l1 * a.z + l2 * b.z + l3 * c.z;
}

function addInstancedExtrusions(group, segments, z, width, height, material) {
  if (!segments || segments.length === 0) return;

  const validSegs = [];
  for (const s of segments) {
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    if (len >= 0.05) validSegs.push({ ...s, len });
  }
  if (validSegs.length === 0) return;

  const instMesh = new THREE.InstancedMesh(UNIT_EXTRUSION_GEO, material, validSegs.length);
  const dummy = new THREE.Object3D();
  const zCenter = z - height * 0.5;

  for (let i = 0; i < validSegs.length; i++) {
    const seg = validSegs[i];
    const mx = (seg.x1 + seg.x2) * 0.5;
    const my = (seg.y1 + seg.y2) * 0.5;
    const angle = Math.atan2(seg.y2 - seg.y1, seg.x2 - seg.x1);

    dummy.position.set(mx, my, zCenter);
    dummy.rotation.set(0, 0, angle);
    dummy.scale.set(seg.len + width * 0.2, width, height);
    dummy.updateMatrix();
    instMesh.setMatrixAt(i, dummy.matrix);
  }

  instMesh.instanceMatrix.needsUpdate = true;
  group.add(instMesh);
}

function isNearTopOrBottomSurface(flatZTris, px, py, z, topThick, bottomThick) {
  for (let i = 0; i < flatZTris.length; i++) {
    const t = flatZTris[i];
    if (px < t.minX || px > t.maxX || py < t.minY || py > t.maxY) continue;

    if (t.nz > 0.35 && t.zMax >= z - 0.05 && t.zMin <= z + topThick) {
      if (pointInTri2D(px, py, t.a, t.b, t.c)) return true;
    }
    if (t.nz < -0.35 && t.zMin <= z + 0.05 && t.zMax >= z - bottomThick) {
      if (pointInTri2D(px, py, t.a, t.b, t.c)) return true;
    }
  }
  return false;
}

function pointInTri2D(px, py, a, b, c) {
  const d1 = (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
  const d2 = (px - c.x) * (b.y - c.y) - (b.x - c.x) * (py - c.y);
  const d3 = (px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y);
  const hasNeg = d1 < -0.001 || d2 < -0.001 || d3 < -0.001;
  const hasPos = d1 > 0.001 || d2 > 0.001 || d3 > 0.001;
  return !(hasNeg && hasPos);
}

function generatePatternInfillSegments(
  pattern, outerVerts, minX, maxX, minY, maxY, z, lIdx, spacing, wallInset, outSegs
) {
  if (pattern === 'honeycomb') {
    return generateHoneycombSegments(outerVerts, minX, maxX, minY, maxY, spacing, wallInset, outSegs);
  } else if (pattern === 'gyroid') {
    return generateGyroidSegments(outerVerts, minX, maxX, minY, maxY, z, spacing, wallInset, outSegs);
  } else if (pattern === 'triangles') {
    const triSpacing = spacing * 1.5;
    let len = 0;
    len += generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, triSpacing, 0, wallInset, outSegs);
    len += generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, triSpacing, Math.PI / 3, wallInset, outSegs);
    len += generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, triSpacing, (2 * Math.PI) / 3, wallInset, outSegs);
    return len;
  } else if (pattern === 'rectilinear') {
    const rectSpacing = Math.max(0.6, spacing * 0.55);
    const angle = lIdx % 2 === 0 ? Math.PI / 4 : -Math.PI / 4;
    return generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, rectSpacing, angle, wallInset, outSegs);
  } else {
    let len = 0;
    len += generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, spacing, Math.PI / 4, wallInset, outSegs);
    len += generateRotatedHatchSegments(outerVerts, minX, maxX, minY, maxY, spacing, -Math.PI / 4, wallInset, outSegs);
    return len;
  }
}

function generateHoneycombSegments(outerVerts, minX, maxX, minY, maxY, spacing, wallInset, outSegs) {
  let addedLength = 0;
  const R = Math.max(1.2, spacing * 0.65);
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
        addedLength += clipSegmentStrictlyInside(outerVerts, p1.x, p1.y, p2.x, p2.y, wallInset, outSegs);
      }
    }
  }
  return addedLength;
}

function generateGyroidSegments(outerVerts, minX, maxX, minY, maxY, z, spacing, wallInset, outSegs) {
  let addedLength = 0;
  const waveStep = Math.max(1.8, spacing * 0.95);
  const amp = waveStep * 0.36;
  const freq = (2 * Math.PI) / (waveStep * 2.2);
  const phaseZ = z * 0.65;
  const segStep = Math.max(0.8, Math.min(1.6, waveStep * 0.3));

  for (let baseY = minY; baseY <= maxY; baseY += waveStep) {
    let prevX = minX;
    let prevY = baseY + Math.sin(prevX * freq + phaseZ) * amp;
    for (let x = minX + segStep; x <= maxX; x += segStep) {
      const curY = baseY + Math.sin(x * freq + phaseZ) * amp;
      if (isSegmentStrictlyInside(outerVerts, prevX, prevY, x, curY, wallInset)) {
        outSegs.push({ x1: prevX, y1: prevY, x2: x, y2: curY });
        addedLength += Math.hypot(x - prevX, curY - prevY);
      }
      prevX = x;
      prevY = curY;
    }
  }

  for (let baseX = minX; baseX <= maxX; baseX += waveStep) {
    let prevY = minY;
    let prevX = baseX + Math.cos(prevY * freq - phaseZ) * amp;
    for (let y = minY + segStep; y <= maxY; y += segStep) {
      const curX = baseX + Math.cos(y * freq - phaseZ) * amp;
      if (isSegmentStrictlyInside(outerVerts, prevX, prevY, curX, y, wallInset)) {
        outSegs.push({ x1: prevX, y1: prevY, x2: curX, y2: y });
        addedLength += Math.hypot(curX - prevX, y - prevY);
      }
      prevY = y;
      prevX = curX;
    }
  }
  return addedLength;
}

function generateRotatedHatchSegments(
  outerVerts, minX, maxX, minY, maxY, spacing, angleRad, insetMargin, outSegs
) {
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
      const ua = uHits[k] + insetMargin;
      const ub = uHits[k + 1] - insetMargin;
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

function clipSegmentStrictlyInside(outerVerts, x1, y1, x2, y2, wallInset, outSegs) {
  const segLen = Math.hypot(x2 - x1, y2 - y1);
  const subs = Math.max(3, Math.ceil(segLen / 1.2));
  let len = 0;

  for (let s = 0; s < subs; s++) {
    const t0 = s / subs;
    const t1 = (s + 1) / subs;
    const sx0 = x1 + (x2 - x1) * t0;
    const sy0 = y1 + (y2 - y1) * t0;
    const sx1 = x1 + (x2 - x1) * t1;
    const sy1 = y1 + (y2 - y1) * t1;

    if (isSegmentStrictlyInside(outerVerts, sx0, sy0, sx1, sy1, wallInset)) {
      outSegs.push({ x1: sx0, y1: sy0, x2: sx1, y2: sy1 });
      len += Math.hypot(sx1 - sx0, sy1 - sy0);
    }
  }
  return len;
}

function isSegmentStrictlyInside(outerVerts, x1, y1, x2, y2, margin) {
  const mx = (x1 + x2) * 0.5;
  const my = (y1 + y2) * 0.5;

  if (!isPointInPolygon(outerVerts, mx, my)) return false;
  if (!isPointInPolygon(outerVerts, x1, y1)) return false;
  if (!isPointInPolygon(outerVerts, x2, y2)) return false;

  if (margin > 0) {
    const mSq = margin * margin * 0.7;
    for (let i = 0; i < outerVerts.length; i += 6) {
      const ax = outerVerts[i], ay = outerVerts[i + 1];
      const bx = outerVerts[i + 3], by = outerVerts[i + 4];
      if (distToSegmentSq(x1, y1, ax, ay, bx, by) < mSq) return false;
      if (distToSegmentSq(x2, y2, ax, ay, bx, by) < mSq) return false;
      if (distToSegmentSq(mx, my, ax, ay, bx, by) < mSq) return false;
    }
  }
  return true;
}

function distToSegmentSq(px, py, vx, vy, wx, wy) {
  const l2 = (wx - vx) * (wx - vx) + (wy - vy) * (wy - vy);
  if (l2 === 0) return (px - vx) * (px - vx) + (py - vy) * (py - vy);
  let t = ((px - vx) * (wx - vx) + (py - vy) * (wy - vy)) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = vx + t * (wx - vx);
  const projY = vy + t * (wy - vy);
  return (px - projX) * (px - projX) + (py - projY) * (py - projY);
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
