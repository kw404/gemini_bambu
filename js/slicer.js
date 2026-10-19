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
  const nonVerticalTris = [];
  const box = new THREE.Box3();

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();

  let signedVolumeSum = 0;
  let sideSurfaceAreaMM2 = 0;
  let flatTopBottomAreaMM2 = 0;

  const minOverhangAbsNz = Math.sin((Math.max(5, cfg.supportAngle) * Math.PI) / 180);

  for (let i = 0; i < triCount; i++) {
    vA.fromBufferAttribute(posAttr, i * 3).applyMatrix4(matrix);
    vB.fromBufferAttribute(posAttr, i * 3 + 1).applyMatrix4(matrix);
    vC.fromBufferAttribute(posAttr, i * 3 + 2).applyMatrix4(matrix);

    box.expandByPoint(vA);
    box.expandByPoint(vB);
    box.expandByPoint(vC);

    signedVolumeSum += vA.dot(cb.crossVectors(vB, vC)) / 6.0;

    const zMin = Math.min(vA.z, vB.z, vC.z);
    const zMax = Math.max(vA.z, vB.z, vC.z);

    cb.subVectors(vC, vB);
    ab.subVectors(vA, vB);
    const crossVec = cb.cross(ab);
    const triArea = crossVec.length() * 0.5;
    const normal = crossVec.normalize();
    const absNz = Math.abs(normal.z);

    if (absNz > 0.7) {
      flatTopBottomAreaMM2 += triArea;
    } else {
      sideSurfaceAreaMM2 += triArea;
    }

    const triObj = {
      a: vA.clone(),
      b: vB.clone(),
      c: vC.clone(),
      zMin,
      zMax,
      nz: normal.z,
      absNz,
      minX: Math.min(vA.x, vB.x, vC.x),
      maxX: Math.max(vA.x, vB.x, vC.x),
      minY: Math.min(vA.y, vB.y, vC.y),
      maxY: Math.max(vA.y, vB.y, vC.y)
    };
    tris.push(triObj);

    if (absNz > 0.15) {
      nonVerticalTris.push(triObj);
    }
  }

  const realMeshVolumeMM3 = Math.abs(signedVolumeSum);
  const isTreeSupport =
    cfg.supportEnable && (cfg.supportType.includes('tree') || cfg.supportStyle === 'organic');

  // ============================================================================
  // 1. 偵測所有懸空支撐目標點 (Support Tips)
  // ============================================================================
  const supportSpans = [];
  let totalSupportHeightMM = 0;

  if (cfg.supportEnable && isFinite(box.min.x)) {
    const gridStep = isTreeSupport ? 4.2 : 3.6;
    for (let gx = box.min.x + 1.8; gx <= box.max.x - 1.8; gx += gridStep) {
      for (let gy = box.min.y + 1.8; gy <= box.max.y - 1.8; gy += gridStep) {
        const rx = gx + 0.013;
        const ry = gy + 0.017;

        const rawHits = [];
        for (let i = 0; i < nonVerticalTris.length; i++) {
          const t = nonVerticalTris[i];
          if (rx < t.minX || rx > t.maxX || ry < t.minY || ry > t.maxY) continue;
          if (pointInTri2D(rx, ry, t.a, t.b, t.c)) {
            const zHit = interpolateZOnTri(rx, ry, t.a, t.b, t.c);
            rawHits.push({ z: zHit, absNz: t.absNz });
          }
        }
        if (rawHits.length === 0) continue;

        rawHits.sort((a, b) => a.z - b.z);

        const uniqueHits = [rawHits[0]];
        for (let i = 1; i < rawHits.length; i++) {
          if (rawHits[i].z - uniqueHits[uniqueHits.length - 1].z > 0.15) {
            uniqueHits.push(rawHits[i]);
          }
        }

        for (let k = 0; k < uniqueHits.length; k += 2) {
          const enterHit = uniqueHits[k];
          const zTop = enterHit.z;

          if (zTop > 1.2 && enterHit.absNz >= minOverhangAbsNz) {
            const zBottom = k === 0 ? 0 : uniqueHits[k - 1].z;

            if (zTop - zBottom > 1.2) {
              // 注意：普通支撐若勾選「僅在列印板生成」會略過模型上方的點；
              // 但原廠「樹狀支撐」會從列印板外圍長出斜向樹幹繞過模型去托住它！
              if (!isTreeSupport && cfg.supportBuildPlateOnly && zBottom > 0.6) continue;

              supportSpans.push({
                x: gx,
                y: gy,
                zBottom,
                zTop
              });
              totalSupportHeightMM += zTop - (isTreeSupport ? 0 : zBottom);
            }
          }
        }
      }
    }
  }

  // ============================================================================
  // 2. 若為樹狀支撐：建構「主樹幹 (Trunks) -> 中間分枝 (Forks) -> 頂部細枝 (Tips)」階層樹結構
  // ============================================================================
  const treeStructures = isTreeSupport ? buildOrganicTreeStructures(supportSpans, box, cfg) : [];

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
  const matSupport = new THREE.MeshStandardMaterial({ color: 0x18b84e, ...matConfig });
  const matBrim = new THREE.MeshStandardMaterial({ color: 0x2b8cff, ...matConfig });

  const topShellThicknessZ = cfg.topLayers * cfg.layerHeight + 0.05;
  const bottomShellThicknessZ = cfg.bottomLayers * cfg.layerHeight + 0.05;

  const densityRatio = Math.max(0.02, Math.min(0.98, cfg.infillDensity / 100));
  const realInfillSpacing = Math.max(cfg.lineWidth * 1.3, (cfg.lineWidth * 1.95) / densityRatio);

  let brimExtrusionMM = 0;

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
        generateRotatedHatchSegments(
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

            if (isNearHorizontalSurface(nonVerticalTris, mx, my, z, topShellThicknessZ, bottomShellThicknessZ)) {
              shellSegments.push({ x1, y1, x2, y2 });
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
            if (!isNearHorizontalSurface(nonVerticalTris, mx, my, z, topShellThicknessZ, bottomShellThicknessZ)) {
              infillSegments.push(seg);
            }
          }
        }
      }
    }

    // ============================================================================
    // 4. 支撐結構繪製：有機分岔樹狀支撐 (Organic Tree) vs 普通柱狀支撐 (Normal)
    // ============================================================================
    if (cfg.supportEnable) {
      if (isTreeSupport && treeStructures.length > 0) {
        // 繪製有機樹狀支撐在當前高度 Z 的所有圓管截面與底盤裙邊
        generateOrganicTreeLayerSegments(treeStructures, z, lIdx, cfg, outerVertsForClip, supportSegments);
      } else if (!isTreeSupport && supportSpans.length > 0) {
        // 普通方格支撐 (Normal)
        for (let s = 0; s < supportSpans.length; s++) {
          const sp = supportSpans[s];
          if (z > sp.zBottom + 0.05 && z < sp.zTop - cfg.layerHeight * 0.5) {
            if (outerVertsForClip.length > 0 && isPointInPolygon(outerVertsForClip, sp.x, sp.y)) {
              continue;
            }
            const r = 1.55;
            const isInterfaceLayer = z > sp.zTop - cfg.layerHeight * 3.2;
            if (isInterfaceLayer) {
              supportSegments.push(
                { x1: sp.x - r, y1: sp.y - r, x2: sp.x + r, y2: sp.y - r },
                { x1: sp.x - r, y1: sp.y, x2: sp.x + r, y2: sp.y },
                { x1: sp.x - r, y1: sp.y + r, x2: sp.x + r, y2: sp.y + r }
              );
            } else {
              supportSegments.push(
                { x1: sp.x - r, y1: sp.y - r, x2: sp.x + r, y2: sp.y - r },
                { x1: sp.x + r, y1: sp.y - r, x2: sp.x + r, y2: sp.y + r },
                { x1: sp.x + r, y1: sp.y + r, x2: sp.x - r, y2: sp.y + r },
                { x1: sp.x - r, y1: sp.y + r, x2: sp.x - r, y2: sp.y - r }
              );
            }
          }
        }
      }
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
        brimExtrusionMM += (bx1 - bx0 + by1 - by0) * 2;
      }
    }

    const h = cfg.layerHeight * 0.92;
    addInstancedExtrusions(layerObj, outerSegments, z, cfg.lineWidth, h, matOuterWall);
    addInstancedExtrusions(layerObj, innerSegments, z, cfg.lineWidth * 0.9, h, matInnerWall);
    addInstancedExtrusions(layerObj, infillSegments, z, cfg.lineWidth * 0.85, h, matInfill);
    addInstancedExtrusions(layerObj, shellSegments, z, cfg.lineWidth * 0.95, h, matTopBottom);
    addInstancedExtrusions(layerObj, supportSegments, z, cfg.lineWidth * 0.92, h, matSupport);
    addInstancedExtrusions(layerObj, brimSegments, z, cfg.initialLineWidth, h, matBrim);

    layerGroups.push(layerObj);
    previewGroup.add(layerObj);
  }

  // 基於真實 3D 網格幾何體積計算耗材克數與時間
  const volOuterWall = sideSurfaceAreaMM2 * cfg.lineWidth;
  const volInnerWall = cfg.spiralVase
    ? 0
    : sideSurfaceAreaMM2 * Math.max(0, cfg.wallLoops - 1) * (cfg.lineWidth * 0.92);
  const avgShellLayers = (cfg.topLayers + cfg.bottomLayers) * 0.5;
  const volShell = cfg.spiralVase
    ? (flatTopBottomAreaMM2 * 0.5) * cfg.bottomLayers * cfg.layerHeight
    : flatTopBottomAreaMM2 * avgShellLayers * cfg.layerHeight;

  const shellAndWallVol = Math.min(realMeshVolumeMM3 * 0.92, volOuterWall + volInnerWall + volShell);
  const interiorCoreVolume = Math.max(0, realMeshVolumeMM3 - shellAndWallVol);
  const patternMultiplier =
    cfg.infillPattern === 'honeycomb' ? 1.15 : cfg.infillPattern === 'gyroid' ? 1.1 : 1.0;
  const volInfill = cfg.spiralVase
    ? 0
    : interiorCoreVolume * (cfg.infillDensity / 100) * patternMultiplier;

  const supportAreaPerCol = isTreeSupport ? 2.1 : 3.1;
  const volSupport = cfg.supportEnable ? totalSupportHeightMM * supportAreaPerCol : 0;
  const volBrim = brimExtrusionMM * cfg.initialLineWidth * cfg.initialLayerHeight;

  const totalExtrudedVolumeMM3 =
    volOuterWall + volInnerWall + volShell + volInfill + volSupport + volBrim;

  const filamentCrossSectionMM2 = Math.PI * Math.pow(1.75 * 0.5, 2);
  const filamentLengthM = totalExtrudedVolumeMM3 / filamentCrossSectionMM2 / 1000;
  const weightGrams = (totalExtrudedVolumeMM3 / 1000) * 1.24;

  const beadArea = Math.max(0.04, cfg.lineWidth * cfg.layerHeight * 0.9);
  const accelEfficiency = 0.58;
  const timeSeconds =
    (volOuterWall / beadArea) / (cfg.speedOuter * accelEfficiency) +
    (volInnerWall / beadArea) / (cfg.speedInner * accelEfficiency) +
    (volInfill / beadArea) / (cfg.speedInfill * accelEfficiency) +
    (volShell / beadArea) / (cfg.speedInner * 0.75 * accelEfficiency) +
    (volSupport / beadArea) / (cfg.speedInfill * 0.7 * accelEfficiency) +
    (volBrim / beadArea) / (cfg.speedInitial * accelEfficiency) +
    totalLayers * 1.4;

  const safeVol = Math.max(1, totalExtrudedVolumeMM3);
  const pctByType = {
    outer: Math.round((volOuterWall / safeVol) * 100),
    inner: Math.round((volInnerWall / safeVol) * 100),
    infill: Math.round((volInfill / safeVol) * 100),
    shell: Math.round((volShell / safeVol) * 100),
    support: Math.round((volSupport / safeVol) * 100),
    brim: Math.max(volBrim > 0 ? 1 : 0, Math.round((volBrim / safeVol) * 100))
  };

  return {
    previewGroup,
    layerZs,
    layerGroups,
    totalLayers,
    filamentLengthM: Math.max(0.05, filamentLengthM),
    weightGrams: Math.max(0.2, weightGrams),
    timeSeconds: Math.max(30, timeSeconds),
    pctByType,
    patternLabel: PATTERN_LABELS[cfg.infillPattern] || cfg.infillPattern,
    hasSupportGenerated: supportSpans.length > 0,
    overhangPointsCount: supportSpans.length, // 計算懸空點數量
    settings: cfg
  };
}

// ============================================================================
// Bambu Studio 風格「有機樹狀支撐 (Organic Tree Support)」拓樸建構與曲線分枝引擎
// ============================================================================
function buildOrganicTreeStructures(supportSpans, modelBox, cfg) {
  if (!supportSpans || supportSpans.length === 0) return [];

  // 將頂部支撐點依照區塊 (約 13x11 mm) 聚類為一棵棵有機樹
  const clusterMap = new Map();
  const cellX = 12.0;
  const cellY = 11.0;

  for (const sp of supportSpans) {
    // 區分「直接對熱床懸空」與「對階梯平台懸空」兩類群組
    const overModel = sp.zBottom > 0.6;
    const kx = Math.floor(sp.x / cellX);
    const ky = Math.floor(sp.y / cellY);
    const key = `${overModel ? 'M' : 'B'}_${kx}_${ky}`;

    if (!clusterMap.has(key)) {
      clusterMap.set(key, { overModel, tips: [] });
    }
    clusterMap.get(key).tips.push(sp);
  }

  const trees = [];

  clusterMap.forEach((group) => {
    const tips = group.tips;
    if (tips.length === 0) return;

    // 計算該樹冠頂部所有支撐點的中心與最高/最低點
    let sumX = 0, sumY = 0, maxTopZ = 0, minBotZ = Infinity;
    for (const t of tips) {
      sumX += t.x;
      sumY += t.y;
      if (t.zTop > maxTopZ) maxTopZ = t.zTop;
      if (t.zBottom < minBotZ) minBotZ = t.zBottom;
    }
    const crownX = sumX / tips.length;
    const crownY = sumY / tips.length;

    // 決定主樹幹根部 (Root) 的位置：
    // 1. 若懸空區直接對著熱床 (zBottom === 0)，樹根就種在熱床上並稍微往外偏，形成自然彎曲弧度
    // 2. 若懸空區下方有模型階梯擋住 (overModel === true)，模仿 Bambu Studio：
    //    將樹根種在模型前後側面外圍的 PEI 熱床上 (Z = 0)，再斜向往上伸進懸空區！
    let rootX = crownX;
    let rootY = crownY;
    let rootZ = 0;

    if (group.overModel) {
      if (cfg.supportBuildPlateOnly) {
        // 從模型前後側外圍熱床 (Z = 0) 斜向長出大樹幹繞過第一階方塊（如同您截圖左側那根斜向大樹幹！）
        const distToFront = Math.abs(crownY - modelBox.min.y);
        const distToBack = Math.abs(modelBox.max.y - crownY);
        const sideSign = distToFront <= distToBack ? -1 : 1;
        const outsideY = sideSign < 0 ? modelBox.min.y - 5.5 : modelBox.max.y + 5.5;

        rootX = crownX - 2.0;
        rootY = outsideY;
        rootZ = 0;
      } else {
        // 若取消勾選「僅在列印板生成」，允許樹根直接種在階梯平台上或外圍熱床
        const distToFront = Math.abs(crownY - modelBox.min.y);
        if (distToFront < 10) {
          rootX = crownX - 1.5;
          rootY = modelBox.min.y - 5.0;
          rootZ = 0;
        } else {
          rootX = crownX;
          rootY = crownY;
          rootZ = minBotZ;
        }
      }
    } else {
      // 直接在熱床上方的懸空區：樹根落在 Z = 0，並稍微往外張開 2.5mm 呈現有機樹幹曲線
      rootX = crownX + 2.2;
      rootY = crownY + (crownY >= 0 ? 1.5 : -1.5);
      rootZ = 0;
    }

    // 設定二級分岔高度：
    // Z = rootZ ~ zFork1：單一粗主幹 (Main Trunk)
    // Z = zFork1 ~ zFork2：分裂為 2~3 根中樹枝 (Sub-branches)
    // Z = zFork2 ~ zTop：分裂為頂部密集小樹枝 (Twigs / Tips) 托住屋頂
    const totalH = Math.max(4, maxTopZ - rootZ);
    const zFork1 = rootZ + totalH * 0.48;
    const zFork2 = rootZ + totalH * 0.76;

    // 主幹在 zFork1 的轉折點（若從模型外圍繞入，在此高度剛好跨過階梯邊緣進入懸空區）
    const fork1X = rootX * 0.35 + crownX * 0.65;
    const fork1Y = rootY * 0.25 + crownY * 0.75;

    // 將頂部 Tips 分為最多 2 個次級分枝群 (Sub-branches)
    const subGroups = [[], []];
    for (let i = 0; i < tips.length; i++) {
      const t = tips[i];
      const idx = t.x + t.y >= crownX + crownY ? 0 : 1;
      subGroups[idx].push(t);
    }
    const activeSubs = subGroups.filter((g) => g.length > 0).map((subTips) => {
      let sx = 0, sy = 0;
      for (const st of subTips) {
        sx += st.x;
        sy += st.y;
      }
      sx /= subTips.length;
      sy /= subTips.length;
      return {
        fork2X: fork1X * 0.3 + sx * 0.7,
        fork2Y: fork1Y * 0.3 + sy * 0.7,
        tips: subTips
      };
    });

    trees.push({
      rootX,
      rootY,
      rootZ,
      fork1X,
      fork1Y,
      zFork1,
      zFork2,
      maxTopZ,
      trunkBaseRadius: Math.min(5.2, 2.8 + Math.sqrt(tips.length) * 0.55),
      trunkMidRadius: Math.min(3.8, 2.0 + Math.sqrt(tips.length) * 0.35),
      subBranches: activeSubs
    });
  });

  return trees;
}

// 在特定層高 Z 切出所有有機樹幹、中樹枝與頂部小細枝的平滑圓環截面
function generateOrganicTreeLayerSegments(trees, z, lIdx, cfg, outerVertsForClip, outSupportSegs) {
  for (let t = 0; t < trees.length; t++) {
    const tree = trees[t];
    if (z < tree.rootZ + 0.02 || z > tree.maxTopZ - cfg.layerHeight * 0.4) continue;

    // 第一層 (Z = initialLayerHeight) 且樹根在熱床上：繪製 Bambu Studio 標誌性的「樹根同心圓裙邊底盤」
    if (lIdx === 0 && tree.rootZ < 0.2) {
      const baseR = tree.trunkBaseRadius * 1.25;
      for (let ring = 0; ring < 4; ring++) {
        addSmoothCircleRing(
          tree.rootX,
          tree.rootY,
          baseR + ring * (cfg.lineWidth * 1.15),
          20,
          outerVertsForClip,
          outSupportSegs
        );
      }
      continue;
    }

    // 階段 1：底部粗主幹 (rootZ <= z <= zFork1)
    if (z <= tree.zFork1) {
      const u = (z - tree.rootZ) / Math.max(0.5, tree.zFork1 - tree.rootZ);
      const s = smoothStep(u);
      const cx = tree.rootX + (tree.fork1X - tree.rootX) * s;
      const cy = tree.rootY + (tree.fork1Y - tree.rootY) * s;

      // 樹根底部微喇開（Flare），往上平滑收細
      const flare = u < 0.18 ? Math.pow(1 - u / 0.18, 2) * 1.4 : 0;
      const radius = tree.trunkBaseRadius * (1 - u * 0.25) + flare;

      addSmoothCircleRing(cx, cy, radius, 18, outerVertsForClip, outSupportSegs);
      // 粗樹幹雙層壁厚，讓樹幹在視覺上更紮實飽滿
      if (radius > 2.2) {
        addSmoothCircleRing(cx, cy, radius - cfg.lineWidth * 0.9, 16, outerVertsForClip, outSupportSegs);
      }
    }
    // 階段 2：主幹分岔為次級中樹枝 (zFork1 < z <= zFork2)
    else if (z <= tree.zFork2) {
      const u = (z - tree.zFork1) / Math.max(0.5, tree.zFork2 - tree.zFork1);
      const s = smoothStep(u);

      for (const sub of tree.subBranches) {
        const cx = tree.fork1X + (sub.fork2X - tree.fork1X) * s;
        const cy = tree.fork1Y + (sub.fork2Y - tree.fork1Y) * s;
        const radius = tree.trunkMidRadius * (1 - u * 0.32);

        addSmoothCircleRing(cx, cy, radius, 16, outerVertsForClip, outSupportSegs);
      }
    }
    // 階段 3：中樹枝散開為多根細樹枝 (zFork2 < z < zTop) 精準頂住懸空屋簷底面
    else {
      for (const sub of tree.subBranches) {
        for (const tip of sub.tips) {
          if (z >= tip.zTop - cfg.layerHeight * 0.45) continue;
          const u = (z - tree.zFork2) / Math.max(0.5, tip.zTop - tree.zFork2);
          const s = smoothStep(Math.min(1, Math.max(0, u)));

          const cx = sub.fork2X + (tip.x - sub.fork2X) * s;
          const cy = sub.fork2Y + (tip.y - sub.fork2Y) * s;
          // 由中樹枝半徑漸細至頂部接觸端 1.05mm
          const startR = tree.trunkMidRadius * 0.68;
          const endR = 1.1;
          const radius = startR + (endR - startR) * u;

          addSmoothCircleRing(cx, cy, radius, 12, outerVertsForClip, outSupportSegs);
        }
      }
    }
  }
}

// 繪製平滑圓形樹幹截面，並自動裁切掉與模型本體重疊的線段（確保樹幹貼著模型外圍長而不會刺穿模型）
function addSmoothCircleRing(cx, cy, radius, sides, outerVertsForClip, outSupportSegs) {
  const hasModel = outerVertsForClip && outerVertsForClip.length > 0;
  for (let k = 0; k < sides; k++) {
    const a1 = (k * 2 * Math.PI) / sides;
    const a2 = ((k + 1) * 2 * Math.PI) / sides;
    const x1 = cx + radius * Math.cos(a1);
    const y1 = cy + radius * Math.sin(a1);
    const x2 = cx + radius * Math.cos(a2);
    const y2 = cy + radius * Math.sin(a2);
    const mx = (x1 + x2) * 0.5;
    const my = (y1 + y2) * 0.5;

    if (hasModel && isPointInPolygon(outerVertsForClip, mx, my)) {
      continue;
    }
    outSupportSegs.push({ x1, y1, x2, y2 });
  }
}

// 三次平滑曲線插值 (Cubic Hermite Smoothstep)，讓樹幹彎曲與分岔處呈現自然有機的 S 型弧線
function smoothStep(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

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
    dummy.scale.set(seg.len + width * 0.25, width, height);
    dummy.updateMatrix();
    instMesh.setMatrixAt(i, dummy.matrix);
  }

  instMesh.instanceMatrix.needsUpdate = true;
  group.add(instMesh);
}

function isNearHorizontalSurface(nonVerticalTris, px, py, z, topThick, bottomThick) {
  for (let i = 0; i < nonVerticalTris.length; i++) {
    const t = nonVerticalTris[i];
    if (t.absNz < 0.35) continue;
    if (px < t.minX || px > t.maxX || py < t.minY || py > t.maxY) continue;

    if (t.zMax >= z - bottomThick && t.zMin <= z + topThick) {
      if (pointInTri2D(px, py, t.a, t.b, t.c)) {
        const zHit = interpolateZOnTri(px, py, t.a, t.b, t.c);
        if ((zHit >= z - 0.05 && zHit <= z + topThick) || (zHit <= z + 0.05 && zHit >= z - bottomThick)) {
          return true;
        }
      }
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
