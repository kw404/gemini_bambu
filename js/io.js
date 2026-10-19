import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { BED_SIZE } from './scene.js';

export async function parseImportedFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'stl') {
    const buffer = await file.arrayBuffer();
    const loader = new STLLoader();
    const geometry = loader.parse(buffer);
    return { geometry, name: file.name };
  } else if (ext === '3mf') {
    const geometry = await parseMakerWorld3MF(file);
    return { geometry, name: file.name };
  } else {
    throw new Error('不支援的檔案格式，請選擇 .3mf 或 .stl 檔案');
  }
}

async function parseMakerWorld3MF(file) {
  const zip = await window.JSZip.loadAsync(file);
  const modelFiles = [];

  zip.forEach((relativePath, zipEntry) => {
    if (relativePath.toLowerCase().endsWith('.model')) {
      modelFiles.push(zipEntry);
    }
  });

  if (modelFiles.length === 0) {
    throw new Error('在此 .3mf 檔案中找不到 3D 網格資料');
  }

  const allPositions = [];
  const parser = new DOMParser();

  for (const entry of modelFiles) {
    const xmlText = await entry.async('string');
    const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
    const meshes = xmlDoc.getElementsByTagName('mesh');

    for (let m = 0; m < meshes.length; m++) {
      const meshEl = meshes[m];
      const vertexEls = meshEl.getElementsByTagName('vertex');
      const triangleEls = meshEl.getElementsByTagName('triangle');

      const verts = new Float32Array(vertexEls.length * 3);
      for (let i = 0; i < vertexEls.length; i++) {
        const v = vertexEls[i];
        verts[i * 3] = parseFloat(v.getAttribute('x')) || 0;
        verts[i * 3 + 1] = parseFloat(v.getAttribute('y')) || 0;
        verts[i * 3 + 2] = parseFloat(v.getAttribute('z')) || 0;
      }

      for (let i = 0; i < triangleEls.length; i++) {
        const t = triangleEls[i];
        const v1 = parseInt(t.getAttribute('v1'), 10) * 3;
        const v2 = parseInt(t.getAttribute('v2'), 10) * 3;
        const v3 = parseInt(t.getAttribute('v3'), 10) * 3;

        allPositions.push(
          verts[v1], verts[v1 + 1], verts[v1 + 2],
          verts[v2], verts[v2 + 1], verts[v2 + 2],
          verts[v3], verts[v3 + 1], verts[v3 + 2]
        );
      }
    }
  }

  if (allPositions.length === 0) {
    throw new Error('3MF 檔案內不含可解析的三角網格頂點');
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(allPositions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// 匯出完全符合 3MF 水密網格標準（頂點焊接共用索引）且不會觸發 Bambu Studio "invalid config" 警告的 .3mf 檔案
export async function exportTo3MF(modelMesh, modelName, settings) {
  modelMesh.updateMatrixWorld(true);

  const geom = modelMesh.geometry;
  const nonIndexed = geom.index ? geom.toNonIndexed() : geom;
  const posAttr = nonIndexed.attributes.position;
  const matrix = modelMesh.matrixWorld;

  const bedOffsetX = BED_SIZE.x / 2;
  const bedOffsetY = BED_SIZE.y / 2;

  // 關鍵修正 1：對所有頂點進行焊接合併（Vertex Welding），讓相鄰三角形真正共用頂點索引！
  // 若不合併頂點，Bambu Studio 會認為模型是由數百片不相連的破面組成，進而報空層錯誤。
  const vertexMap = new Map();
  const uniqueVertices = [];
  const weldedTriangles = [];
  const v = new THREE.Vector3();

  function getWeldedVertexIndex(x, y, z) {
    const kx = x.toFixed(4);
    const ky = y.toFixed(4);
    const kz = z.toFixed(4);
    const key = `${kx},${ky},${kz}`;
    if (vertexMap.has(key)) {
      return vertexMap.get(key);
    }
    const idx = uniqueVertices.length;
    uniqueVertices.push({ x: kx, y: ky, z: kz });
    vertexMap.set(key, idx);
    return idx;
  }

  const triCount = Math.floor(posAttr.count / 3);
  for (let i = 0; i < triCount; i++) {
    v.fromBufferAttribute(posAttr, i * 3).applyMatrix4(matrix);
    const idx1 = getWeldedVertexIndex(v.x + bedOffsetX, v.y + bedOffsetY, Math.max(0, v.z));

    v.fromBufferAttribute(posAttr, i * 3 + 1).applyMatrix4(matrix);
    const idx2 = getWeldedVertexIndex(v.x + bedOffsetX, v.y + bedOffsetY, Math.max(0, v.z));

    v.fromBufferAttribute(posAttr, i * 3 + 2).applyMatrix4(matrix);
    const idx3 = getWeldedVertexIndex(v.x + bedOffsetX, v.y + bedOffsetY, Math.max(0, v.z));

    // 過濾退化為一條線的無效三角形
    if (idx1 !== idx2 && idx2 !== idx3 && idx1 !== idx3) {
      weldedTriangles.push({ v1: idx1, v2: idx2, v3: idx3 });
    }
  }

  const verticesXML = uniqueVertices.map(
    (pt) => `          <vertex x="${pt.x}" y="${pt.y}" z="${pt.z}" />`
  );
  const trianglesXML = weldedTriangles.map(
    (t) => `          <triangle v1="${t.v1}" v2="${t.v2}" v3="${t.v3}" />`
  );

  // 關鍵修正 2：使用純淨標準的 3MF Core 規範（不混入無效的 Bambu 私有命名空間宣告），
  // 這樣 Bambu Studio 開啟時會直接乾淨載入模型，不再彈出 "The 3mf file has invalid config" 錯誤視窗！
  // 同時將學生的切片參數寫入標準 <metadata> 標籤供老師檢核。
  const modelXML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-TW" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">${modelName}</metadata>
  <metadata name="Designer">Bambu A2L Teaching Slicer</metadata>
  <metadata name="Printer">Bambu Lab A2L</metadata>
  <metadata name="BedType">Textured PEI Plate</metadata>
  <metadata name="Filament">Generic PLA</metadata>
  <metadata name="LayerHeight">${settings.layerHeight}</metadata>
  <metadata name="WallLoops">${settings.wallLoops}</metadata>
  <metadata name="InfillDensity">${settings.infillDensity}%</metadata>
  <metadata name="InfillPattern">${settings.infillPattern}</metadata>
  <metadata name="SupportEnabled">${settings.supportEnable}</metadata>
  <metadata name="SupportType">${settings.supportType}</metadata>
  <metadata name="BrimType">${settings.brimType}</metadata>
  <resources>
    <object id="1" name="${modelName}" type="model">
      <mesh>
        <vertices>
${verticesXML.join('\n')}
        </vertices>
        <triangles>
${trianglesXML.join('\n')}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>`;

  const contentTypesXML = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

  const relsXML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', contentTypesXML);
  zip.folder('_rels').file('.rels', relsXML);
  zip.folder('3D').file('3dmodel.model', modelXML);

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${modelName}_BBL_A2L.3mf`;
  a.click();
  URL.revokeObjectURL(url);
}
