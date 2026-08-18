/**
 * Ocean3D 世界 —— 真实感海洋场景（Three.js Water + Sky 方案）。
 *
 * 视觉: 物理水面(法线波浪/太阳反射) + 大气天空 + PMREM 环境光照 + ACES 色调映射。
 * 数据: 监测站点发光数据柱(高度=污染指数,颜色=严重度,数据来自 /stats/sites)
 *      + 扩散粒子推演(F3内核, 漂浮于水面) + 科普模式垃圾投放(漂浮→下沉)。
 * 约定: 场景单位 1 ≈ 150m; 站点布局为示意布局(真实地理距离单场景无法等比呈现)。
 * 依赖: public/textures/waternormals.jpg(本地资源, 运行时不访问外网)。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
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
const WATER_LEVEL = 0;

/** 站点示意布局（x, z 场景坐标） */
const SITE_LAYOUT: Record<number, [number, number]> = {
  1: [-52, -38], 2: [18, -62], 3: [58, 26], 4: [-8, 52], 5: [-62, 30],
};

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
  ctx.roundRect(6, 6, canvas.width - 12, canvas.height - 12, 26);
  ctx.fill();
  ctx.strokeStyle = `#${new THREE.Color(color).getHexString()}aa`;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 58px "Microsoft YaHei"';
  ctx.fillText(code, 28, 78);
  ctx.fillStyle = 'rgba(225,240,250,.9)';
  ctx.font = '38px "Microsoft YaHei"';
  ctx.fillText(name.replace('监测点', ''), 130, 72);
  ctx.fillStyle = 'rgba(160,210,235,.75)';
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
  private pmrem: THREE.PMREMGenerator;
  private water: Water;
  private waterTex: THREE.Texture;
  private pickPlane: THREE.Mesh;

  private siteGroup = new THREE.Group();
  private siteData: SiteVisual[] = [];
  private hitSpheres: THREE.Mesh[] = [];
  private pulseRings: Array<{ ring: THREE.Mesh; phase: number }> = [];

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
  private sun = new THREE.Vector3();

  constructor(private container: HTMLElement, private handlers: OceanHandlers) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.52;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / Math.max(1, container.clientHeight), 1, 20000);
    this.camera.position.set(0, 26, 96);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 6, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = 1.50; // 不允许钻到水面以下视角
    this.controls.minDistance = 24;
    this.controls.maxDistance = 420;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.3;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });

    // ---------- 天空 + 太阳 + 环境光照 ----------
    const sky = new Sky();
    sky.scale.setScalar(10000);
    const skyUniforms = sky.material.uniforms;
    skyUniforms.turbidity.value = 7;
    skyUniforms.rayleigh.value = 2.2;
    skyUniforms.mieCoefficient.value = 0.005;
    skyUniforms.mieDirectionalG.value = 0.8;
    const elevation = 14, azimuth = 165;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sun.setFromSphericalCoords(1, phi, theta);
    skyUniforms.sunPosition.value.copy(this.sun);
    this.scene.add(sky);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const skyEnvScene = new THREE.Scene();
    skyEnvScene.add(sky.clone());
    const envRT = this.pmrem.fromScene(skyEnvScene as THREE.Scene);
    this.scene.environment = envRT.texture;

    const sunLight = new THREE.DirectionalLight(0xfff3e0, 2.2);
    sunLight.position.copy(this.sun).multiplyScalar(100);
    this.scene.add(sunLight);
    this.scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x0a2a3a, 0.65));

    // ---------- 真实水面 ----------
    this.waterTex = new THREE.TextureLoader().load('textures/waternormals.jpg');
    this.waterTex.wrapS = this.waterTex.wrapT = THREE.RepeatWrapping;
    this.water = new Water(new THREE.PlaneGeometry(8000, 8000), {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: this.waterTex,
      sunDirection: this.sun.clone().normalize(),
      sunColor: 0xffffff,
      waterColor: 0x0c5a78,
      distortionScale: 2.8,
      fog: false,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = WATER_LEVEL;
    this.scene.add(this.water);

    // 拾取用不可见水面（Water着色器网格不做射线拾取, 用独立平面保证交互稳定）
    const pickGeo = new THREE.PlaneGeometry(8000, 8000);
    pickGeo.rotateX(-Math.PI / 2);
    this.pickPlane = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ visible: false }));
    this.pickPlane.position.y = WATER_LEVEL;
    this.scene.add(this.pickPlane);

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
    const onRemove = () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
    };

    this.resizeOb = new ResizeObserver(() => {
      const w = container.clientWidth, h = Math.max(1, container.clientHeight);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    this.resizeOb.observe(container);

    this.animate = this.animate.bind(this);
    this._onRemove = onRemove;
    this.animate();
  }
  private _onRemove: () => void;

  // ---------- 站点 ----------
  setSites(sites: SiteVisual[]): void {
    this.siteData = sites;
    this.siteGroup.clear();
    this.hitSpheres = [];
    this.pulseRings = [];
    for (const site of sites) {
      const [x, z] = SITE_LAYOUT[site.id] ?? [0, 0];
      const color = colorForIndex(site.pollutionIndex);
      const group = new THREE.Group();
      group.position.set(x, WATER_LEVEL, z);

      // 数据柱: 从水面拔起的发光柱, 高度 = 2 + 污染指数×1.1（无数据 1.2）
      const h = site.pollutionIndex != null ? 2 + site.pollutionIndex * 1.1 : 1.2;
      const pillarGeo = new THREE.CylinderGeometry(1.5, 1.9, h, 20);
      const pillarMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 });
      const pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.position.y = h / 2;
      group.add(pillar);

      // 浮台底座 + 水面脉冲环
      const baseGeo = new THREE.CylinderGeometry(3.4, 3.8, 0.8, 28);
      const baseMat = new THREE.MeshStandardMaterial({ color: 0x14384e, roughness: 0.6, metalness: 0.3 });
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.y = 0.1;
      group.add(base);

      const pulseGeo = new THREE.RingGeometry(4.1, 4.5, 44);
      pulseGeo.rotateX(-Math.PI / 2);
      const pulseMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
      const pulse = new THREE.Mesh(pulseGeo, pulseMat);
      pulse.position.y = 0.25;
      group.add(pulse);


      // 不可见拾取球
      const hitGeo = new THREE.SphereGeometry(7);
      const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
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
    const [x, z] = SITE_LAYOUT[siteId] ?? [0, 0];
    this.focusGoal = new THREE.Vector3(x, 6, z);
    this.controls.autoRotate = false;
  }

  // ---------- 扩散推演（粒子漂浮于水面） ----------
  setDiffusion(result: DiffusionResult, originSiteId: number): void {
    this.clearDiffusion();
    const [ox, oz] = SITE_LAYOUT[originSiteId] ?? [0, 0];
    const origin = new THREE.Vector3(ox, WATER_LEVEL + 0.5, oz);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.nParticles * 3), 3));
    const mat = new THREE.PointsMaterial({
      color: 0xff7043, size: 1.7, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.diffusionPoints = new THREE.Points(geo, mat);
    this.scene.add(this.diffusionPoints);
    // 原点标记环（浮于水面）
    const oGeo = new THREE.RingGeometry(2.2, 2.7, 36);
    oGeo.rotateX(-Math.PI / 2);
    const oMat = new THREE.MeshBasicMaterial({ color: 0xff7043, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    const oRing = new THREE.Mesh(oGeo, oMat);
    oRing.position.set(ox, WATER_LEVEL + 0.35, oz);
    oRing.name = 'diffusion-origin';
    this.scene.add(oRing);
    this.diffusion = { result, origin };
    this.setDiffusionTime(0);
  }

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
      const dz = ((i * 37) % 11) * 0.10; // 粒子层厚感（确定性）
      arr[i * 3] = origin.x + x * M_TO_SCENE;
      arr[i * 3 + 1] = WATER_LEVEL + 0.5 + dz;
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

  // ---------- 科普投放（漂浮 → 下沉） ----------
  setGarbageKey(key: string): void { this.garbageKey = key; }

  dropGarbage(point: THREE.Vector3, key: string, color: string): void {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(64, 64, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 5; ctx.stroke();
    ctx.fillStyle = '#08303f';
    ctx.font = 'bold 34px "Microsoft YaHei"';
    ctx.fillText('圾', 48, 76);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    sprite.scale.set(3.6, 3.6, 1);
    sprite.position.set(point.x, WATER_LEVEL + 0.6, point.z);
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
      const waterHits = this.raycaster.intersectObject(this.pickPlane, false);
      if (waterHits.length > 0 && this.handlers.onWaterClick) this.handlers.onWaterClick(waterHits[0].point);
    }
  }

  // ---------- 主循环 ----------
  private animate(): void {
    this.raf = requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.getElapsedTime();

    // 水面波浪推进
    (this.water.material as THREE.ShaderMaterial).uniforms.time.value += dt * 0.7;

    for (const { ring, phase } of this.pulseRings) {
      const f = (t * 0.55 + phase) % 1;
      ring.scale.setScalar(1 + f * 1.6);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - f);
    }
    // 垃圾漂浮 → 2.2s后触发危害 → 缓慢沉没 → 60s清理
    for (let i = this.garbage.length - 1; i >= 0; i--) {
      const g = this.garbage[i];
      g.sprite.position.x += g.vx * dt;
      g.sprite.position.z += g.vz * dt;
      const age = t - g.bornAt;
      if (age > 3.5) g.sprite.position.y -= dt * 1.4; // 下沉
      const mat = g.sprite.material as THREE.SpriteMaterial;
      if (age > 3.5) mat.opacity = Math.max(0, 1 - (age - 3.5) / 8); // 沉没渐隐
      if (!g.impactFired && age > 2.2) {
        g.impactFired = true;
        this.handlers.onGarbageImpact?.(g.key);
      }
      if (age > 12) { // 12s 后回收（演示节奏更快, 避免场景堆积）
        this.garbageGroup.remove(g.sprite);
        mat.map?.dispose();
        mat.dispose();
        this.garbage.splice(i, 1);
      }
    }
    if (this.focusGoal) {
      this.controls.target.lerp(this.focusGoal, 0.055);
      if (this.controls.target.distanceTo(this.focusGoal) < 0.4) this.focusGoal = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

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
    this.waterTex.dispose();
    this.pmrem.dispose();
    this._onRemove();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
