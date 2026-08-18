/**
 * Ocean3D 世界 —— Three.js 场景管理（F2 MVP）。
 *
 * 内容: 程序化海底地形 + 深海雾/体积光束 + 漂浮微粒(marine snow)
 *      + 监测站点数据柱(高度=污染指数, 颜色=严重度, 数据来自 /stats/sites)
 *      + 扩散粒子推演(F3 内核轨迹渲染) + 科普模式垃圾投放物
 * 约定: 场景单位 1 ≈ 150m（扩散轨迹米制 → 场景缩放）; 站点布局为示意布局(非真实地理距离)。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { DiffusionResult } from './diffusion';

export interface SiteVisual {
  id: number;
  code: string;
  name: string;
  pollutionIndex: number | null;
  taskCount: number;
  totalObjects: number;
}

export interface OceanHandlers {
  onSiteClick?: (site: SiteVisual) => void;
  onWaterClick?: (point: THREE.Vector3) => void;
  onGarbageImpact?: (key: string) => void;
}

/** 米 → 场景单位 */
const M_TO_SCENE = 1 / 150;
const WATER_Y = 26;

/** 站点示意布局（x, z 场景坐标；真实地理距离在单场景中无法等比呈现，标注为示意） */
const SITE_LAYOUT: Record<number, [number, number]> = {
  1: [-52, -38], 2: [18, -62], 3: [58, 26], 4: [-8, 52], 5: [-62, 30],
};

// ---------- 噪声与地形高度（几何与采样共用，保证柱体贴地） ----------
function hashNoise(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hashNoise(xi, zi), b = hashNoise(xi + 1, zi);
  const c = hashNoise(xi, zi + 1), d = hashNoise(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function terrainHeight(x: number, z: number): number {
  let h = valueNoise(x * 0.03, z * 0.03) * 6.5 + valueNoise(x * 0.09, z * 0.09) * 2.2;
  const d = Math.sqrt(x * x + z * z);
  h += Math.max(0, (d - 96) * 0.3); // 外圈抬升成盆地轮廓
  return h;
}

function colorForIndex(index: number | null): number {
  if (index == null) return 0x2a7f9e;
  if (index >= 7) return 0xff5f6e;
  if (index >= 5) return 0xffbd66;
  return 0x27dafa;
}

function makeLabelSprite(code: string, name: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(4,22,36,.78)';
  ctx.beginPath();
  const r = 26;
  ctx.roundRect(6, 6, canvas.width - 12, canvas.height - 12, r);
  ctx.fill();
  ctx.strokeStyle = `#${new THREE.Color(color).getHexString()}88`;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#eaffff';
  ctx.font = 'bold 58px "Microsoft YaHei"';
  ctx.fillText(code, 28, 78);
  ctx.fillStyle = 'rgba(207,232,244,.85)';
  ctx.font = '38px "Microsoft YaHei"';
  ctx.fillText(name.replace('监测点', ''), 130, 72);
  ctx.fillStyle = 'rgba(120,200,230,.7)';
  ctx.font = '30px "Microsoft YaHei"';
  ctx.fillText('点击查看详情', 30, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(13, 4.1, 1);
  return sprite;
}

interface GarbageItem {
  sprite: THREE.Sprite;
  bornAt: number;
  vx: number; vz: number;
  impactFired: boolean;
  key: string;
}

export class OceanWorld {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private clock = new THREE.Clock();
  private raf = 0;
  private resizeOb: ResizeObserver;
  private disposers: Array<() => void> = [];

  private siteGroup = new THREE.Group();
  private siteData: SiteVisual[] = [];
  private hitSpheres: THREE.Mesh[] = [];
  private pulseRings: Array<{ ring: THREE.Mesh; phase: number }> = [];
  private snow?: THREE.Points;
  private shafts: Array<{ mesh: THREE.Mesh; phase: number }> = [];
  private waterPlane: THREE.Mesh;

  private diffusionPoints?: THREE.Points;
  private diffusion?: { result: DiffusionResult; origin: THREE.Vector3 };
  private garbage: GarbageItem[] = [];
  private garbageGroup = new THREE.Group();
  private garbageKey = 'bag';

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private downPos = { x: 0, y: 0 };
  private focusGoal: THREE.Vector3 | null = null;
  private clickMode: 'site' | 'water' = 'site';

  constructor(private container: HTMLElement, private handlers: OceanHandlers) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x03101c);
    this.scene.fog = new THREE.FogExp2(0x041420, 0.0042);

    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 800);
    this.camera.position.set(0, 52, 108);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 8, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = 1.42;
    this.controls.minDistance = 28;
    this.controls.maxDistance = 240;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });

    this.scene.add(new THREE.AmbientLight(0x7fb8d8, 0.55));
    const dir = new THREE.DirectionalLight(0xbfefff, 1.15);
    dir.position.set(30, 90, 20);
    this.scene.add(dir);
    this.buildTerrain();
    this.waterPlane = this.buildWater();
    this.buildShafts();
    this.buildSnow();
    this.scene.add(this.siteGroup, this.garbageGroup);

    // 指针拾取（区分点击与拖拽）
    const el = this.renderer.domElement;
    const onDown = (e: PointerEvent) => { this.downPos = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y);
      if (moved > 6) return;
      this.pick(e);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    this.disposers.push(() => { el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp); });

    this.resizeOb = new ResizeObserver(() => {
      const w = container.clientWidth, h = Math.max(1, container.clientHeight);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    this.resizeOb.observe(container);

    this.animate();
  }

  // ---------- 构建 ----------
  private buildTerrain(): void {
    const geo = new THREE.PlaneGeometry(240, 240, 110, 110);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, terrainHeight(x, z));
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x0e2a40, flatShading: true, roughness: 0.95, metalness: 0.05 });
    this.scene.add(new THREE.Mesh(geo, mat));
    this.disposers.push(() => { geo.dispose(); mat.dispose(); });
  }

  private buildWater(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(420, 420);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x0d5c85, transparent: true, opacity: 0.16, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = WATER_Y;
    this.scene.add(mesh);
    return mesh;
  }

  private buildShafts(): void {
    for (let i = 0; i < 6; i++) {
      const geo = new THREE.PlaneGeometry(4 + i * 1.4, 46);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x7fd8ff, transparent: true, opacity: 0.05 + (i % 3) * 0.022,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const angle = (i / 6) * Math.PI * 2;
      mesh.position.set(Math.cos(angle) * 34, WATER_Y - 22, Math.sin(angle) * 34);
      mesh.rotation.z = 0.22;
      mesh.rotation.y = -angle;
      this.scene.add(mesh);
      this.shafts.push({ mesh, phase: i * 1.7 });
      this.disposers.push(() => { geo.dispose(); mat.dispose(); });
    }
  }

  private buildSnow(): void {
    const N = 650;
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 230;
      arr[i * 3 + 1] = Math.random() * WATER_Y;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 230;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.PointsMaterial({ color: 0x9fd8e8, size: 0.32, transparent: true, opacity: 0.5, depthWrite: false });
    this.snow = new THREE.Points(geo, mat);
    this.scene.add(this.snow);
    this.disposers.push(() => { geo.dispose(); mat.dispose(); });
  }

  // ---------- 站点 ----------
  setSites(sites: SiteVisual[]): void {
    this.siteData = sites;
    this.siteGroup.clear();
    this.hitSpheres = [];
    this.pulseRings = [];
    for (const site of sites) {
      const [x, z] = SITE_LAYOUT[site.id] ?? [0, 0];
      const ground = terrainHeight(x, z);
      const color = colorForIndex(site.pollutionIndex);
      const group = new THREE.Group();
      group.position.set(x, ground, z);

      // 数据柱: 高度 = 2 + 污染指数×1.1（无数据 1.2）
      const h = site.pollutionIndex != null ? 2 + site.pollutionIndex * 1.1 : 1.2;
      const pillarGeo = new THREE.CylinderGeometry(1.5, 1.9, h, 20);
      const pillarMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.88 });
      const pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.position.y = h / 2;
      group.add(pillar);

      // 底座环 + 脉冲扩散环
      const baseGeo = new THREE.RingGeometry(2.2, 2.8, 40);
      baseGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
      group.add(new THREE.Mesh(baseGeo, ringMat));

      const pulseGeo = new THREE.RingGeometry(2.9, 3.25, 40);
      pulseGeo.rotateX(-Math.PI / 2);
      const pulseMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
      const pulse = new THREE.Mesh(pulseGeo, pulseMat);
      pulse.position.y = 0.15;
      group.add(pulse);
      this.pulseRings.push({ ring: pulse, phase: sites.indexOf(site) * 0.9 });

      // 不可见拾取球
      const hitGeo = new THREE.SphereGeometry(6.5);
      const hitMat = new THREE.MeshBasicMaterial({ visible: false });
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.y = Math.max(4, h);
      hit.userData.siteId = site.id;
      group.add(hit);
      this.hitSpheres.push(hit);

      const label = makeLabelSprite(site.code, site.name, color);
      label.position.y = h + 4.6;
      group.add(label);

      this.siteGroup.add(group);
    }
  }

  focusSite(siteId: number): void {
    const site = this.siteData.find((s) => s.id === siteId);
    const [x, z] = SITE_LAYOUT[siteId] ?? [0, 0];
    if (site) {
      this.focusGoal = new THREE.Vector3(x, Math.max(6, terrainHeight(x, z) + 6), z);
      this.controls.autoRotate = false;
    }
  }

  // ---------- 扩散推演 ----------
  setDiffusion(result: DiffusionResult, originSiteId: number): void {
    this.clearDiffusion();
    const [ox, oz] = SITE_LAYOUT[originSiteId] ?? [0, 0];
    const origin = new THREE.Vector3(ox, WATER_Y - 4, oz);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.nParticles * 3), 3));
    const mat = new THREE.PointsMaterial({
      color: 0x54f1a9, size: 0.55, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.diffusionPoints = new THREE.Points(geo, mat);
    this.scene.add(this.diffusionPoints);
    // 原点标记环
    const oGeo = new THREE.RingGeometry(1.4, 1.8, 32);
    oGeo.rotateX(-Math.PI / 2);
    const oMat = new THREE.MeshBasicMaterial({ color: 0x54f1a9, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    const oRing = new THREE.Mesh(oGeo, oMat);
    oRing.position.copy(origin).setY(WATER_Y - 3.6);
    oRing.name = 'diffusion-origin';
    this.scene.add(oRing);
    this.diffusion = { result, origin };
    this.setDiffusionTime(0);
  }

  /** t ∈ [0,1] 线性插值整条轨迹（播放器每帧调用） */
  setDiffusionTime(t: number): void {
    if (!this.diffusion || !this.diffusionPoints) return;
    const { result, origin } = this.diffusion;
    const { tracks, steps, nParticles } = result;
    const pos = this.diffusionPoints.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const tStep = Math.min(steps, Math.max(0, t * steps));
    const s0 = Math.floor(tStep), s1 = Math.min(steps, s0 + 1);
    const frac = tStep - s0;
    for (let i = 0; i < nParticles; i++) {
      const k0 = (i * (steps + 1) + s0) * 3;
      const k1 = (i * (steps + 1) + s1) * 3;
      const x = tracks[k0] + (tracks[k1] - tracks[k0]) * frac;
      const y = tracks[k0 + 1] + (tracks[k1 + 1] - tracks[k0 + 1]) * frac;
      // 轻微竖直扰动让粒子有厚度感（确定性, 同粒子同值）
      const dy = ((i * 37) % 11) * 0.14;
      arr[i * 3] = origin.x + x * M_TO_SCENE;
      arr[i * 3 + 1] = WATER_Y - 3.5 - dy;
      arr[i * 3 + 2] = origin.z + y * M_TO_SCENE;
    }
    pos.needsUpdate = true;
  }

  getDiffusion(): { result: DiffusionResult; origin: THREE.Vector3 } | undefined {
    return this.diffusion;
  }

  clearDiffusion(): void {
    if (this.diffusionPoints) {
      this.scene.remove(this.diffusionPoints);
      this.diffusionPoints.geometry.dispose();
      (this.diffusionPoints.material as THREE.Material).dispose();
      this.diffusionPoints = undefined;
    }
    const oRing = this.scene.getObjectByName('diffusion-origin');
    if (oRing) { this.scene.remove(oRing); (oRing as THREE.Mesh).geometry.dispose(); ((oRing as THREE.Mesh).material as THREE.Material).dispose(); }
    this.diffusion = undefined;
  }

  // ---------- 科普投放 ----------
  setGarbageKey(key: string): void { this.garbageKey = key; }

  dropGarbage(point: THREE.Vector3, key: string, color: string): void {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(64, 64, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 5; ctx.stroke();
    ctx.fillStyle = '#04222f';
    ctx.font = 'bold 34px "Microsoft YaHei"';
    ctx.fillText('圾', 48, 76);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    sprite.scale.set(3.4, 3.4, 1);
    sprite.position.set(point.x, WATER_Y - 1.5, point.z);
    this.garbageGroup.add(sprite);
    this.garbage.push({ sprite, bornAt: this.clock.getElapsedTime(), vx: 0.55 + Math.random() * 0.3, vz: -0.18, impactFired: false, key });
  }

  setClickMode(mode: 'site' | 'water'): void { this.clickMode = mode; }

  // ---------- 拾取 ----------
  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hits = this.raycaster.intersectObjects(this.hitSpheres, false);
    if (hits.length > 0 && this.handlers.onSiteClick) {
      const id = hits[0].object.userData.siteId as number;
      const site = this.siteData.find((s) => s.id === id);
      if (site) { this.handlers.onSiteClick(site); return; }
    }
    if (this.clickMode === 'water') {
      const waterHits = this.raycaster.intersectObject(this.waterPlane, false);
      if (waterHits.length > 0 && this.handlers.onWaterClick) this.handlers.onWaterClick(waterHits[0].point);
    }
  }

  // ---------- 主循环 ----------
  private animate = (): void => {
    this.raf = requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.getElapsedTime();

    for (const { ring, phase } of this.pulseRings) {
      const f = (t * 0.55 + phase) % 1;
      ring.scale.setScalar(1 + f * 1.5);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.65 * (1 - f);
    }
    for (const { mesh, phase } of this.shafts) {
      (mesh.material as THREE.MeshBasicMaterial).opacity = 0.045 + 0.035 * (0.5 + 0.5 * Math.sin(t * 0.5 + phase));
      mesh.rotation.z = 0.22 + Math.sin(t * 0.22 + phase) * 0.05;
    }
    if (this.snow) {
      const pos = this.snow.geometry.attributes.position as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 1; i < arr.length; i += 3) {
        arr[i] += dt * 0.55;
        if (arr[i] > WATER_Y) arr[i] = 0;
      }
      pos.needsUpdate = true;
    }
    // 垃圾漂移 + 缓沉 + 定时触发影响
    for (let i = this.garbage.length - 1; i >= 0; i--) {
      const g = this.garbage[i];
      g.sprite.position.x += g.vx * dt;
      g.sprite.position.z += g.vz * dt;
      g.sprite.position.y = Math.max(terrainHeight(g.sprite.position.x, g.sprite.position.z) + 1, g.sprite.position.y - dt * 1.15);
      if (!g.impactFired && t - g.bornAt > 2.2) {
        g.impactFired = true;
        this.handlers.onGarbageImpact?.(g.key);
      }
      if (t - g.bornAt > 60) { // 60s 后清理
        this.garbageGroup.remove(g.sprite);
        (g.sprite.material as THREE.SpriteMaterial).map?.dispose();
        (g.sprite.material as THREE.SpriteMaterial).dispose();
        this.garbage.splice(i, 1);
      }
    }
    if (this.focusGoal) {
      this.controls.target.lerp(this.focusGoal, 0.055);
      if (this.controls.target.distanceTo(this.focusGoal) < 0.4) this.focusGoal = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeOb.disconnect();
    this.controls.dispose();
    this.clearDiffusion();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
      const sprite = obj as THREE.Sprite;
      if (sprite.material && 'map' in sprite.material) {
        (sprite.material as THREE.SpriteMaterial).map?.dispose();
        (sprite.material as THREE.SpriteMaterial).dispose();
      }
    });
    this.disposers.forEach((fn) => fn());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
