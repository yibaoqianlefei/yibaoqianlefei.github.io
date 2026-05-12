// viewer/viewer.js — shared 3D viewer engine
// Reads window.MODULE_CONFIG for module-specific data

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ═══════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════
const PITCH_DEG = MODULE_CONFIG.demo.pitchDeg;
const PITCH = PITCH_DEG * Math.PI / 180;
const HALF_WIDTH = MODULE_CONFIG.demo.halfWidth;
const ROOF_DEPTH = MODULE_CONFIG.demo.roofDepth;
const WALL_HEIGHT = MODULE_CONFIG.demo.wallHeight;
const RIDGE_HEIGHT = WALL_HEIGHT + HALF_WIDTH * Math.tan(PITCH);
const BUILDING_W = HALF_WIDTH * 2;
const BUILDING_D = ROOF_DEPTH;
const WALL_THICK = 0.25;
const EXPLODE_GAP = 0.55;

// Layer definitions (bottom → top)
const defaultLayerDefs = MODULE_CONFIG.layerDefs;

// Load from localStorage or use defaults
let layerDefs = loadLayerConfig() || defaultLayerDefs.map(d => ({...d}));

// Keywords for auto-matching mesh names → layer index (case-insensitive)
const MATCH_PATTERNS = MODULE_CONFIG.matchPatterns;

// ═══════════════════════════════════════════
// LOCAL STORAGE PERSISTENCE
// ═══════════════════════════════════════════
function loadLayerConfig() {
  try {
    const raw = localStorage.getItem('roofLayerConfig');
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return null;
}
function saveLayerConfig(defs) {
  try {
    localStorage.setItem('roofLayerConfig', JSON.stringify(defs.map(d => ({
      name: d.name, eng: d.eng, color: d.color, thick: d.thick,
      roughness: d.roughness, desc: d.desc
    }))));
  } catch (e) { /* ignore */ }
}

// ═══════════════════════════════════════════
// SCENE SETUP
// ═══════════════════════════════════════════
const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e8e5df');
scene.fog = new THREE.Fog('#e8e5df', 15, 40);

const camera = new THREE.PerspectiveCamera(48, 2, 0.5, 60);
camera.position.set(9, 5.5, 9);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
viewport.appendChild(renderer.domElement);

// Lights
const ambient = new THREE.AmbientLight('#faf5eb', 3.5);
scene.add(ambient);
const sun = new THREE.DirectionalLight('#ffffff', 5.5);
sun.position.set(10, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 50;
sun.shadow.camera.left = -15; sun.shadow.camera.right = 15;
sun.shadow.camera.top = 15; sun.shadow.camera.bottom = -5;
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.02;
scene.add(sun);
const fill = new THREE.DirectionalLight('#d5e0f0', 1.8);
fill.position.set(-3, 2, -2);
scene.add(fill);

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2.8, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI * 0.78; controls.minPolarAngle = 0.1;
controls.autoRotateSpeed = 1.2;
controls.zoomSpeed = 0.75;          // smoother zoom
controls.screenSpacePanning = true; // natural panning
controls.update();

// Dynamic camera limits based on model bounds
function recalculateCameraLimits() {
  // Gather all visible geometry for bounds calculation
  const box = new THREE.Box3();
  const targets = usingCustomModel ? allCustomMeshes : allMeshes;
  targets.forEach(m => { if (m.geometry) box.expandByObject(m); });
  // Also include building for demo
  if (!usingCustomModel) buildingGroup.children.forEach(c => {
    if (c.isMesh) box.expandByObject(c);
  });

  if (box.isEmpty()) return;

  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const r = Math.max(size.x, size.y, size.z) * 0.65; // bounding sphere approx

  // Dynamic limits
  controls.minDistance = Math.max(0.5, r * 0.35);
  controls.maxDistance = Math.min(50, r * 6.5);
  controls.target.copy(center);

  // Default camera position if not currently resetting/focusing
  const optimalDist = r * 2.8;
  defaultCamPos.set(center.x + optimalDist * 0.65, center.y + optimalDist * 0.5, center.z + optimalDist * 0.65);
  defaultTarget.copy(center);

  // Update camera if it's out of new bounds
  const dist = camera.position.distanceTo(controls.target);
  if (dist > controls.maxDistance || dist < controls.minDistance) {
    const clampedDist = THREE.MathUtils.clamp(dist, controls.minDistance, controls.maxDistance);
    const dir = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, clampedDist);
  }
  controls.update();
}

// ═══════════════════════════════════════════
// GROUND
// ═══════════════════════════════════════════
const groundGeo = new THREE.PlaneGeometry(40, 40);
const groundMat = new THREE.MeshStandardMaterial({ color: '#e0dcd4', roughness: 0.9 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(22, 22, '#c8c3b8', '#d8d4ca');
grid.position.y = 0.005;
scene.add(grid);

// ═══════════════════════════════════════════
// BUILDING WALLS (demo only)
// ═══════════════════════════════════════════
const buildingGroup = new THREE.Group();
buildingGroup.name = 'building';
buildingGroup.visible = false;
scene.add(buildingGroup);

const wallMat = new THREE.MeshStandardMaterial({ color: '#f5efe4', roughness: 0.7 });
function makeWall(w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  buildingGroup.add(m); return m;
}
const hw = BUILDING_W / 2, hd = BUILDING_D / 2;
makeWall(BUILDING_W, WALL_HEIGHT, WALL_THICK, 0, WALL_HEIGHT/2, hd);
makeWall(BUILDING_W, WALL_HEIGHT, WALL_THICK, 0, WALL_HEIGHT/2, -hd);
makeWall(WALL_THICK, WALL_HEIGHT, BUILDING_D, hw, WALL_HEIGHT/2, 0);
makeWall(WALL_THICK, WALL_HEIGHT, BUILDING_D, -hw, WALL_HEIGHT/2, 0);
function createGable(z) {
  const shape = new THREE.Shape();
  const gh = RIDGE_HEIGHT - WALL_HEIGHT;
  shape.moveTo(-hw, 0); shape.lineTo(0, gh); shape.lineTo(hw, 0); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: WALL_THICK, bevelEnabled: false });
  const mesh = new THREE.Mesh(geo, wallMat);
  mesh.position.set(0, WALL_HEIGHT, z - WALL_THICK/2);
  mesh.castShadow = true; mesh.receiveShadow = true;
  buildingGroup.add(mesh);
}
createGable(hd); createGable(-hd);

// ═══════════════════════════════════════════
// DEMO ROOF LAYERS (procedural)
// ═══════════════════════════════════════════
const demoGroup = new THREE.Group();
demoGroup.name = 'demoRoof';
demoGroup.visible = false;
scene.add(demoGroup);

const layers = [];       // { def, leftMesh, rightMesh, leftMat, rightMat, baseOffset }
const allMeshes = [];    // flat array for raycasting (rebuild on model switch)
const slopedLen = HALF_WIDTH / Math.cos(PITCH);
const baseCtrY = (RIDGE_HEIGHT + WALL_HEIGHT) / 2;
const baseCtrLX = -HALF_WIDTH / 2;
const baseCtrRX = HALF_WIDTH / 2;
const normalL = new THREE.Vector3(-Math.sin(PITCH), Math.cos(PITCH), 0);
const normalR = new THREE.Vector3(Math.sin(PITCH), Math.cos(PITCH), 0);

let cumThick = 0;
layerDefs.forEach((def, i) => {
  const baseOff = cumThick + def.thick / 2;
  cumThick += def.thick;
  const geoBox = new THREE.BoxGeometry(slopedLen, def.thick, ROOF_DEPTH);

  const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: def.roughness, metalness: 0.02 });
  const leftMesh = new THREE.Mesh(geoBox, mat);
  leftMesh.rotation.z = PITCH;
  leftMesh.castShadow = true; leftMesh.receiveShadow = true;
  leftMesh.userData = { layerIndex: i, side: 'left' };
  demoGroup.add(leftMesh);

  const matR = new THREE.MeshStandardMaterial({ color: def.color, roughness: def.roughness, metalness: 0.02 });
  const rightMesh = new THREE.Mesh(geoBox.clone(), matR);
  rightMesh.rotation.z = -PITCH;
  rightMesh.castShadow = true; rightMesh.receiveShadow = true;
  rightMesh.userData = { layerIndex: i, side: 'right' };
  demoGroup.add(rightMesh);

  layers.push({ def, leftMesh, rightMesh, leftMat: mat, rightMat: matR, baseOffset: baseOff });
  allMeshes.push(leftMesh, rightMesh);
});

// ═══════════════════════════════════════════
// CUSTOM MODEL STATE
// ═══════════════════════════════════════════
const gltfLoader = new GLTFLoader();
const customGroup = new THREE.Group();
customGroup.name = 'customModel';
customGroup.visible = false;
scene.add(customGroup);

// Outline group for focus highlighting
const outlineGroup = new THREE.Group();
outlineGroup.name = 'outlines';
scene.add(outlineGroup);

let customLayers = null;        // array of { layerIndex, meshes: [], originalPositions: Map, centroid: Vector3 }
let customMeshIndex = null;     // Map: mesh → layerIndex
let allCustomMeshes = [];       // flat for raycaster
let usingCustomModel = false;
let customModelScale = 1;
let customModelCenter = new THREE.Vector3();
let customModelSize = 1;

// Mesh→layer mapping (editable in modal)
let meshAssignments = {};       // meshName → layerIndex (or -1 for unassigned)
let allMeshNames = [];          // all mesh names found in loaded model
let loadedGltfScene = null;     // stored GLTF scene for building custom layers

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
let explodeFactor = 0;
let targetExplode = 0;
let selectedIdx = -1;
let hoveredIdx = -1;
let autoRotate = false;
const defaultCamPos = new THREE.Vector3(9, 5.5, 9);
const defaultTarget = new THREE.Vector3(0, 2.8, 0);
let resetting = false;
let resetT = 0;
const resetFromPos = new THREE.Vector3();
const resetFromTarget = new THREE.Vector3();

// Push state — per-layer so transitions between layers are smooth
const pushStates = new Map();  // idx → { dir, dist, origPositions: Map<mesh,Vector3>, progress: 0, target: 0 }
let activePushIdx = -1;        // which layer is currently highlighted/outlined
const pushRaycaster = new THREE.Raycaster();

// ═══════════════════════════════════════════
// LAYER POSITIONING
// ═══════════════════════════════════════════
function updateDemoLayerPositions() {
  layers.forEach((layer, i) => {
    const normalOff = layer.baseOffset + i * EXPLODE_GAP * explodeFactor;
    layer.leftMesh.position.set(
      baseCtrLX + normalOff * normalL.x,
      baseCtrY + normalOff * normalL.y, 0
    );
    layer.rightMesh.position.set(
      baseCtrRX + normalOff * normalR.x,
      baseCtrY + normalOff * normalR.y, 0
    );
  });
}

function updateCustomLayerPositions() {
  if (!customLayers) return;
  customLayers.forEach(cl => {
    if (cl.meshes.length === 0) return;
    const dir = cl.centroid.clone().sub(customModelCenter).normalize();
    // fallback: if centroid == center, explode vertically
    if (dir.length() < 0.001) dir.set(0, 1, 0);
    const offset = dir.multiplyScalar(cl.layerIndex * EXPLODE_GAP * 1.2 * explodeFactor);
    cl.meshes.forEach(mesh => {
      const orig = cl.originalPositions.get(mesh);
      if (orig) mesh.position.copy(orig).add(offset);
    });
  });
}

function updateAllPositions() {
  if (usingCustomModel) {
    updateCustomLayerPositions();
  } else {
    updateDemoLayerPositions();
  }
}

// ═══════════════════════════════════════════
// EMISSIVE MANAGEMENT
// ═══════════════════════════════════════════
function getLayerMaterials(idx) {
  if (usingCustomModel && customLayers && customLayers[idx]) {
    return customLayers[idx].meshes.map(m => Array.isArray(m.material) ? m.material[0] : m.material);
  }
  if (!usingCustomModel && layers[idx]) {
    return [layers[idx].leftMat, layers[idx].rightMat];
  }
  return [];
}

function resetEmissives() {
  const allLayerData = usingCustomModel ? customLayers : layers;
  if (!allLayerData) return;

  if (usingCustomModel) {
    customLayers.forEach((cl, i) => {
      const isSel = i === selectedIdx;
      const isHov = i === hoveredIdx && !isSel;
      const eVal = isSel ? 0.45 : isHov ? 0.22 : 0;
      cl.meshes.forEach(mesh => {
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (mat && mat.emissive) {
          mat.emissive.set(isSel ? '#b55a10' : '#000000');
          mat.emissiveIntensity = eVal;
        }
      });
    });
  } else {
    layers.forEach((layer, i) => {
      const isSel = i === selectedIdx;
      const isHov = i === hoveredIdx && !isSel;
      const e = isSel ? 0.45 : isHov ? 0.22 : 0;
      layer.leftMat.emissive.set(isSel ? '#b55a10' : '#000000');
      layer.leftMat.emissiveIntensity = e;
      layer.rightMat.emissive.set(isSel ? '#b55a10' : '#000000');
      layer.rightMat.emissiveIntensity = e;
    });
  }
}

// ═══════════════════════════════════════════
// SMART PUSH SYSTEM
// ═══════════════════════════════════════════

function getLayerMeshes(idx) {
  if (usingCustomModel && customLayers && customLayers[idx]) {
    return customLayers[idx].meshes;
  }
  if (!usingCustomModel && layers[idx]) {
    return [layers[idx].leftMesh, layers[idx].rightMesh];
  }
  return [];
}

function getLayerCentroid(idx) {
  const meshes = getLayerMeshes(idx);
  if (meshes.length === 0) return null;
  const box = new THREE.Box3();
  meshes.forEach(m => box.expandByObject(m));
  const c = new THREE.Vector3();
  box.getCenter(c);
  return c;
}

function getLayerSize(idx) {
  const meshes = getLayerMeshes(idx);
  if (meshes.length === 0) return new THREE.Vector3(1, 1, 1);
  const box = new THREE.Box3();
  meshes.forEach(m => box.expandByObject(m));
  const s = new THREE.Vector3();
  box.getSize(s);
  return s;
}

function getAllLayerMaterials() {
  const mats = [];
  if (usingCustomModel && customLayers) {
    customLayers.forEach(cl => {
      cl.meshes.forEach(m => {
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        if (mat) mats.push({ mat, layerIdx: cl.layerIndex, mesh: m });
      });
    });
  } else {
    layers.forEach((layer, i) => {
      mats.push({ mat: layer.leftMat, layerIdx: i, mesh: layer.leftMesh });
      mats.push({ mat: layer.rightMat, layerIdx: i, mesh: layer.rightMesh });
    });
  }
  return mats;
}

function clearOutlines() {
  while (outlineGroup.children.length > 0) {
    const child = outlineGroup.children[0];
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
    outlineGroup.remove(child);
  }
}

/** Return fixed forward horizontal push direction */
function findBestPushDirection(idx) {
  const size = getLayerSize(idx);
  const sizeLen = size.length();
  const pushDist = THREE.MathUtils.clamp(sizeLen * 0.2, sizeLen * 0.12, sizeLen * 0.35);

  // Demo roof: left-slope → -X, right-slope → +X
  if (!usingCustomModel && layers[idx]) {
    const centroid = getLayerCentroid(idx);
    if (centroid && centroid.x < 0) {
      return { dir: new THREE.Vector3(-1, 0, 0), dist: pushDist };
    }
    if (centroid && centroid.x > 0) {
      return { dir: new THREE.Vector3(1, 0, 0), dist: pushDist };
    }
  }
  // Custom model / fallback: push forward (+Z)
  return { dir: new THREE.Vector3(0, 0, 1), dist: pushDist };
}

/** Sample points on the layer's bounding surface */
function samplePointsOnLayer(idx) {
  const meshes = getLayerMeshes(idx);
  const points = [];
  meshes.forEach(m => {
    if (!m.geometry) return;
    const box = new THREE.Box3().setFromObject(m);
    const c = new THREE.Vector3(); box.getCenter(c);
    const s = new THREE.Vector3(); box.getSize(s);
    // 9 sample points: center + face centers + corners
    points.push(c.clone());
    points.push(c.clone().add(new THREE.Vector3(s.x / 2, 0, 0)));
    points.push(c.clone().add(new THREE.Vector3(-s.x / 2, 0, 0)));
    points.push(c.clone().add(new THREE.Vector3(0, s.y / 2, 0)));
    points.push(c.clone().add(new THREE.Vector3(0, -s.y / 2, 0)));
    points.push(c.clone().add(new THREE.Vector3(0, 0, s.z / 2)));
    points.push(c.clone().add(new THREE.Vector3(0, 0, -s.z / 2)));
  });
  if (points.length === 0) points.push(new THREE.Vector3());
  return points;
}

function ensurePushInfo(idx) {
  if (pushStates.has(idx)) return pushStates.get(idx);

  // Capture true base positions (temporarily collapse explode)
  const savedExplode = explodeFactor;
  explodeFactor = 0;
  updateAllPositions();
  // Also snap back any push progress for this layer
  const oldInfo = pushStates.get(idx);
  if (oldInfo) {
    const oldMeshes = getLayerMeshes(idx);
    oldMeshes.forEach(m => {
      const orig = oldInfo.origPositions.get(m);
      if (orig) m.position.copy(orig);
    });
  }

  const { dir, dist } = findBestPushDirection(idx);
  const meshes = getLayerMeshes(idx);
  const origPositions = new Map();
  meshes.forEach(m => origPositions.set(m, m.position.clone()));

  // Restore explode
  explodeFactor = savedExplode;
  updateAllPositions();

  const info = { dir: dir.clone(), dist, origPositions, progress: 0, target: 0 };
  pushStates.set(idx, info);
  return info;
}

function pushLayer(idx) {
  // Set old active layer to unpush
  if (activePushIdx >= 0 && activePushIdx !== idx) {
    const oldInfo = pushStates.get(activePushIdx);
    if (oldInfo) oldInfo.target = 0;
  }
  activePushIdx = idx;

  // Opacity fade
  const allMats = getAllLayerMaterials();
  allMats.forEach(({ mat, layerIdx }) => {
    mat.transparent = true;
    mat.opacity = layerIdx === idx ? 1.0 : 0.15;
    mat.needsUpdate = true;
  });
  buildingGroup.traverse(child => {
    if (child.isMesh && child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach(m => { m.transparent = true; m.opacity = 0.12; m.needsUpdate = true; });
    }
  });

  // Edge outlines
  clearOutlines();
  const meshes = getLayerMeshes(idx);
  meshes.forEach(m => {
    if (!m.geometry) return;
    const edgeGeo = new THREE.EdgesGeometry(m.geometry, 30);
    const edgeLine = new THREE.LineSegments(edgeGeo,
      new THREE.LineBasicMaterial({ color: '#ff6600', linewidth: 1, transparent: true,
        opacity: 0.9, depthTest: true }));
    edgeLine.position.copy(m.position);
    edgeLine.rotation.copy(m.rotation);
    edgeLine.scale.copy(m.scale).multiplyScalar(1.01);
    outlineGroup.add(edgeLine);
  });

  // Compute push info & set target
  const info = ensurePushInfo(idx);
  info.target = 1;
}

function unpushLayer() {
  // Set all active layers to unpush
  pushStates.forEach(info => { info.target = 0; });
  activePushIdx = -1;

  clearOutlines();

  const allMats = getAllLayerMaterials();
  allMats.forEach(({ mat }) => {
    mat.transparent = false; mat.opacity = 1; mat.needsUpdate = true;
  });
  buildingGroup.traverse(child => {
    if (child.isMesh && child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach(m => { m.transparent = false; m.opacity = 1; m.needsUpdate = true; });
    }
  });

}

// ═══════════════════════════════════════════
// RAYCASTER
// ═══════════════════════════════════════════
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function getIntersections(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const targets = usingCustomModel ? allCustomMeshes : allMeshes;
  return raycaster.intersectObjects(targets, false);
}

function getLayerFromIntersect(intersects) {
  if (intersects.length === 0) return -1;
  const obj = intersects[0].object;
  if (usingCustomModel && customMeshIndex) {
    return customMeshIndex.get(obj) ?? -1;
  }
  return obj.userData.layerIndex ?? -1;
}

// ═══════════════════════════════════════════
// SIDEBAR UI
// ═══════════════════════════════════════════
const legendEl = document.getElementById('legend');
const detailPanel = document.getElementById('detailPanel');

function buildLegend() {
  document.getElementById('legendSubtitle').textContent =
    `由上至下 · 共 ${layerDefs.length} 层构造`;
  const items = [...layerDefs].reverse();
  legendEl.innerHTML = items.map((def, ri) => {
    const i = layerDefs.length - 1 - ri;
    const unmatchedClass = usingCustomModel && customLayers && customLayers[i] && customLayers[i].meshes.length === 0 ? ' unmatched' : '';
    return `<div class="legend-item${unmatchedClass}" data-idx="${i}">
        <span class="legend-swatch" style="background:${def.color}"></span>
        <span class="legend-info">
          <span class="legend-name">${def.name}</span>
          <span class="legend-eng">${def.eng}</span>
        </span>
        <span class="legend-num">${ri + 1}</span>
      </div>`;
  }).join('');

  legendEl.querySelectorAll('.legend-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      selectLayer(selectedIdx === idx ? -1 : idx);
    });
  });
}

function selectLayer(idx) {
  selectedIdx = idx;
  resetEmissives();
  updateLegendHighlight();
  updateDetailPanel();

  // Push logic
  if (idx >= 0) {
    pushLayer(idx);
    if (explodeFactor < 0.3) {
      targetExplode = 0.55;
      document.getElementById('btnExplode').classList.add('active');
    }
  } else {
    unpushLayer();
  }
}

function updateLegendHighlight() {
  legendEl.querySelectorAll('.legend-item').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.idx) === selectedIdx);
  });
}

function updateDetailPanel() {
  if (selectedIdx < 0) {
    detailPanel.innerHTML = `
      <div class="detail-empty">
        <div class="icon">👆</div>
        <p>点击模型上的层次<br>或左侧图例查看详细信息</p>
        <p style="margin-top:8px;font-size:0.78rem;">💥 点击「爆炸图」展开屋顶层次</p>
      </div>`;
    return;
  }
  const def = layerDefs[selectedIdx];
  const meshCount = usingCustomModel && customLayers && customLayers[selectedIdx]
    ? customLayers[selectedIdx].meshes.length : '-';
  detailPanel.innerHTML = `
    <div class="detail-content">
      <h3>${def.name}</h3>
      <p class="eng-name">${def.eng}</p>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
        <span class="legend-swatch" style="background:${def.color};width:36px;height:36px;"></span>
        <span style="font-size:0.78rem;color:var(--text-secondary);">第 ${layerDefs.length - selectedIdx} 层（从上往下）</span>
      </div>
      <p class="desc">${def.desc}</p>
      <div class="meta">
        <span>📏 厚度 ≈ ${(def.thick * 100).toFixed(0)}mm（示意）</span>
        <span>🔢 编号 #${selectedIdx + 1}</span>
        ${usingCustomModel ? `<span>🧩 网格数: ${meshCount}</span>` : ''}
      </div>
    </div>`;
}

buildLegend();
updateDemoLayerPositions();
resetEmissives();
recalculateCameraLimits();

// ═══════════════════════════════════════════
// CUSTOM MODEL LOADING
// ═══════════════════════════════════════════

/** Match a mesh name against patterns, return layer index or -1 */
function autoMatchMeshName(meshName) {
  const lower = meshName.toLowerCase();
  // Pass 1: exact match
  for (const pat of MATCH_PATTERNS) {
    for (const kw of pat.kw) {
      if (lower === kw.toLowerCase()) return pat.idx;
    }
  }
  // Pass 2: partial match (for semantic names)
  for (const pat of MATCH_PATTERNS) {
    for (const kw of pat.kw) {
      if (lower.includes(kw.toLowerCase())) return pat.idx;
    }
  }
  return -1;
}

/** Collect all mesh names from a GLTF scene recursively */
function collectMeshes(root) {
  const names = [];
  root.traverse(child => {
    if (child.isMesh && child.name) names.push(child.name);
  });
  return names;
}

/** Collect all meshes with their names */
function collectMeshObjects(root) {
  const result = [];
  root.traverse(child => {
    if (child.isMesh) result.push(child);
  });
  return result;
}

/** Process a loaded GLTF scene into custom layers */
function processCustomModel(gltfScene) {
  // Store scene for later building
  loadedGltfScene = gltfScene;

  // Collect meshes
  const allObjs = collectMeshObjects(gltfScene);
  allMeshNames = allObjs.map(m => m.name || '(未命名)');

  // Auto-match
  meshAssignments = {};
  allObjs.forEach(m => {
    const name = m.name || '(未命名)';
    meshAssignments[name] = autoMatchMeshName(name);
  });

  // Show mapping modal
  showMappingModal(allObjs);
}

function buildCustomLayers(scene) {
  // Clear previous
  while (customGroup.children.length > 0) {
    customGroup.remove(customGroup.children[0]);
  }

  // Collect meshes with valid geometry
  const allObjs = collectMeshObjects(scene).filter(m => m.geometry);

  if (allObjs.length === 0) {
    console.error('No meshes with geometry found in the loaded model');
    alert('模型中未找到任何网格几何体。请检查导出的 GLB/GLTF 文件是否包含网格。');
    return;
  }

  // Compute model bounds for scaling & centering
  const box = new THREE.Box3();
  allObjs.forEach(m => box.expandByObject(m));
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  // Scale to fit scene (target max dimension ~10)
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = maxDim > 0 ? 9 / maxDim : 1;
  customModelScale = scale;
  customModelCenter.copy(center).multiplyScalar(scale);
  customModelSize = maxDim * scale;

  // Group meshes by layer
  customLayers = layerDefs.map((def, i) => ({
    layerIndex: i,
    meshes: [],
    originalPositions: new Map(),
    centroid: new THREE.Vector3(),
  }));

  const unassignedGroup = new THREE.Group();
  unassignedGroup.name = 'unassigned';

  allObjs.forEach(m => {
    const name = m.name || '(未命名)';
    const assignIdx = meshAssignments[name] ?? -1;

    // Clone the mesh (keep original in the loaded scene)
    const cloned = m.clone();
    cloned.userData.layerIndex = assignIdx;
    cloned.userData.meshName = name;

    if (assignIdx >= 0 && assignIdx < layerDefs.length) {
      customLayers[assignIdx].meshes.push(cloned);
      // Apply layer color tint
      if (Array.isArray(cloned.material)) {
        cloned.material = cloned.material.map(m => m.clone());
      } else if (cloned.material) {
        cloned.material = cloned.material.clone();
      }
    } else {
      unassignedGroup.add(cloned);
    }
  });

  // Compute centroid for each layer
  customLayers.forEach(cl => {
    if (cl.meshes.length === 0) return;
    const b = new THREE.Box3();
    cl.meshes.forEach(m => b.expandByObject(m));
    b.getCenter(cl.centroid);
  });

  // Scale & center all meshes, store original positions
  // Find global centroid of assigned meshes
  const allAssigned = [];
  customLayers.forEach(cl => cl.meshes.forEach(m => allAssigned.push(m)));

  if (allAssigned.length === 0) {
    console.warn('No meshes were assigned to any layer — assigning all to 结构层');
    // Fallback: assign all meshes to structural layer (index 0)
    allObjs.forEach(m => {
      const cloned = m.clone();
      cloned.userData.layerIndex = 0;
      cloned.userData.meshName = m.name || '(未命名)';
      customLayers[0].meshes.push(cloned);
      allAssigned.push(cloned);
    });
    // Recompute centroids
    customLayers.forEach(cl => {
      if (cl.meshes.length === 0) return;
      const b = new THREE.Box3();
      cl.meshes.forEach(m => b.expandByObject(m));
      b.getCenter(cl.centroid);
    });
  }

  const globalBox = new THREE.Box3();
  allAssigned.forEach(m => globalBox.expandByObject(m));
  const globalCenter = new THREE.Vector3();
  globalBox.getCenter(globalCenter);

  // Transform meshes: scale, then center at origin (Y=0 at bottom)
  const targetBottomY = WALL_HEIGHT;
  allAssigned.forEach(m => {
    if (!m.geometry) return;
    m.geometry = m.geometry.clone();
    // Apply scale
    m.geometry.scale(scale, scale, scale);
    // Offset to center
    m.position.multiplyScalar(scale);
    m.position.sub(globalCenter.clone().multiplyScalar(scale));
    m.position.y += (targetBottomY - globalBox.min.y * scale + globalCenter.y * scale);
    m.castShadow = true;
    m.receiveShadow = true;
    customGroup.add(m);
  });

  // Store original positions for explode animation
  customLayers.forEach(cl => {
    cl.originalPositions.clear();
    cl.meshes.forEach(m => {
      cl.originalPositions.set(m, m.position.clone());
    });
    // Recompute centroid after transform
    if (cl.meshes.length > 0) {
      const b = new THREE.Box3();
      cl.meshes.forEach(m => b.expandByObject(m));
      b.getCenter(cl.centroid);
    }
  });

  // Compute overall center for explode
  const allBox = new THREE.Box3();
  allAssigned.forEach(m => allBox.expandByObject(m));
  allBox.getCenter(customModelCenter);

  // Build flat mesh array for raycasting
  allCustomMeshes = [];
  customMeshIndex = new Map();
  customLayers.forEach(cl => {
    cl.meshes.forEach(m => {
      allCustomMeshes.push(m);
      customMeshIndex.set(m, cl.layerIndex);
    });
  });
}

function showMappingModal(allObjs) {
  const tbody = allObjs.map((m, i) => {
    const name = m.name || '(未命名)';
    const assignIdx = meshAssignments[name] ?? -1;
    const opts = ['<option value="-1">未分配</option>']
      .concat(layerDefs.map((d, idx) =>
        `<option value="${idx}"${idx === assignIdx ? ' selected' : ''}>${d.name} (${d.eng})</option>`
      )).join('');
    const meshInfo = m.isMesh ? `${m.geometry?.type || 'Mesh'} · ${approxTriCount(m)}` : '';
    return `<tr>
      <td><strong>${escapeHtml(name)}</strong><br><span style="font-size:0.68rem;color:var(--text-secondary);">${meshInfo}</span></td>
      <td><select data-mesh="${escapeHtml(name)}">${opts}</select></td>
    </tr>`;
  }).join('');

  document.getElementById('mappingTable').innerHTML = `
    <table><thead><tr><th>模型中的网格名称</th><th>映射到构造层</th></tr></thead>
    <tbody>${tbody}</tbody></table>`;

  // Count unassigned
  const unassignedCount = Object.values(meshAssignments).filter(v => v < 0).length;
  document.getElementById('unassignedNote').textContent =
    unassignedCount > 0
      ? `⚠️ ${unassignedCount} 个网格未分配，它们将在模型中显示但不参与层次交互。`
      : '✅ 所有网格已分配到对应构造层。';

  document.getElementById('mappingModal').classList.add('open');

  // Update meshAssignments on select change
  document.querySelectorAll('#mappingTable select').forEach(sel => {
    sel.addEventListener('change', () => {
      const meshName = sel.dataset.mesh;
      meshAssignments[meshName] = parseInt(sel.value);
      const ua = Object.values(meshAssignments).filter(v => v < 0).length;
      document.getElementById('unassignedNote').textContent =
        ua > 0 ? `⚠️ ${ua} 个网格未分配` : '✅ 所有网格已分配';
    });
  });
}

function approxTriCount(mesh) {
  try {
    const geo = mesh.geometry;
    if (!geo) return '';
    const idx = geo.index;
    if (idx) return `${Math.round(idx.count / 3)} △`;
    const pos = geo.attributes.position;
    if (pos) return `${Math.round(pos.count / 3)} △`;
  } catch (e) {}
  return '';
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function applyMapping() {
  document.getElementById('mappingModal').classList.remove('open');
  if (!loadedGltfScene) {
    console.error('No loaded GLTF scene to build from');
    return;
  }
  buildCustomLayers(loadedGltfScene);
  switchToCustomModel();
}

function switchToCustomModel() {
  usingCustomModel = true;
  demoGroup.visible = false;
  buildingGroup.visible = false;
  customGroup.visible = true;

  document.getElementById('btnLoadModel').style.display = 'none';
  document.getElementById('modelIndicator').textContent = MODULE_CONFIG.title + ' · 已加载';
  document.getElementById('legendSubtitle').textContent =
    `自定义模型 · ${layerDefs.length} 层构造`;

  selectedIdx = -1;
  hoveredIdx = -1;
  targetExplode = 0;
  explodeFactor = 0;
  document.getElementById('btnExplode').classList.remove('active');
  unpushLayer();

  buildLegend();
  updateDetailPanel();
  resetEmissives();
  updateAllPositions();
  recalculateCameraLimits();
}

function restoreDemoModel() {
  // Removed — demo model is no longer accessible
}

function loadModelFile(file) {
  document.getElementById('loading').classList.remove('hidden');
  const url = URL.createObjectURL(file);
  gltfLoader.load(url, (gltf) => {
    URL.revokeObjectURL(url);
    document.getElementById('loading').classList.add('hidden');
    processCustomModel(gltf.scene);
  }, undefined, (err) => {
    URL.revokeObjectURL(url);
    document.getElementById('loading').classList.add('hidden');
    console.error('GLTF load error:', err);
    alert('模型加载失败: ' + (err.message || '未知错误'));
  });
}

// ═══════════════════════════════════════════
// REBUILD DEMO MODEL FROM layerDefs
// ═══════════════════════════════════════════
function rebuildDemoModel() {
  // Removed — demo model is no longer used
}

// ═══════════════════════════════════════════
// LAYER EDIT MODAL
// ═══════════════════════════════════════════
function openEditModal() {
  if (usingCustomModel) {
    alert('请先还原到 Demo 模型再编辑层级。');
    return;
  }
  const list = document.getElementById('editLayerList');
  document.getElementById('editModal').classList.add('open');
  renderEditRows();
}

function renderEditRows() {
  const list = document.getElementById('editLayerList');
  list.innerHTML = layerDefs.map((def, i) => `
    <div class="edit-layer-row" data-idx="${i}">
      <div class="reorder">
        <button class="mv-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="mv-down" data-idx="${i}" ${i === layerDefs.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <input type="color" value="${def.color}" data-idx="${i}" data-field="color">
      <input type="text" class="name-input" value="${escapeHtml(def.name)}" data-idx="${i}" data-field="name" placeholder="中文名">
      <input type="text" class="eng-input" value="${escapeHtml(def.eng)}" data-idx="${i}" data-field="eng" placeholder="英文名">
      <input type="number" class="thick-input" value="${def.thick}" data-idx="${i}" data-field="thick" step="0.01" min="0.02" max="1">
      <input type="text" class="desc-input" value="${escapeHtml(def.desc)}" data-idx="${i}" data-field="desc" placeholder="描述">
      <button class="del-btn" data-idx="${i}" title="删除">🗑</button>
    </div>
  `).join('');

  // Bind events
  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => {
      const i = parseInt(inp.dataset.idx);
      const field = inp.dataset.field;
      const val = field === 'thick' ? parseFloat(inp.value) || 0.06 : inp.value;
      layerDefs[i][field] = val;
      saveLayerConfig(layerDefs);
    });
  });
  list.querySelectorAll('.mv-up').forEach(btn => {
    btn.addEventListener('click', () => moveLayer(parseInt(btn.dataset.idx), -1));
  });
  list.querySelectorAll('.mv-down').forEach(btn => {
    btn.addEventListener('click', () => moveLayer(parseInt(btn.dataset.idx), 1));
  });
  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => removeLayer(parseInt(btn.dataset.idx)));
  });
}

function moveLayer(idx, dir) {
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= layerDefs.length) return;
  [layerDefs[idx], layerDefs[newIdx]] = [layerDefs[newIdx], layerDefs[idx]];
  saveLayerConfig(layerDefs);
  renderEditRows();
}

function removeLayer(idx) {
  if (layerDefs.length <= 2) { alert('至少保留 2 个层级。'); return; }
  layerDefs.splice(idx, 1);
  saveLayerConfig(layerDefs);
  renderEditRows();
}

function addLayer() {
  layerDefs.push({
    name: '新层级', eng: 'New Layer', color: '#888888', thick: 0.1, roughness: 0.5,
    desc: '请填写描述'
  });
  saveLayerConfig(layerDefs);
  renderEditRows();
}

function saveEdits() {
  document.getElementById('editModal').classList.remove('open');
  saveLayerConfig(layerDefs);
}

function resetToDefault() {
  if (!confirm('确定恢复为默认的 8 层构造吗？你当前的修改会丢失。')) return;
  layerDefs = defaultLayerDefs.map(d => ({...d}));
  localStorage.removeItem('roofLayerConfig');
  renderEditRows();
}

// ═══════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════

// Drag & drop
let dragCounter = 0;
viewport.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) document.getElementById('dropOverlay').classList.add('active');
});
viewport.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    document.getElementById('dropOverlay').classList.remove('active');
  }
});
viewport.addEventListener('dragover', (e) => { e.preventDefault(); });
viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  document.getElementById('dropOverlay').classList.remove('active');
  const file = e.dataTransfer.files[0];
  if (file && /\.(glb|gltf)$/i.test(file.name)) {
    loadModelFile(file);
  } else {
    alert('请拖入 .glb 或 .gltf 格式的 3D 模型文件。');
  }
});

// File input
document.getElementById('btnLoadModel').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadModelFile(file);
  e.target.value = '';
});

// Restore demo
// restoreDemoModel removed

// Mapping modal
document.getElementById('btnMappingApply').addEventListener('click', applyMapping);
document.getElementById('btnMappingCancel').addEventListener('click', () => {
  document.getElementById('mappingModal').classList.remove('open');
  document.getElementById('loading').classList.add('hidden');
});

// Edit layer modal
document.getElementById('btnEditLayers').addEventListener('click', openEditModal);
document.getElementById('btnEditSave').addEventListener('click', saveEdits);
document.getElementById('btnEditCancel').addEventListener('click', () => {
  document.getElementById('editModal').classList.remove('open');
});
document.getElementById('btnEditReset').addEventListener('click', resetToDefault);
document.getElementById('btnAddLayer').addEventListener('click', addLayer);

// Raycaster hover
renderer.domElement.addEventListener('mousemove', (e) => {
  const idx = getLayerFromIntersect(getIntersections(e));
  if (idx !== hoveredIdx) {
    hoveredIdx = idx;
    resetEmissives();
    renderer.domElement.style.cursor = idx >= 0 ? 'pointer' : '';
  }
});

renderer.domElement.addEventListener('click', (e) => {
  const idx = getLayerFromIntersect(getIntersections(e));
  // Toggle: clicking the same layer again deselects it
  selectLayer(idx === selectedIdx ? -1 : idx);
});

// Buttons
document.getElementById('btnExplode').addEventListener('click', () => {
  targetExplode = targetExplode > 0.5 ? 0 : 1;
  document.getElementById('btnExplode').classList.toggle('active', targetExplode > 0.5);
  // Collapsing: also unpush any pushed component
  if (targetExplode < 0.5 && activePushIdx >= 0) selectLayer(-1);
});

document.getElementById('btnAutoRotate').addEventListener('click', () => {
  autoRotate = !autoRotate;
  controls.autoRotate = autoRotate;
  document.getElementById('btnAutoRotate').classList.toggle('active', autoRotate);
});

document.getElementById('btnReset').addEventListener('click', () => {
  if (activePushIdx >= 0) selectLayer(-1);
  resetting = true;
  resetT = 0;
  resetFromPos.copy(camera.position);
  resetFromTarget.copy(controls.target);
});

// Keyboard
window.addEventListener('keydown', (e) => {
  if (document.getElementById('mappingModal').classList.contains('open')) return;
  switch (e.key.toLowerCase()) {
    case 'e': targetExplode = targetExplode > 0.5 ? 0 : 1;
              document.getElementById('btnExplode').classList.toggle('active', targetExplode > 0.5);
              if (targetExplode < 0.5 && activePushIdx >= 0) selectLayer(-1);
              break;
    case 'r': autoRotate = !autoRotate; controls.autoRotate = autoRotate;
              document.getElementById('btnAutoRotate').classList.toggle('active', autoRotate);
              break;
    case '0': selectLayer(-1); break;
    case 'o':
      document.getElementById('fileInput').click();
      break;
    default:
      if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key) - 1;
        if (idx < layerDefs.length) selectLayer(idx);
      }
      break;
      break;
  }
});

// ═══════════════════════════════════════════
// RESIZE
// ═══════════════════════════════════════════
function resize() {
  const rect = viewport.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height);
  camera.aspect = rect.width / Math.max(rect.height, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Hide loading
setTimeout(() => {
  document.getElementById('loading').classList.add('hidden');
}, 400);

// ═══════════════════════════════════════════
// ANIMATION LOOP
// ═══════════════════════════════════════════
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  // Smooth explode
  const lerpSpeed = 6;
  explodeFactor += (targetExplode - explodeFactor) * Math.min(lerpSpeed * dt, 1);
  if (Math.abs(targetExplode - explodeFactor) < 0.001) explodeFactor = targetExplode;
  updateAllPositions();

  // Pulsing emissive on selected layer
  if (selectedIdx >= 0) {
    const pulse = Math.sin(Date.now() * 0.004) * 0.15 + 0.38;
    const mats = getLayerMaterials(selectedIdx);
    mats.forEach(m => {
      if (m && m.emissive) {
        m.emissive.set('#b55a10');
        m.emissiveIntensity = pulse;
      }
    });
  }

  // Reset camera animation
  if (resetting) {
    resetT += dt * 2.2;
    if (resetT >= 1) {
      resetT = 1; resetting = false;
      camera.position.copy(defaultCamPos);
      controls.target.copy(defaultTarget);
    } else {
      const t = easeInOutCubic(resetT);
      camera.position.lerpVectors(resetFromPos, defaultCamPos, t);
      controls.target.lerpVectors(resetFromTarget, defaultTarget, t);
    }
  }

  // Push animation — additive on top of explode position
  const lerpSpd = 5;
  pushStates.forEach((info, idx) => {
    info.progress += (info.target - info.progress) * Math.min(lerpSpd * dt, 1);
    if (Math.abs(info.target - info.progress) < 0.001) info.progress = info.target;

    const meshes = getLayerMeshes(idx);
    meshes.forEach(m => {
      const orig = info.origPositions.get(m); // true base (no explode, no push)
      if (orig) {
        // Keep the explode offset that updateAllPositions already applied,
        // then add push offset on top
        const explodeDelta = m.position.clone().sub(orig);
        const pushOffset = info.dir.clone().multiplyScalar(info.dist * info.progress);
        m.position.copy(orig).add(explodeDelta).add(pushOffset);
      }
    });

    // Cleanup fully-unpushed layers that aren't active
    if (info.target === 0 && info.progress < 0.005 && idx !== activePushIdx) {
      pushStates.delete(idx);
    }
  });

  // Update outlines to follow active layer meshes
  if (activePushIdx >= 0 && outlineGroup.children.length > 0) {
    const activeMeshes = getLayerMeshes(activePushIdx);
    outlineGroup.children.forEach((c, i) => {
      if (i < activeMeshes.length) {
        c.position.copy(activeMeshes[i].position);
        c.rotation.copy(activeMeshes[i].rotation);
      }
    });
  }

  // Pulse outline opacity for active layer
  if (activePushIdx >= 0 && outlineGroup.children.length > 0) {
    const pulse = Math.sin(Date.now() * 0.006) * 0.2 + 0.75;
    outlineGroup.children.forEach(c => {
      if (c.material) c.material.opacity = pulse;
    });
  }

  controls.update();
  renderer.render(scene, camera);

  const hint = document.getElementById('hint');
  if (hint) {
    hint.style.opacity = explodeFactor < 0.1 ? 0.85 : Math.max(0, 0.85 - explodeFactor * 2);
  }
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

animate();
updateDemoLayerPositions();

// ═══════════════════════════════════════════
// AUTO-LOAD CUSTOM MODEL
// ═══════════════════════════════════════════
function autoLoadCustomModel() {
  // Read embedded GLB data (base64 in <script type="text/glb"> tag)
  const b64 = MODULE_CONFIG.modelBase64;
  if (!b64) { console.log("No embedded model data"); return; }

  document.getElementById('loading').classList.remove('hidden');
  try {
    const binaryStr = atob(b64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);

    gltfLoader.load(url, (gltf) => {
      URL.revokeObjectURL(url);
      document.getElementById('loading').classList.add('hidden');

      const allObjs = collectMeshObjects(gltf.scene).filter(m => m.geometry);
      if (allObjs.length === 0) {
        console.warn('Auto-load: no meshes found, using demo model');
        return;
      }

      // Sort meshes by Y position (bottom → top) and assign to layers 0→7
      const sorted = allObjs.map(m => {
        const box = new THREE.Box3().setFromObject(m);
        return { mesh: m, y: box.min.y, name: m.name || '(未命名)' };
      }).sort((a, b) => a.y - b.y);

      meshAssignments = {};
      sorted.forEach((item, i) => {
        const layerIdx = Math.min(i, layerDefs.length - 1);
        meshAssignments[item.name] = layerIdx;
        console.log('Auto-load: \"' + item.name + '\" (Y=' + item.y.toFixed(2) + ') → layer ' + layerIdx + ' ' + layerDefs[layerIdx].name);
      });

      console.log('Auto-load: ' + sorted.length + ' meshes sorted by height, building model');
      loadedGltfScene = gltf.scene;
      allMeshNames = allObjs.map(m => m.name || '(未命名)');
      buildCustomLayers(gltf.scene);
      switchToCustomModel();
    }, undefined, (err) => {
      URL.revokeObjectURL(url);
      document.getElementById('loading').classList.add('hidden');
      console.warn('Auto-load failed, using demo model:', err.message);
    });
  } catch (e) {
    document.getElementById('loading').classList.add('hidden');
    console.warn('Auto-load decode failed:', e.message);
  }
}

// Start auto-load
autoLoadCustomModel();

console.log('🏠 屋顶构造交互式教学 Demo 已就绪');
console.log('  自动加载 1111.glb 模型中...');
console.log('  自定义模型: 拖拽 .glb/.gltf 文件到窗口 | 按键 O 打开文件选择');
