/**
 * Ocean3D 世界 —— 真实海洋场景（真实测深地形 + 水面/水下双视角 + 生物群体动画）。
 *
 * 真实数据: public/data/zhoushan_bathymetry.json —— GEBCO 2020 真实测深(舟山海域,
 *           含岛屿), 启动时本地加载, 运行零外网依赖。
 * 视觉: 水面视角 = Three.js Water波浪反射 + Sky大气 + ACES电影调色;
 *       水下视角 = 深海雾 + 体积光束 + 悬浮微粒 + 真实地形漫游 + 鱼群(boids)。
 * 生物: 水面海鸥(拍翅盘旋, 游戏常用手法) / 水下鱼群(聚散/对齐/分离的群体行为)。
 * 垃圾: 物理3D模型(透明塑料瓶/金属罐/渔网/塑料袋/绳索/包装), 漂浮→下沉。
 * 约定: 场景单位 1 ≈ 150m; 站点为示意布局。
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

export type OceanView = 'surface' | 'underwater';

const M_TO_SCENE = 1 / 150;
const SITE_LAYOUT: Record<number, [number, number]> = {
  1: [-52, -38], 2: [18, -62], 3: [58, 26], 4: [-8, 52], 5: [-62, 30],
};
/** 地形网格覆盖的场景范围(±TERRAIN_HALF) */
const TERRAIN_HALF = 120;

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

// ---------- 精细垃圾 3D 模型（物理材质程序化建模） ----------
function makeGarbageModel(key: string): THREE.Group {
  const g = new THREE.Group();
  if (key === 'bottle') {
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 2.1, 18),
      new THREE.MeshPhysicalMaterial({ color: 0xbfe8ff, transmission: 0.85, roughness: 0.12, thickness: 1.2, transparent: true, metalness: 0 }),
    );
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.32, 0.4, 14), body.material);
    neck.position.y = 1.2;
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.3, 14),
      new THREE.MeshStandardMaterial({ color: 0x2f6df6, roughness: 0.35 }),
    );
    cap.position.y = 1.5;
    const label = new THREE.Mesh(
      new THREE.CylinderGeometry(0.51, 0.51, 0.7, 18, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.6, side: THREE.DoubleSide }),
    );
    label.position.y = -0.2;
    g.add(body, neck, cap, label);
  } else if (key === 'can') {
    const metal = new THREE.MeshStandardMaterial({ color: 0xd8dde2, metalness: 0.95, roughness: 0.22 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 1.15, 20), metal);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.1, 20), new THREE.MeshStandardMaterial({ color: 0xaeb6bd, metalness: 0.9, roughness: 0.3 }));
    lid.position.y = 0.6;
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.49, 0.49, 0.75, 20, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x27dafa, roughness: 0.5, side: THREE.DoubleSide }),
    );
    g.add(body, lid, band);
  } else if (key === 'net') {
    const net = new THREE.Mesh(
      new THREE.SphereGeometry(1.7, 10, 7),
      new THREE.MeshStandardMaterial({ color: 0x7de8c3, wireframe: true, transparent: true, opacity: 0.9 }),
    );
    net.scale.set(1.3, 0.55, 1);
    g.add(net);
  } else if (key === 'bag') {
    const geo = new THREE.PlaneGeometry(2.3, 1.8, 6, 5);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.45);
    }
    geo.computeVertexNormals();
    const bag = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
      color: 0xdfe9f2, roughness: 0.3, transmission: 0.25, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    }));
    bag.rotation.x = -0.4;
    g.add(bag);
  } else if (key === 'rope') {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 6; i++) {
      pts.push(new THREE.Vector3(Math.sin(i * 2.1) * 1.1, (Math.random() - 0.5) * 0.6, Math.cos(i * 1.7) * 1.1));
    }
    const rope = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.12, 6),
      new THREE.MeshStandardMaterial({ color: 0x3f7f5f, roughness: 0.85 }),
    );
    g.add(rope);
  } else { // wrapper 零食包装
    const wrap = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.12, 1.25),
      new THREE.MeshStandardMaterial({ color: 0xffd24a, metalness: 0.75, roughness: 0.3 }),
    );
    wrap.rotation.set(0.2, 0.6, -0.15);
    g.add(wrap);
  }
  g.scale.setScalar(1.6);
  return g;
}

interface GarbageItem {
  model: THREE.Group;
  bornAt: number;
  vx: number; vz: number;
  spin: THREE.Vector3;
  impactFired: boolean;
  key: string;
}

interface FishState {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
}

interface Gull {
  group: THREE.Group;
  wings: [THREE.Mesh, THREE.Mesh];
  radius: number; speed: number; phase: number; height: number;
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
  private sky?: THREE.Mesh;
  private sun = new THREE.Vector3();
  private view: OceanView = 'surface';

  // 水下要素
  private terrain?: THREE.Mesh;
  private terrainHeights: { nx: number; nz: number; data: number[][] } | null = null;
  private shafts: Array<{ mesh: THREE.Mesh; phase: number }> = [];
  private snow?: THREE.Points;
  private fish?: THREE.InstancedMesh;
  private fishData: FishState[] = [];
  private fishDummy = new THREE.Object3D();

  private siteGroup = new THREE.Group();
  private siteData: SiteVisual[] = [];
  private hitSpheres: THREE.Mesh[] = [];
  private pulseRings: Array<{ ring: THREE.Mesh; phase: number }> = [];

  private diffusionPoints?: THREE.Points;
  private diffusion?: { result: DiffusionResult; origin: THREE.Vector3 };
  private garbage: GarbageItem[] = [];
  private garbageGroup = new THREE.Group();
  private gulls: Gull[] = [];

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private downPos = { x: 0, y: 0 };
  private focusGoal: THREE.Vector3 | null = null;
  private clickMode: 'site' | 'water' = 'site';
  private _onRemove: () => void;

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
    this.controls.maxPolarAngle = 1.50;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 420;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.3;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });

    // ---------- 天空 + 太阳 + 环境光 ----------
    const sky = new Sky();
    sky.scale.setScalar(10000);
    const u = sky.material.uniforms;
    u.turbidity.value = 7;
    u.rayleigh.value = 2.2;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    const phi = THREE.MathUtils.degToRad(90 - 14);
    const theta = THREE.MathUtils.degToRad(165);
    this.sun.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sun);
    this.scene.add(sky);
    this.sky = sky;

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    this.scene.environment = this.pmrem.fromScene(envScene as THREE.Scene).texture;

    const sunLight = new THREE.DirectionalLight(0xfff3e0, 2.2);
    sunLight.position.copy(this.sun).multiplyScalar(100);
    this.scene.add(sunLight);
    this.scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x0a2a3a, 0.65));

    // ---------- 真实水面 ----------
    this.waterTex = new THREE.TextureLoader().load('textures/waternormals.jpg');
    this.waterTex.wrapS = this.waterTex.wrapT = THREE.RepeatWrapping;
    this.water = new Water(new THREE.PlaneGeometry(8000, 8000), {
      textureWidth: 512, textureHeight: 512,
      waterNormals: this.waterTex,
      sunDirection: this.sun.clone().normalize(),
      sunColor: 0xffffff, waterColor: 0x0c5a78, distortionScale: 2.8, fog: false,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.scene.add(this.water);

    const pickGeo = new THREE.PlaneGeometry(8000, 8000);
    pickGeo.rotateX(-Math.PI / 2);
    this.pickPlane = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ visible: false }));
    this.scene.add(this.pickPlane);

    this.scene.add(this.siteGroup, this.garbageGroup);

    // ---------- 真实测深地形 + 水下要素 + 生物 ----------
    void this.loadBathymetry();
    this.buildShafts();
    this.buildSnow();
    this.buildFish();
    this.buildGulls();
    this.applyView();

    // 指针拾取
    const el = this.renderer.domElement;
    const onDown = (e: PointerEvent) => { this.downPos = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 6) return;
      this.pick(e);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    this._onRemove = () => {
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
    this.animate();
  }

  // ---------- 真实测深地形 ----------
  private async loadBathymetry(): Promise<void> {
    try {
      const res = await fetch('data/zhoushan_bathymetry.json');
      const json = await res.json();
      const { nx, nz } = json.meta;
      this.terrainHeights = { nx, nz, data: json.depths };
      // 由 33×33 网格细分到 96×96 顶点（双线性插值）, 岛屿轮廓更平滑
      const VX = 96;
      const positions: number[] = [];
      const colors: number[] = [];
      const cShallow = new THREE.Color(0xc9b98a); // 浅滩沙色
      const cSlope = new THREE.Color(0x2a5f7a);   // 大陆坡
      const cDeep = new THREE.Color(0x0a2438);    // 深海
      const tmp = new THREE.Color();
      for (let iz = 0; iz < VX; iz++) {
        for (let ix = 0; ix < VX; ix++) {
          const x = -TERRAIN_HALF + (ix / (VX - 1)) * TERRAIN_HALF * 2;
          const z = -TERRAIN_HALF + (iz / (VX - 1)) * TERRAIN_HALF * 2;
          const h = this.heightAt(x, z) ?? -8;
          positions.push(x, h, z);
          if (h > 1) tmp.copy(cShallow);
          else if (h > -18) tmp.lerpColors(cSlope, cShallow, (h + 18) / 19);
          else tmp.lerpColors(cDeep, cSlope, Math.min(1, (h + 60) / 42));
          colors.push(tmp.r, tmp.g, tmp.b);
        }
      }
      const idx: number[] = [];
      for (let iz = 0; iz < VX - 1; iz++) {
        for (let ix = 0; ix < VX - 1; ix++) {
          const a = iz * VX + ix, b = a + 1, c = a + VX, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.05, flatShading: true });
      this.terrain = new THREE.Mesh(geo, mat);
      this.scene.add(this.terrain);
      this.repositionSites();
    } catch {
      // 地形加载失败时场景仍可用（水面/站点/推演不受影响）
    }
  }

  /** 场景坐标 → 真实测深高度（双线性）。x:东, z:南 */
  private heightAt(x: number, z: number): number | null {
    const t = this.terrainHeights;
    if (!t) return null;
    const fx = ((x + TERRAIN_HALF) / (TERRAIN_HALF * 2)) * (t.nx - 1);
    const fz = ((z + TERRAIN_HALF) / (TERRAIN_HALF * 2)) * (t.nz - 1);
    const ix = Math.min(t.nx - 2, Math.max(0, Math.floor(fx)));
    const iz = Math.min(t.nz - 2, Math.max(0, Math.floor(fz)));
    const tx = fx - ix, tz = fz - iz;
    const s = (i: number, j: number) => t.data[j][i];
    // 真实深度(米, 负=海底) → 场景高度, 夸张系数保证起伏可视
    const raw = s(ix, iz) * (1 - tx) * (1 - tz) + s(ix + 1, iz) * tx * (1 - tz)
      + s(ix, iz + 1) * (1 - tx) * tz + s(ix + 1, iz + 1) * tx * tz;
    return raw * 0.09;
  }

  private repositionSites(): void {
    for (const g of this.siteGroup.children) {
      const h = this.heightAt(g.position.x, g.position.z);
      if (h != null) g.position.y = Math.max(0, h); // 岛上站点贴地, 水域站点浮于水面
    }
  }

  // ---------- 水下要素 ----------
  private buildShafts(): void {
    for (let i = 0; i < 6; i++) {
      const geo = new THREE.PlaneGeometry(4 + i * 1.4, 46);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x7fd8ff, transparent: true, opacity: 0.06,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const angle = (i / 6) * Math.PI * 2;
      mesh.position.set(Math.cos(angle) * 34, -3, Math.sin(angle) * 34);
      mesh.rotation.z = 0.22;
      mesh.rotation.y = -angle;
      this.scene.add(mesh);
      this.shafts.push({ mesh, phase: i * 1.7 });
    }
  }

  private buildSnow(): void {
    const N = 650;
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 230;
      arr[i * 3 + 1] = -0.4 - Math.random() * 3.6;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 230;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.snow = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9fd8e8, size: 0.3, transparent: true, opacity: 0.5, depthWrite: false }));
    this.scene.add(this.snow);
  }

  // ---------- 鱼群（boids 群体行为） ----------
  private buildFish(): void {
    const N = 60;
    const geo = new THREE.ConeGeometry(0.32, 1.5, 6);
    geo.rotateX(Math.PI / 2); // 头朝 +z
    const mat = new THREE.MeshStandardMaterial({ color: 0x8fb8cc, roughness: 0.4, metalness: 0.5 });
    this.fish = new THREE.InstancedMesh(geo, mat, N);
    this.fish.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < N; i++) {
      this.fishData.push({
        pos: new THREE.Vector3((Math.random() - 0.5) * 120, -1 - Math.random() * 6, (Math.random() - 0.5) * 120),
        vel: new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 4),
      });
    }
    this.scene.add(this.fish);
  }

  private updateFish(dt: number, time: number): void {
    if (!this.fish) return;
    const fish = this.fishData;
    const center = new THREE.Vector3(0, -3.5, 0);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      // 聚合 + 对齐 + 分离(近似) + 环绕中心 + 边界回弹
      tmp.copy(center).sub(f.pos).multiplyScalar(0.06);
      f.vel.addScaledVector(tmp, dt * 6);
      if (i % 3 === 0) { // 抽样邻居降低开销
        const nb = fish[(i + 1) % fish.length];
        f.vel.addScaledVector(nb.vel, 0.02 * dt);
        tmp.copy(f.pos).sub(nb.pos);
        if (tmp.lengthSq() < 9) f.vel.addScaledVector(tmp.normalize(), 2.2 * dt);
      }
      // 游动摆尾感（正弦扰动）
      f.vel.y += Math.sin(time * 1.4 + i) * 0.05 * dt;
      const speed = Math.max(2.2, Math.min(6.5, f.vel.length()));
      f.vel.setLength(speed);
      f.pos.addScaledVector(f.vel, dt);
      // 越界回拉
      if (f.pos.length() > 130) { tmp.copy(center).sub(f.pos).normalize(); f.vel.addScaledVector(tmp, 3 * dt); }
      f.pos.y = Math.max(-7.5, Math.min(-0.8, f.pos.y));
      // 写入实例矩阵
      this.fishDummy.position.copy(f.pos);
      this.fishDummy.lookAt(tmp.copy(f.pos).add(f.vel));
      this.fishDummy.rotateY(Math.PI); // cone 朝向修正
      this.fishDummy.scale.setScalar(1 + (i % 5) * 0.12);
      this.fishDummy.updateMatrix();
      this.fish.setMatrixAt(i, this.fishDummy.matrix);
    }
    this.fish.instanceMatrix.needsUpdate = true;
  }

  // ---------- 海鸥（水面拍翅盘旋） ----------
  private buildGulls(): void {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf2f5f7, roughness: 0.7 });
    const wingMat = new THREE.MeshStandardMaterial({ color: 0xe8edf1, roughness: 0.7, side: THREE.DoubleSide });
    for (let i = 0; i < 7; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.1, 6).rotateX(Math.PI / 2), bodyMat);
      const wingGeo = new THREE.PlaneGeometry(1.5, 0.42);
      const left = new THREE.Mesh(wingGeo, wingMat);
      left.position.x = -0.8;
      const right = new THREE.Mesh(wingGeo, wingMat);
      right.position.x = 0.8;
      group.add(body, left, right);
      group.scale.setScalar(1.4);
      this.scene.add(group);
      this.gulls.push({
        group, wings: [left, right],
        radius: 38 + (i % 4) * 16, speed: 0.12 + (i % 3) * 0.05,
        phase: (i / 7) * Math.PI * 2, height: 24 + (i % 5) * 4,
      });
    }
  }

  private updateGulls(time: number): void {
    for (const g of this.gulls) {
      const a = time * g.speed + g.phase;
      g.group.position.set(Math.cos(a) * g.radius, g.height + Math.sin(time * 0.7 + g.phase) * 1.6, Math.sin(a) * g.radius);
      g.group.rotation.y = -a + Math.PI / 2; // 切向飞行
      const flap = Math.sin(time * 5 + g.phase * 3) * 0.55;
      g.wings[0].rotation.y = flap;
      g.wings[1].rotation.y = -flap;
    }
  }

  // ---------- 视角切换 ----------
  setView(view: OceanView): void {
    this.view = view;
    this.applyView();
  }

  private applyView(): void {
    const underwater = this.view === 'underwater';
    if (this.sky) this.sky.visible = !underwater;
    this.water.visible = !underwater;
    this.pickPlane.visible = !underwater && this.clickMode === 'water';
    for (const s of this.shafts) s.mesh.visible = underwater;
    if (this.snow) this.snow.visible = underwater;
    if (this.fish) this.fish.visible = underwater;
    for (const g of this.gulls) g.group.visible = !underwater;
    if (underwater) {
      this.scene.fog = new THREE.FogExp2(0x0a4256, 0.0085);
      this.scene.background = new THREE.Color(0x073546);
      this.renderer.toneMappingExposure = 0.85;
      this.camera.position.set(0, -1.2, 80);
      this.controls.target.set(0, -6.5, 0);
      this.controls.maxPolarAngle = 2.9; // 水下可抬头看水面
      this.controls.autoRotate = false;
    } else {
      this.scene.fog = null;
      this.scene.background = null; // 天空盒负责背景
      this.renderer.toneMappingExposure = 0.52;
      this.camera.position.set(0, 26, 96);
      this.controls.target.set(0, 6, 0);
      this.controls.maxPolarAngle = 1.50;
    }
  }

  // ---------- 站点 ----------
  setSites(sites: SiteVisual[]): void {
    this.siteData = sites;
    this.siteGroup.clear();
    this.hitSpheres = [];
    this.pulseRings = [];
    for (const site of sites) {
      const [x, z] = SITE_LAYOUT[site.id] ?? [0, 0];
      const groundY = Math.max(0, this.heightAt?.(x, z) ?? 0);
      const color = colorForIndex(site.pollutionIndex);
      const group = new THREE.Group();
      group.position.set(x, groundY, z);

      const h = site.pollutionIndex != null ? 2 + site.pollutionIndex * 1.1 : 1.2;
      const pillarGeo = new THREE.CylinderGeometry(1.5, 1.9, h, 20);
      const pillar = new THREE.Mesh(pillarGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
      pillar.position.y = h / 2;
      group.add(pillar);

      const baseGeo = new THREE.CylinderGeometry(3.4, 3.8, 0.8, 28);
      const base = new THREE.Mesh(baseGeo, new THREE.MeshStandardMaterial({ color: 0x14384e, roughness: 0.6, metalness: 0.3 }));
      base.position.y = 0.1;
      group.add(base);

      const pulseGeo = new THREE.RingGeometry(4.1, 4.5, 44);
      pulseGeo.rotateX(-Math.PI / 2);
      const pulse = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
      pulse.position.y = 0.25;
      group.add(pulse);
      this.pulseRings.push({ ring: pulse, phase: sites.indexOf(site) * 0.9 });

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
    this.focusGoal = new THREE.Vector3(x, this.view === 'underwater' ? -3.5 : 6, z);
    this.controls.autoRotate = false;
  }

  // ---------- 扩散推演 ----------
  setDiffusion(result: DiffusionResult, originSiteId: number): void {
    this.clearDiffusion();
    const [ox, oz] = SITE_LAYOUT[originSiteId] ?? [0, 0];
    const origin = new THREE.Vector3(ox, 0.5, oz);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.nParticles * 3), 3));
    const mat = new THREE.PointsMaterial({
      color: 0xff7043, size: 1.7, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.diffusionPoints = new THREE.Points(geo, mat);
    this.scene.add(this.diffusionPoints);
    const oGeo = new THREE.RingGeometry(2.2, 2.7, 36);
    oGeo.rotateX(-Math.PI / 2);
    const oRing = new THREE.Mesh(oGeo, new THREE.MeshBasicMaterial({ color: 0xff7043, transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
    oRing.position.set(ox, 0.35, oz);
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
      const dz = ((i * 37) % 11) * 0.10;
      arr[i * 3] = origin.x + x * M_TO_SCENE;
      arr[i * 3 + 1] = 0.5 + dz;
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

  // ---------- 科普投放（3D 模型: 漂浮→下沉） ----------
  setGarbageKey(key: string): void { this.garbageKey = key; }
  private garbageKey = 'bag';

  dropGarbage(point: THREE.Vector3, key: string, _color: string): void {
    const model = makeGarbageModel(key);
    model.position.set(point.x, 0.3, point.z);
    this.garbageGroup.add(model);
    this.garbage.push({
      model, bornAt: this.clock.getElapsedTime(),
      vx: 0.55 + Math.random() * 0.3, vz: -0.18,
      spin: new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.8),
      impactFired: false, key,
    });
  }

  setClickMode(mode: 'site' | 'water'): void {
    this.clickMode = mode;
    this.pickPlane.visible = this.view === 'surface' && mode === 'water';
  }

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
    if (this.clickMode === 'water' && this.view === 'surface') {
      const waterHits = this.raycaster.intersectObject(this.pickPlane, false);
      if (waterHits.length > 0 && this.handlers.onWaterClick) this.handlers.onWaterClick(waterHits[0].point);
    }
  }

  // ---------- 主循环 ----------
  private animate(): void {
    this.raf = requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.getElapsedTime();
    const underwater = this.view === 'underwater';

    (this.water.material as THREE.ShaderMaterial).uniforms.time.value += dt * 0.7;

    for (const { ring, phase } of this.pulseRings) {
      const f = (t * 0.55 + phase) % 1;
      ring.scale.setScalar(1 + f * 1.6);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - f);
    }
    if (underwater) {
      for (const { mesh, phase } of this.shafts) {
        (mesh.material as THREE.MeshBasicMaterial).opacity = 0.045 + 0.035 * (0.5 + 0.5 * Math.sin(t * 0.5 + phase));
        mesh.rotation.z = 0.22 + Math.sin(t * 0.22 + phase) * 0.05;
      }
      if (this.snow) {
        const pos = this.snow.geometry.attributes.position as THREE.BufferAttribute;
        const arr = pos.array as Float32Array;
        for (let i = 1; i < arr.length; i += 3) {
          arr[i] += dt * 0.5;
          if (arr[i] > -0.35) arr[i] = -4;
        }
        pos.needsUpdate = true;
      }
      this.updateFish(dt, t);
    } else {
      this.updateGulls(t);
    }
    // 垃圾: 漂浮自旋 → 3.5s后下沉渐隐 → 12s回收
    for (let i = this.garbage.length - 1; i >= 0; i--) {
      const g = this.garbage[i];
      g.model.position.x += g.vx * dt;
      g.model.position.z += g.vz * dt;
      g.model.rotation.x += g.spin.x * dt;
      g.model.rotation.y += g.spin.y * dt;
      g.model.rotation.z += g.spin.z * dt;
      g.model.position.y += Math.sin(t * 1.6 + i) * 0.12 * dt; // 波浪起伏
      const age = t - g.bornAt;
      if (age > 3.5) g.model.position.y -= dt * 1.1;
      if (!g.impactFired && age > 2.2) {
        g.impactFired = true;
        this.handlers.onGarbageImpact?.(g.key);
      }
      if (age > 12) {
        this.garbageGroup.remove(g.model);
        g.model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
          const mm = m.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mm)) mm.forEach((x) => x.dispose()); else mm?.dispose();
        });
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
