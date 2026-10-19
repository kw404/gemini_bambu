import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { BED_SIZE } from './scene.js';

// 解析使用者上傳的 .stl 或 MakerWorld .3mf 檔案
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

// 匯出包含模型變換後座標與學生設定參數的 .3mf 壓縮檔
export async function exportTo3MF(modelMesh, modelName, settings) {
  modelMesh.updateMatrixWorld(true);

  const geom = modelMesh.geometry;
  const nonIndexed = geom.index ? geom.toNonIndexed() : geom;
  const posAttr = nonIndexed.attributes.position;
  const matrix = modelMesh.matrixWorld;

  const verticesXML = [];
  const trianglesXML = [];
  const v = new THREE.Vector3();
  const bedOffsetX = BED_SIZE.x / 2;
  const bedOffsetY = BED_SIZE.y / 2;

  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
    const vx = (v.x + bedOffsetX).toFixed(4);
    const vy = (v.y + bedOffsetY).toFixed(4);
    const vz = Math.max(0, v.z).toFixed(4);
    verticesXML.push(`          <vertex x="${vx}" y="${vy}" z="${vz}" />`);
  }

  const triCount = Math.floor(posAttr.count / 3);
  for (let i = 0; i < triCount; i++) {
    const i0 = i * 3;
    trianglesXML.push(`          <triangle v1="${i0}" v2="${i0 + 1}" v3="${i0 + 2}" />`);
  }

  const modelXML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-TW" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
  <metadata name="Application">BambuStudio-Teaching-Web-A2L</metadata>
  <metadata name="PrinterModel">Bambu Lab A2L</metadata>
  <metadata name="BedType">Textured PEI Plate</metadata>
  <metadata name="Filament">Generic PLA</metadata>
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
  <Default Extension="json" ContentType="application/json" />
</Types>`;

  const relsXML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', contentTypesXML);
  zip.folder('_rels').file('.rels', relsXML);
  zip.folder('3D').file('3dmodel.model', modelXML);
  zip.folder('Metadata').file('student_print_settings.json', JSON.stringify(settings, null, 2));

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${modelName}_BBL_A2L.3mf`;
  a.click();
  URL.revokeObjectURL(url);
}
