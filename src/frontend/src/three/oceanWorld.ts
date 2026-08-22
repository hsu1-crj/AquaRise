/**
 * Ocean3D 世界 —— 真实海洋数字孪生（真实感水面 + 仿真水下生态双视角）。
 *
 * 水面: Three.js Water 波浪反射 + Sky 大气散射 + PMREM 环境光照 + ACES 电影调色,
 *       监测站点以真实浮标(随浪起伏/信号灯闪烁)呈现, 数据光柱为 AR 叠加层。
 * 水下: underwater.ts —— 真实测深海底(GEBCO) + 焦散光斑 + 巨藻林/珊瑚礁 + 骨骼动画
 *       鱼群(boids) + 水母 + 体积光束 + 海雪 + 冷泉气泡 + ROV 数字孪生(探照灯/尾流)。
 * 真实数据: public/data/zhoushan_bathymetry.json(舟山海域测深) + 真实行政岸线。
 * 约定: 场景单位 1 ≈ 150m; 站点为示意布局; 1 逻辑帧 = 1 渲染帧。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { UnderwaterWorld } from './underwater';
import { normalizeModelSize } from './story';
import type { DiffusionResult } from './diffusion';
import { GarbageStory, RovUnit, loadCoastline } from './story';
import { LiveTaskOverlay } from './liveTask';
import type { LiveFrameBox, LiveProgress, LiveTargetItem } from './liveTask';
import type { KnowledgePoi } from '../data/knowledgePois';
import type { GarbageStoryState } from './story';
import { EnvironmentController } from './weather';
import type { TimeMode, WeatherMode } from './weather';
import { EarthGlobe } from './globe';
import type { GlobeStation } from './globe';

export interface SiteVisual {
  id: number;
  code: string;
  name: string;
  pollutionIndex: number | null;
  taskCount: number;
  totalObjects: number;
  evidence?: Array<{ taskId: number; mediaUrl: string | null; className: string | null; objectCount: number; level: string | null; at: string | null }>;
}

export interface OceanHandlers {
  onSiteClick?: (site: SiteVisual) => void;
  onWaterClick?: (point: THREE.Vector3) => void;
  onGarbageImpact?: (key: string) => void;
  onPoiClick?: (poi: KnowledgePoi) => void;
  onGlobeSelect?: (station: GlobeStation) => void;
  onGlobeEnter?: (stationId: number) => void;
}


const M_TO_SCENE = 1 / 150;
const SITE_LAYOUT: Record<number, [number, number]> = {
  // 北戴河(A-01) / 秦皇岛(B-01) / 渤海湾(C-01): 现实中三片不同海域, 场景内也远距分离
  1: [-85, -60], 2: [30, -95], 3: [115, 55], 4: [-135, 15], 5: [-25, 95], 6: [45, -125],
};

/** 太阳方位(决定水面高光方向/光束倾角/水下光晕, 全场景共享) */
const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(
  1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(128));

/** 水下光学: 视线-海床平面解析距离 → 波长选择性吸收(红先衰) + 水体散射 + 折射扰动 + 冷色晕影 */
const UnderwaterShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uOn: { value: 0 },
    uAspect: { value: 1 },
    uCamPos: { value: new THREE.Vector3() },
    uCamRight: { value: new THREE.Vector3() },
    uCamUp: { value: new THREE.Vector3() },
    uCamFwd: { value: new THREE.Vector3() },
    uTanHalfFov: { value: 0.5 },
    uFloorY: { value: -5.5 },
    // Beer-Lambert 体积吸收系数(1/场景单位): 红被吸收最快 → 越远越蓝绿
    uAbsorb: { value: new THREE.Vector3(0.10, 0.045, 0.028) },
    uScatter: { value: new THREE.Color(0x0a4a68) },
    uScatterK: { value: 0.022 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uOn;
    uniform float uAspect;
    uniform vec3 uCamPos;
    uniform vec3 uCamRight;
    uniform vec3 uCamUp;
    uniform vec3 uCamFwd;
    uniform float uTanHalfFov;
    uniform float uFloorY;
    uniform vec3 uAbsorb;
    uniform vec3 uScatter;
    uniform float uScatterK;
    varying vec2 vUv;

    /** 像素视线到海底/水面平面的距离(近似水体光程) */
    float waterPath(vec2 ndc) {
      vec3 ray = normalize(uCamFwd + uCamRight * ndc.x * uTanHalfFov * uAspect + uCamUp * ndc.y * uTanHalfFov);
      if (ray.y < -0.015) return (uCamPos.y - uFloorY) / -ray.y;   // 看向海床
      if (ray.y > 0.02) return uCamPos.y / ray.y;                   // 看向水面
      return 55.0;                                                   // 近水平: 中等光程
    }

    void main() {
      vec2 uv = vUv;
      vec3 c;
      if (uOn > 0.5) {
        uv += vec2(sin(uv.y * 16.0 + uTime * 1.2), cos(uv.x * 13.0 + uTime * 0.95)) * 0.0014;
        c = texture2D(tDiffuse, uv).rgb;
        float dist = clamp(waterPath(vUv * 2.0 - 1.0), 4.0, 160.0);
        vec3 trans = exp(-uAbsorb * dist);                        // 透射: 波长选择性衰减
        vec3 inscat = uScatter * (1.0 - exp(-uScatterK * dist));  // 散射: 水色回落
        c = c * trans + inscat;
        float r = length((vUv - 0.5) * vec2(uAspect, 1.0));
        c *= mix(vec3(1.0), vec3(0.68, 0.9, 1.05), smoothstep(0.4, 0.98, r));
      } else {
        c = texture2D(tDiffuse, uv).rgb;
      }
      gl_FragColor = vec4(c, 1.0);
    }`,
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

/** 柔圆点贴图(扩散粒子用, 真实海面上比裸方点柔和) */
function makeSoftDotTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- 精细垃圾 3D 模型（物理材质程序化建模, GLB 缺失时的保底） ----------
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

/** 证据浮牌: 真实标注图贴到发光板面 */
function makeEvidenceBoard(url: string, code: string): Promise<THREE.Group> {
  const group = new THREE.Group();
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(5.6, 4.2, 0.18),
    new THREE.MeshBasicMaterial({ color: 0x0a3550 }),
  );
  group.add(frame);
  const glowGeo = new THREE.PlaneGeometry(5.2, 3.8);
  const mat = new THREE.MeshBasicMaterial({ color: 0x123c58, toneMapped: false });
  const photo = new THREE.Mesh(glowGeo, mat);
  photo.position.z = 0.12;
  group.add(photo);
  const texLoader = new THREE.TextureLoader();
  texLoader.setCrossOrigin('anonymous');
  texLoader.load(
    url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
    },
    undefined,
    () => undefined,
  );
  void code;
  return Promise.resolve(group);
}

interface GarbageItem {
  model: THREE.Group;
  bornAt: number;
  marker?: THREE.Mesh;
  floorY: number;
  landed?: boolean;
  vx: number; vz: number;
  spin: THREE.Vector3;
  impactFired: boolean;
  key: string;
}

interface Gull {
  group: THREE.Group;
  wings: [THREE.Mesh, THREE.Mesh];
  radius: number; speed: number; phase: number; height: number;
}

interface SiteBuoy {
  group: THREE.Group;
  baseY: number;
  phase: number;
  floating: boolean;
  lamp: THREE.MeshStandardMaterial;
  siteId: number;
}

interface PoiItem {
  poi: KnowledgePoi;
  group: THREE.Group;
  hit: THREE.Mesh;
  glow: THREE.Sprite;
  baseY: number;
  seed: number;
  collected: boolean;
}

interface AlertFx {
  mesh: THREE.Mesh;
  born: number;
  life: number;
  maxScale: number;
}

interface Ripple {
  mesh: THREE.Mesh;
  born: number;
}

export class OceanWorld {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  // 第一人称自由探索(游戏式): 拖拽转视角 + WASD移动 + 滚轮前进 + Q/E升降
  private fpYaw = 0;
  private fpPitch = -0.08;
  private fpKeys = new Set<string>();
  private fpDragging = false;
  private fpLast = { x: 0, y: 0 };
  private camGoal: { pos: THREE.Vector3; yaw: number; pitch: number } | null = null;
  private tmpDir = new THREE.Vector3();
  private lastRenderMs = 0;
  private readonly targetFrameMs = 1000 / 30;
  private clock = new THREE.Clock();
  private raf = 0;
  private resizeOb: ResizeObserver;
  private pickPlane: THREE.Mesh;
  private scanRing?: THREE.Mesh;
  private composer?: EffectComposer;
  private bloomPass?: UnrealBloomPass;
  private fxPass?: ShaderPass;
  private gltfLoader = new GLTFLoader();
  private hemi!: THREE.HemisphereLight;
  private garbageModelCache: Record<string, THREE.Group> = {};
  private wasUnderwater = false;

  // 真实感水面要素
  private water?: Water;
  private sky?: Sky;
  private envRT?: THREE.WebGLRenderTarget;
  private waterNormals?: THREE.Texture;

  // 水下世界(地形/生态/氛围)
  private underwater: UnderwaterWorld;
  private coastline?: THREE.Group;
  private rov?: RovUnit;
  private activeSiteId: number | null = null;
  private globe?: EarthGlobe;
  private globeTravelStationId: number | null = null;
  private rovScratch = new THREE.Vector3();

  private siteGroup = new THREE.Group();
  private siteData: SiteVisual[] = [];
  private siteBuoys: SiteBuoy[] = [];
  private hitSpheres: THREE.Mesh[] = [];
  private pulseRings: Array<{ ring: THREE.Mesh; phase: number }> = [];

  private diffusionPoints?: THREE.Points;
  private diffusion?: { result: DiffusionResult; origin: THREE.Vector3 };
  private garbage: GarbageItem[] = [];
  private garbageGroup = new THREE.Group();
  private ripples: Ripple[] = [];
  private gulls: Gull[] = [];
  private stories: Array<{ story: GarbageStory; born: number; key: string }> = [];

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private downPos = { x: 0, y: 0 };
  private clickMode: 'site' | 'water' = 'site';
  private _onRemove: () => void;
  private garbageKey = 'bag';

  // 实时检测联动叠加层(上传任务驱动场景) + 科普知识漂流瓶 + 告警特效
  private liveTask?: LiveTaskOverlay;
  private poiGroup = new THREE.Group();
  private poiItems: PoiItem[] = [];
  private poiHits: THREE.Mesh[] = [];
  private alertFx: AlertFx[] = [];


  // 环境系统(昼夜/天气) + 水下状态 + 双击疾跑
  private env?: EnvironmentController;
  private underwaterState = false;
  private sprintKeys = new Set<string>();
  private lastTapAt: Record<string, number> = {};

  constructor(private container: HTMLElement, private handlers: OceanHandlers) {
    // 30 FPS + 1.25 DPR: 保持海底细节的同时避免显卡持续满载/风扇高转
    this.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.56;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(70, container.clientWidth / Math.max(1, container.clientHeight), 1, 20000);
    this.camera.position.set(0, 2.5, 50);

    // 视角朝向初始值(从默认相机姿态推导)
    {
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.fpYaw = e.y;
      this.fpPitch = e.x;
    }
    const cvs = this.renderer.domElement;
    cvs.addEventListener('pointerdown', this.onFpDown);
    window.addEventListener('pointermove', this.onFpMove);
    window.addEventListener('pointerup', this.onFpUp);
    window.addEventListener('keydown', this.onFpKeyDown);
    window.addEventListener('keyup', this.onFpKeyUp);
    cvs.addEventListener('wheel', this.onFpWheel, { passive: false });

    // ---------- 光照: 太阳 + 天空环境(PBR 反射来自 Sky 烘焙) ----------
    const sunLight = new THREE.DirectionalLight(0xfff1dc, 2.6);
    sunLight.position.copy(SUN_DIR).multiplyScalar(600);
    this.scene.add(sunLight);
    this.hemi = new THREE.HemisphereLight(0xbfe3ff, 0x0c2a33, 0.55);
    this.scene.add(this.hemi);

    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    const skyU = this.sky.material.uniforms;
    skyU.turbidity.value = 3.2;
    skyU.rayleigh.value = 2.6;
    skyU.mieCoefficient.value = 0.004;
    skyU.mieDirectionalG.value = 0.85;
    skyU.sunPosition.value.copy(SUN_DIR);
    this.scene.add(this.sky);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(this.sky);
    this.envRT = pmrem.fromScene(envScene, 0, 0.1, 20000);
    this.scene.environment = this.envRT.texture;
    this.scene.add(this.sky); // 归还主场景
    pmrem.dispose();

    // ---------- 真实感水面(Water 波浪反射) ----------
    const texLoader = new THREE.TextureLoader();
    this.waterNormals = texLoader.load('textures/waternormals.jpg', (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    });
    this.water = new Water(new THREE.PlaneGeometry(4000, 4000), {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: this.waterNormals,
      sunDirection: SUN_DIR.clone(),
      sunColor: 0xffffff,
      waterColor: 0x0e4a56,
      distortionScale: 2.6,
      fog: true,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.scene.add(this.water);

    // 声呐扫描环(数据叠加层, 周期扩散)
    const scanGeo = new THREE.RingGeometry(0.96, 1, 72);
    scanGeo.rotateX(-Math.PI / 2);
    this.scanRing = new THREE.Mesh(scanGeo, new THREE.MeshBasicMaterial({
      color: 0x27dafa, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.scanRing.position.y = 0.25;
    this.scene.add(this.scanRing);

    // ---------- 后处理: 水下辉光 + 水下光吸收/散射(默认 RT, 无需深度纹理) ----------
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight), 0.7, 0.45, 0.62);
    this.bloomPass.enabled = false;
    this.composer.addPass(this.bloomPass);
    this.fxPass = new ShaderPass(UnderwaterShader);
    this.composer.addPass(this.fxPass);
    this.composer.addPass(new OutputPass());

    // ---------- 水下世界(地形 + 生态 + 氛围) ----------
    this.underwater = new UnderwaterWorld(this.scene, SUN_DIR, () => this.repositionSites());
    // 初始视觉(水面模式): 雾+曝光由 applyDepthVisuals 按深度自动切换
    this.scene.fog = new THREE.FogExp2(0xd7e9f0, 0.00045);

    // ---------- 环境系统(昼夜/天气, 接管光照/天空/水色/雾/荧光) ----------
    const sunLightRef = this.scene.children.find(
      (c): c is THREE.DirectionalLight => (c as THREE.DirectionalLight).isDirectionalLight,
    ) as THREE.DirectionalLight | undefined;
    if (sunLightRef && this.sky && this.water) {
      this.env = new EnvironmentController(
        this.scene, sunLightRef, this.hemi, this.sky, this.water, this.renderer,
        (k) => this.underwater.setPlanktonGlow(k),
      );
    }
    if (!this.rov) this.rov = new RovUnit(this.scene, this.camera);

    this.underwater.addEmitter(() => {
      if (!this.isUnderwater || !this.rov) return null;
      return this.rov.getWorldPosition(this.rovScratch);
    }, 12);

    // 外部真实模型预载（models/garbage_*.glb 存在则自动替换程序化模型）
    this.preloadExternalModels();

    const pickGeo = new THREE.PlaneGeometry(8000, 8000);
    pickGeo.rotateX(-Math.PI / 2);
    this.pickPlane = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ visible: false }));
    this.scene.add(this.pickPlane);

    this.scene.add(this.siteGroup, this.garbageGroup, this.poiGroup);
    this.buildRipples();
    this.buildGulls();
    void loadCoastline(this.scene, 'data/zhoushan_coastline.json').then((g) => { this.coastline = g ?? undefined; });
    // 统一海洋: 初始视觉由 animate 中的 applyDepthVisuals 处理

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
      this.composer?.setSize(w, h);
      if (this.fxPass) this.fxPass.uniforms.uAspect.value = w / h;
    });
    this.resizeOb.observe(container);
    if (this.fxPass) this.fxPass.uniforms.uAspect.value = Math.max(0.5, container.clientWidth / Math.max(1, container.clientHeight));

    this.animate = this.animate.bind(this);
    this.animate();
  }
  // ---------- 视角切换 ----------
  /**
   * 水面/水下视觉切换: 滞后带避免贴水面来回跳变——
   * 下潜越过 -1.8 才入水, 上浮越过 -0.7 才出水, 中间为缓冲带。
   */
  private applyDepthVisuals(): void {
    const y = this.camera.position.y;
    if (this.wasUnderwater) {
      if (y > -0.7) this.wasUnderwater = false;
    } else if (y < -1.8) {
      this.wasUnderwater = true;
    }
    this.underwaterState = this.wasUnderwater;
    const underwater = this.wasUnderwater;
    if (this.water) this.water.visible = !underwater;
    if (this.sky) this.sky.visible = !underwater;
    if (this.coastline) this.coastline.visible = !underwater;
    if (this.scanRing) this.scanRing.visible = !underwater;
    this.underwater.setVisible(underwater);
    for (const g of this.gulls) g.group.visible = !underwater;
    this.rov?.setVisible(underwater);
    if (this.fxPass) this.fxPass.uniforms.uOn.value = underwater ? 1 : 0;
    const envFog = this.env?.surfaceFog;
    if (underwater) {
      // 夜晚水下更暗更深; 曝光/hemi由环境控制器按水下状态接管
      const night = this.env?.isNight ?? false;
      this.scene.fog = new THREE.FogExp2(night ? 0x041523 : 0x0a3548, 0.0035);
      this.scene.background = new THREE.Color(night ? 0x020c14 : 0x062838);
    } else if (envFog) {
      this.scene.fog = new THREE.FogExp2(envFog.color, envFog.density);
      this.scene.background = null;
    } else {
      this.scene.fog = new THREE.FogExp2(0xd7e9f0, 0.00045);
      this.scene.background = null;
    }
  }

  /** 当前是否处于水下视觉态(投放拾取等逻辑用) */
  get isUnderwater(): boolean {
    return this.underwaterState;
  }

  // ---------- 外部真实模型热插拔 ----------
  /** models/garbage_{key}.glb 存在时自动替换程序化模型（下载CC0模型拖入即可, 零代码改动） */
  private preloadExternalModels(): void {
    for (const key of ['bag', 'net', 'bottle', 'can', 'wrapper', 'rope']) {
      this.gltfLoader.load(
        `models/garbage_${key}.glb`,
        (gltf) => { this.garbageModelCache[key] = normalizeModelSize(gltf.scene, 3.4); },
        undefined,
        () => undefined, // 文件不存在(404)静默, 继续用程序化模型
      );
    }
  }

  // ---------- 站点(真实浮标 + 数据光柱 AR 叠加) ----------
  setSites(sites: SiteVisual[]): void {
    this.siteData = sites;
    this.siteGroup.clear();
    this.siteBuoys = [];
    this.hitSpheres = [];
    this.pulseRings = [];
    for (const site of sites) {
      const [x, z] = SITE_LAYOUT[site.id] ?? [0, 0];
      const groundY = Math.max(0, this.underwater.getHeightAt(x, z) ?? 0);
      const floating = groundY <= 0.05;
      const color = colorForIndex(site.pollutionIndex);
      const h = site.pollutionIndex != null ? 2 + site.pollutionIndex * 1.1 : 1.6;
      const group = new THREE.Group();
      group.position.set(x, floating ? 0.15 : groundY, z);

      const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x1c2b36, roughness: 0.6, metalness: 0.3 });
      if (floating) {
        // 监测浮标: 涂色浮体 + 深色吃水带
        const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.15, 1.5, 16), paint);
        hull.position.y = 0.75;
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, 0.45, 16), dark);
        band.position.y = 0.28;
        group.add(hull, band);
      } else {
        // 岛基监测桩
        const base = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.9, 1.0, 18), dark);
        base.position.y = 0.5;
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 1.6, 12), paint);
        pillar.position.y = 1.7;
        group.add(base, pillar);
      }

      // 桅杆 + 信号灯(闪烁)
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, h + 1.6, 8), dark);
      mast.position.y = 1.5 + (h + 1.6) / 2 - 0.8;
      const lampMat = new THREE.MeshStandardMaterial({
        color: 0x0b1520, emissive: new THREE.Color(color), emissiveIntensity: 2, roughness: 0.4,
      });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), lampMat);
      lamp.position.y = mast.position.y + (h + 1.6) / 2 + 0.2;
      group.add(mast, lamp);

      // 数据光柱(AR 叠加层): 污染指数越高柱越高
      const column = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.72, h + 2.4, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending,
          depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      column.position.y = (h + 2.4) / 2 + 0.4;
      group.add(column);

      // 水面/地面脉冲环
      const pulseGeo = new THREE.RingGeometry(4.1, 4.5, 44);
      pulseGeo.rotateX(-Math.PI / 2);
      const pulse = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
      group.userData.siteId = site.id;
      pulse.position.y = 0.15;
      group.add(pulse);
      this.pulseRings.push({ ring: pulse, phase: sites.indexOf(site) * 0.9 });

      const hitGeo = new THREE.SphereGeometry(7);
      const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = Math.max(4, h);
      hit.userData.siteId = site.id;
      group.add(hit);
      this.hitSpheres.push(hit);

      const label = makeLabelSprite(site.code, site.name, color);
      label.position.y = h + 5.2;
      group.add(label);

      // 检测证据浮牌: 该站最近一次检测的真实标注图
      const ev = site.evidence?.find((e) => e.mediaUrl);
      if (ev?.mediaUrl) {
        void makeEvidenceBoard(ev.mediaUrl, site.code).then((board) => {
          board.position.set(4.6, floating ? 2.6 : h + 1.6, 0);
          board.rotation.y = -0.5;
          group.add(board);
        });
      }

      this.siteGroup.add(group);
      this.siteBuoys.push({ group, baseY: group.position.y, phase: sites.indexOf(site) * 1.7, floating, lamp: lampMat, siteId: site.id });
    }
  }

  /** 地形就绪后站点贴地/贴水 */
  private repositionSites(): void {
    for (const b of this.siteBuoys) {
      const h = this.underwater.getHeightAt(b.group.position.x, b.group.position.z);
      if (h == null) continue;
      b.baseY = Math.max(0.15, h);
    }
  }

  focusSite(siteId: number): void {
    const [x, z] = SITE_LAYOUT[siteId] ?? [0, 0];
    // 平滑飞到站点上空海面视角(不再一头扎进水下): 俯角看向浮标
    const pos = new THREE.Vector3(x, 9.5, z + 26);
    const dir = new THREE.Vector3(x, 1.2, z).sub(pos);
    const yaw = Math.atan2(-dir.x, -dir.z);
    const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
    this.camGoal = { pos, yaw, pitch };
  }
  setActiveSite(siteId: number | null): void {
    this.activeSiteId = siteId;
    this.siteGroup.traverse((object) => {
      const id = object.userData.siteId as number | undefined;
      if (id != null) object.visible = siteId == null || id === siteId;
    });
  }

  switchToSite(siteId: number): void {
    this.setActiveSite(siteId);
    this.focusSite(siteId);
    this.wasUnderwater = false;
    this.underwaterState = false;
  }

  showGlobe(stations: GlobeStation[]): void {
    if (!this.globe) {
      this.globe = new EarthGlobe(this.scene, stations, (station) => {
        this.globeTravelStationId = station.id;
        this.handlers.onGlobeSelect?.(station);
      });
    } else {
      this.globe.setStations(stations);
    }
    this.globe.show(this.camera);
    this.globeTravelStationId = null;
    if (this.water) this.water.visible = false;
    if (this.sky) this.sky.visible = false;
    if (this.coastline) this.coastline.visible = false;
    this.siteGroup.visible = false;
    this.scene.fog = null;
  }

  private hideGlobe(): void {
    this.globe?.hide();
    if (this.water) this.water.visible = true;
    if (this.sky) this.sky.visible = true;
    if (this.coastline) this.coastline.visible = true;
    this.siteGroup.visible = true;
    this.applyDepthVisuals();
  }

  travelGlobeToSite(siteId: number): boolean {
    const station = this.globe?.travelTo(siteId);
    if (!station) return false;
    this.globeTravelStationId = station.id;
    this.handlers.onGlobeSelect?.(station);
    return true;
  }

  private updateGlobe(dt: number, t: number): void {
    if (!this.globe?.isVisible) return;
    if (!this.globe.update(dt, t, this.camera)) return;
    const stationId = this.globeTravelStationId;
    this.hideGlobe();
    if (stationId != null) this.handlers.onGlobeEnter?.(stationId);
    this.globeTravelStationId = null;
  }

  // ---------- 环境系统(昼夜/天气) ----------
  setEnvTime(mode: TimeMode): void { this.env?.setTime(mode); }

  setEnvWeather(mode: WeatherMode): void { this.env?.setWeather(mode); }

  /** auto 模式当前时段标签(页面HUD轮询) */
  get envPhaseLabel(): string { return this.env?.autoPhaseLabel ?? ''; }

  // ---------- 扩散推演 ----------
  setDiffusion(result: DiffusionResult, originSiteId: number): void {
    this.clearDiffusion();
    const [ox, oz] = SITE_LAYOUT[originSiteId] ?? [0, 0];
    const origin = new THREE.Vector3(ox, 0.5, oz);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.nParticles * 3), 3));
    const mat = new THREE.PointsMaterial({
      color: 0xff7043, size: 2.0, map: makeSoftDotTexture(), transparent: true, opacity: 0.95,
      depthWrite: false, sizeAttenuation: true,
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

  // ---------- 实时检测联动(上传的检测任务实时驱动场景) ----------
  /** 开始一次联动: 站点上方升起检测屏, 任务ROV出发巡航 */
  startLiveTask(siteId: number, siteCode: string): void {
    this.clearLiveTask();
    const [x, z] = SITE_LAYOUT[siteId] ?? [0, 0];
    const groundY = Math.max(0, this.underwater.getHeightAt(x, z) ?? 0);
    const pos = new THREE.Vector3(x, groundY > 0.05 ? groundY : 0.15, z);
    this.liveTask = new LiveTaskOverlay(this.scene, pos, siteCode, (px, pz) => this.underwater.getHeightAt(px, pz));
  }

  updateLiveTaskProgress(p: LiveProgress): void { this.liveTask?.setProgress(p); }

  /** 检测屏画面: 视频模式传后端标注帧URL; 图片模式传本地预览URL+归一化检测框 */
  showLiveTaskFrame(url: string, boxes?: LiveFrameBox[]): void { this.liveTask?.setFrame(url, boxes); }

  /** 喂入检出目标(逐个弹出标签标记) */
  feedLiveTaskTargets(items: LiveTargetItem[]): void { this.liveTask?.feedTargets(items); }

  finishLiveTask(summary: string): void { this.liveTask?.finish(summary); }

  clearLiveTask(): void {
    this.liveTask?.dispose();
    this.liveTask = undefined;
  }

  // ---------- 污染告警特效(扩散红环+竖直告警光束, 页面驱动声音与语音) ----------
  triggerAlert(siteId: number): void {
    const [x, z] = SITE_LAYOUT[siteId] ?? [0, 0];
    const t = this.clock.getElapsedTime();
    for (let i = 0; i < 3; i++) {
      const geo = new THREE.RingGeometry(0.96, 1, 72);
      geo.rotateX(-Math.PI / 2);
      const ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xff4d5e, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false,
      }));
      ring.position.set(x, 0.32 + i * 0.06, z);
      ring.scale.setScalar(0.01);
      this.scene.add(ring);
      this.alertFx.push({ mesh: ring, born: t + i * 0.5, life: 1.8, maxScale: 34 });
    }
    const beamGeo = new THREE.CylinderGeometry(1.1, 1.6, 34, 12, 1, true);
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: 0xff4d5e, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    beam.position.set(x, 17, z);
    this.scene.add(beam);
    this.alertFx.push({ mesh: beam, born: t, life: 4.5, maxScale: 1 });
  }

  private updateAlertFx(t: number): void {
    for (let i = this.alertFx.length - 1; i >= 0; i--) {
      const fx = this.alertFx[i];
      const age = t - fx.born;
      if (age < 0) continue;
      if (age > fx.life) {
        this.scene.remove(fx.mesh);
        fx.mesh.geometry.dispose();
        (fx.mesh.material as THREE.Material).dispose();
        this.alertFx.splice(i, 1);
        continue;
      }
      const f = age / fx.life;
      const mat = fx.mesh.material as THREE.MeshBasicMaterial;
      if (fx.maxScale > 1) {
        // 扩散环: 快出慢收
        fx.mesh.scale.setScalar(1 + f * fx.maxScale);
        mat.opacity = 0.85 * (1 - f);
      } else {
        // 告警光束: 呼吸闪烁后消隐
        mat.opacity = 0.2 * (1 - f) * (0.6 + Math.sin(t * 6) * 0.4);
      }
    }
  }

  // ---------- 科普知识漂流瓶 ----------
  setKnowledgePOIs(pois: KnowledgePoi[], collected: string[]): void {
    this.clearKnowledgePOIs();
    for (const poi of pois) {
      const isCollected = collected.includes(poi.id);
      const color = isCollected ? 0x54f1a9 : 0xffd76a;
      const floorY = this.underwater.getHeightAt(poi.x, poi.z) ?? -8;
      const y = poi.layer === 'surface' ? 0.55
        : poi.layer === 'mid' ? Math.max(floorY + 1.8, -4.2)
          : Math.min(floorY, -0.8) + 1.15;
      const group = new THREE.Group();
      const glass = new THREE.MeshStandardMaterial({
        color, roughness: 0.25, metalness: 0.05,
        emissive: color, emissiveIntensity: 0.5, transparent: true, opacity: 0.92,
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 1.0, 12), glass);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.32, 0.42, 10), glass);
      neck.position.y = 0.68;
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.21, 0.21, 0.16, 10),
        new THREE.MeshStandardMaterial({ color: 0x1c2b36, roughness: 0.5 }),
      );
      cap.position.y = 0.95;
      const scroll = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.13, 0.74, 8),
        new THREE.MeshStandardMaterial({ color: 0xf5efe0, roughness: 0.9 }),
      );
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeSoftDotTexture(), color, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.scale.setScalar(3.4);
      group.add(body, neck, cap, scroll, glow);
      group.position.set(poi.x, y, poi.z);
      this.poiGroup.add(group);

      const hit = new THREE.Mesh(new THREE.SphereGeometry(3.4), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.copy(group.position);
      hit.userData.poiId = poi.id;
      this.poiGroup.add(hit);

      this.poiItems.push({ poi, group, hit, glow, baseY: y, seed: Math.random() * Math.PI * 2, collected: isCollected });
      this.poiHits.push(hit);
    }
  }

  markPoiCollected(id: string): void {
    const item = this.poiItems.find((p) => p.poi.id === id);
    if (!item || item.collected) return;
    item.collected = true;
    item.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (mat && mat.emissive) {
        mat.color.setHex(0x54f1a9);
        mat.emissive.setHex(0x54f1a9);
      }
    });
    (item.glow.material as THREE.SpriteMaterial).color.setHex(0x54f1a9);
  }

  private clearKnowledgePOIs(): void {
    for (const item of this.poiItems) {
      item.group.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
        (mesh.material as THREE.Material | undefined)?.dispose();
      });
      item.hit.geometry.dispose();
      (item.hit.material as THREE.Material).dispose();
      this.poiGroup.remove(item.group, item.hit);
    }
    this.poiItems = [];
    this.poiHits = [];
  }


  // ---------- 科普投放（漂浮 → 沉降至海底驻留, 污染持续） ----------
  setGarbageKey(key: string): void { this.garbageKey = key; }

  dropGarbage(point: THREE.Vector3, key: string, _color: string): void {
    // 每次投放一条独立且持久的污染叙事; 超过10条时清最早的
    const floorY = Math.min(this.underwater.getHeightAt(point.x, point.z) ?? -6, -0.8);
    this.stories.push({ story: new GarbageStory(this.scene, point, key, floorY), born: this.clock.getElapsedTime(), key });
    if (this.stories.length > 10) {
      const oldest = this.stories.shift();
      oldest?.story.dispose();
      this.removeGarbageModel(oldest?.key);
    }
    // 外部GLB缓存必须clone——同一Object3D不能同时挂在两处
    const cached = this.garbageModelCache[key];
    const model = cached ? cached.clone(true) : makeGarbageModel(key);
    model.position.set(point.x, 0.3, point.z);
    this.garbageGroup.add(model);
    this.garbage.push({
      model, bornAt: this.clock.getElapsedTime(), floorY,
      vx: 0.55 + Math.random() * 0.3, vz: -0.18,
      spin: new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.8),
      impactFired: false, key,
    });
    this.spawnRipple(point.x, point.z);
  }

  /** 当前活跃污染(页面水质指标/污染列表轮询) */
  getActiveGarbage(): Array<{ key: string; age: number }> {
    const t = this.clock.getElapsedTime();
    return this.stories.map((s) => ({ key: s.key, age: t - s.born }));
  }

  /** 清除指定类型最早的一条污染(3D叙事+模型一起移除) */
  removeStoryByKey(key: string): void {
    const idx = this.stories.findIndex((s) => s.key === key);
    if (idx < 0) return;
    this.stories[idx].story.dispose();
    this.stories.splice(idx, 1);
    this.removeGarbageModel(key);
  }

  private removeGarbageModel(key: string | undefined): void {
    if (!key) return;
    const idx = this.garbage.findIndex((g) => g.key === key);
    if (idx < 0) return;
    const item = this.garbage[idx];
    this.garbageGroup.remove(item.model);
    if (item.marker) {
      this.scene.remove(item.marker);
      item.marker.geometry.dispose();
      (item.marker.material as THREE.Material).dispose();
    }
    this.garbage.splice(idx, 1);
  }

  setClickMode(mode: 'site' | 'water'): void {
    this.clickMode = mode;
    this.pickPlane.visible = !this.underwaterState && mode === 'water';
  }

  // ---------- 拾取 ----------
  private pick(e: PointerEvent): void {
    if (this.globe?.isVisible) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.globe.handleClick(e.clientX, e.clientY, this.camera, rect);
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // 科普模式: 知识漂流瓶优先于站点/水面拾取(瓶内是问题, 不触发投放)
    if (this.clickMode === 'water' && this.poiHits.length > 0 && this.handlers.onPoiClick) {
      const poiHits = this.raycaster.intersectObjects(this.poiHits, false);
      if (poiHits.length > 0) {
        const poiId = poiHits[0].object.userData.poiId as string;
        const item = this.poiItems.find((p) => p.poi.id === poiId);
        if (item) { this.handlers.onPoiClick(item.poi); return; }
      }
    }
    const hits = this.raycaster.intersectObjects(this.hitSpheres, false);
    if (hits.length > 0 && this.handlers.onSiteClick) {
      const id = hits[0].object.userData.siteId as number;
      const site = this.siteData.find((s) => s.id === id);
      if (site) { this.handlers.onSiteClick(site); return; }
    }
    if (this.clickMode === 'water' && !this.isUnderwater) {
      const waterHits = this.raycaster.intersectObject(this.pickPlane, false);
      if (waterHits.length > 0 && this.handlers.onWaterClick) this.handlers.onWaterClick(waterHits[0].point);
    }
  }

  // ---------- 海鸥（白色实体, 拍翅滑翔盘旋） ----------
  private buildGulls(): void {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf2f5f7, roughness: 0.8 });
    const wingMat = new THREE.MeshStandardMaterial({ color: 0xe8edef, roughness: 0.85, side: THREE.DoubleSide });
    for (let i = 0; i < 7; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.8, 4, 8).rotateX(Math.PI / 2), bodyMat);
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.5, 6).rotateX(-Math.PI / 2), bodyMat);
      tail.position.z = -0.6;
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8a13c, roughness: 0.6 }));
      beak.position.z = 0.62;
      // 机翼以内侧边为轴, 便于拍打
      const wingL = new THREE.PlaneGeometry(1.45, 0.42).rotateX(-Math.PI / 2).translate(0.75, 0, 0);
      const wingR = new THREE.PlaneGeometry(1.45, 0.42).rotateX(-Math.PI / 2).translate(-0.75, 0, 0);
      const left = new THREE.Mesh(wingL, wingMat);
      left.position.x = -0.14;
      const right = new THREE.Mesh(wingR, wingMat);
      right.position.x = 0.14;
      group.add(body, tail, beak, left, right);
      group.scale.setScalar(1.5);
      this.scene.add(group);
      this.gulls.push({
        group, wings: [left, right],
        radius: 38 + (i % 4) * 16, speed: 0.12 + (i % 3) * 0.05,
        phase: (i / 7) * Math.PI * 2, height: 24 + (i % 5) * 4,
      });
    }
  }

  private updateGulls(t: number): void {
    for (const g of this.gulls) {
      const a = t * g.speed + g.phase;
      g.group.position.set(Math.cos(a) * g.radius, g.height + Math.sin(t * 0.7 + g.phase) * 1.6, Math.sin(a) * g.radius);
      g.group.rotation.y = -a + Math.PI / 2; // 切向飞行
      g.group.rotation.z = Math.sin(t * 0.9 + g.phase) * 0.12; // 盘旋侧倾
      const flap = Math.sin(t * 5 + g.phase * 3) * 0.55;
      g.wings[0].rotation.z = flap;
      g.wings[1].rotation.z = -flap;
    }
  }

  // ---------- 投放涟漪（水面反馈） ----------
  private buildRipples(): void {
    for (let i = 0; i < 6; i++) {
      const geo = new THREE.RingGeometry(0.92, 1, 48);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xd9f2ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
      }));
      mesh.position.y = 0.2;
      mesh.visible = false;
      this.scene.add(mesh);
      this.ripples.push({ mesh, born: -10 });
    }
  }

  private spawnRipple(x: number, z: number): void {
    const r = this.ripples.reduce((a, b) => (a.born < b.born ? a : b));
    r.born = this.clock.getElapsedTime();
    r.mesh.position.set(x, 0.2, z);
    r.mesh.visible = true;
  }

  private updateRipples(t: number): void {
    for (const r of this.ripples) {
      const age = t - r.born;
      if (age < 0 || age > 1.8) { r.mesh.visible = false; continue; }
      const f = age / 1.8;
      r.mesh.scale.setScalar(1 + f * 9);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - f);
    }
  }


  private animate(): void {
    this.raf = requestAnimationFrame(this.animate);
    // 30fps 帧率限幅: 避免显卡持续满载
    const now = performance.now();
    if (now - this.lastRenderMs < this.targetFrameMs) return;
    this.lastRenderMs = now;
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.getElapsedTime();
    if (this.globe?.isVisible) {
      this.updateGlobe(dt, t);
      if (this.composer) this.composer.render();
      else this.renderer.render(this.scene, this.camera);
      return;
    }
    this.applyDepthVisuals();
    const underwater = this.underwaterState;
    this.env?.update(dt, t, this.camera, underwater);
    this.env?.applyVisibility(t, underwater);

    for (const st of this.stories) st.story.update(dt);

    // 实时检测联动叠加层 / 告警特效 / 知识漂流瓶浮动
    this.liveTask?.update(dt, t, this.camera);
    this.updateAlertFx(t);
    for (const p of this.poiItems) {
      p.group.position.y = p.baseY + Math.sin(t * 1.2 + p.seed) * 0.18;
      p.group.rotation.y += dt * 0.55;
    }

    if (underwater) {
      this.rov?.update(dt, t);
      this.underwater.update(dt, t, this.stories.length ? this.stories[this.stories.length - 1].story.getPollution() : null);
      this.underwater.faceShaftsTo(this.camera);
      if (this.fxPass) {
        this.fxPass.uniforms.uTime.value = t;
        // 视线光程需相机实时位姿
        const u = this.fxPass.uniforms;
        (u.uCamPos.value as THREE.Vector3).copy(this.camera.position);
        this.camera.updateMatrixWorld();
        (u.uCamFwd.value as THREE.Vector3).setFromMatrixColumn(this.camera.matrixWorld, 2).negate().normalize();
        (u.uCamRight.value as THREE.Vector3).setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
        (u.uCamUp.value as THREE.Vector3).setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
        u.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
        // 活跃污染越多, 水体越浑浊(散射系数实时抬升)
        u.uScatterK.value = 0.014 + Math.min(6, this.stories.length) * 0.0012;
      }
    } else {
      this.updateGulls(t);
      if (this.water) (this.water.material as THREE.ShaderMaterial).uniforms.time.value += dt * 0.55;
    }

    // 声呐扫描环周期扩散
    if (this.scanRing && this.scanRing.visible) {
      const f = (t % 5) / 5;
      this.scanRing.scale.setScalar(1 + f * 88);
      (this.scanRing.material as THREE.MeshBasicMaterial).opacity = 0.42 * (1 - f);
    }

    for (const { ring, phase } of this.pulseRings) {
      const f = (t * 0.55 + phase) % 1;
      ring.scale.setScalar(1 + f * 1.6);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - f);
    }

    // 浮标随浪起伏 + 信号灯呼吸闪烁
    for (const b of this.siteBuoys) {
      if (b.floating) b.group.position.y = b.baseY + Math.sin(t * 1.05 + b.phase) * 0.14;
      b.lamp.emissiveIntensity = 1.6 + Math.sin(t * 2.6 + b.phase) * 1.3;
    }

    this.updateRipples(t);

    // 垃圾: 漂浮自旋 → 3.5s后下沉 → 落到海底驻留(污染持续, 由用户或上限清理)
    for (const g of this.garbage) {
      const age = t - g.bornAt;
      const settled = g.model.position.y <= g.floorY + 0.28;
      if (age < 3.5) {
        // 漂浮期: 随波漂移 + 自旋
        g.model.position.x += g.vx * dt;
        g.model.position.z += g.vz * dt;
        g.model.rotation.x += g.spin.x * dt;
        g.model.rotation.y += g.spin.y * dt;
        g.model.rotation.z += g.spin.z * dt;
        g.model.position.y += Math.sin(t * 1.6 + g.bornAt) * 0.12 * dt;
      } else if (!settled) {
        // 下沉期: 摇摆下沉, 速度随时间加快(深海底也能在合理时间落底)
        g.model.position.y -= dt * Math.min(6, 1.1 + age * 0.18);
        g.model.rotation.z += g.spin.z * 0.6 * dt;
        g.model.rotation.x += g.spin.x * 0.4 * dt;
      } else if (!g.landed) {
        g.landed = true;
        g.model.position.y = g.floorY + 0.22;
        g.model.rotation.x = Math.PI * (Math.random() * 0.2 - 0.1);
        // 落底标记: 发光警戒环(科普引导: 在海底找到你投放的垃圾)
        const markerGeo = new THREE.RingGeometry(1.5, 2.2, 32);
        markerGeo.rotateX(-Math.PI / 2);
        const marker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({
          color: 0xff6f91, transparent: true, opacity: 0.7,
          side: THREE.DoubleSide, depthWrite: false,
          blending: THREE.AdditiveBlending,
        }));
        marker.position.set(g.model.position.x, g.floorY + 0.05, g.model.position.z);
        this.scene.add(marker);
        g.marker = marker;
      }
      // 落底标记脉冲动画
      if (g.marker) {
        const pulse = 1 + Math.sin(t * 3 + age) * 0.3;
        g.marker.scale.setScalar(pulse);
        (g.marker.material as THREE.MeshBasicMaterial).opacity = 0.4 + Math.sin(t * 3 + age) * 0.3;
      }
      if (!g.impactFired && age > 2.2) {
        g.impactFired = true;
        this.handlers.onGarbageImpact?.(g.key);
      }
    }
    this.updateFirstPerson(dt);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** 科普时间加速叙事状态(页面HUD轮询) */
  getGarbageStoryState(): GarbageStoryState {
    const latest = this.stories[this.stories.length - 1];
    if (latest && this.clock.getElapsedTime() - latest.born < 15.5) return latest.story.getState();
    return { active: false, year: 0, stage: -1, stageLabel: '', degradationYears: 0 };
  }

  // ---------- 第一人称自由探索 ----------
  private onFpDown = (e: PointerEvent): void => {
    if (e.target === this.renderer.domElement && e.button === 0) {
      this.fpDragging = true;
      this.fpLast = { x: e.clientX, y: e.clientY };
    }
  };
  private onFpMove = (e: PointerEvent): void => {
    if (!this.fpDragging) return;
    const dx = e.clientX - this.fpLast.x;
    const dy = e.clientY - this.fpLast.y;
    if (this.globe?.isVisible) this.globe.rotate(dx, dy);
    else {
      this.fpYaw -= dx * 0.0024;
      this.fpPitch = THREE.MathUtils.clamp(this.fpPitch - dy * 0.0024, -1.55, 1.55);
    }
    this.fpLast = { x: e.clientX, y: e.clientY };
  };
  private onFpUp = (): void => { this.fpDragging = false; };
  private onFpKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || e.code.startsWith('F')) return;
    this.fpKeys.add(e.code);
    // 双击移动键(320ms内) → 疾跑, 按住期间生效
    const MOVE_CODES: Record<string, true> = {
      KeyW: true, KeyA: true, KeyS: true, KeyD: true,
      ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true,
    };
    if (MOVE_CODES[e.code]) {
      const now = performance.now();
      if (now - (this.lastTapAt[e.code] ?? -1e9) < 320) this.sprintKeys.add(e.code);
      this.lastTapAt[e.code] = now;
    }
  };
  private onFpKeyUp = (e: KeyboardEvent): void => {
    this.fpKeys.delete(e.code);
    this.sprintKeys.delete(e.code);
  };
  private onFpWheel = (e: WheelEvent): void => {
    if (e.target !== this.renderer.domElement) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 4.5 : -4.5;
    this.camera.getWorldDirection(this.tmpDir);
    this.camera.position.addScaledVector(this.tmpDir, step);
  };

  private updateFirstPerson(dt: number): void {
    // 站点聚焦飞行: 平滑插值到目标位姿, 手动操作立即接管
    if (this.camGoal) {
      this.camera.position.lerp(this.camGoal.pos, Math.min(1, 2.6 * dt));
      this.fpYaw += (this.camGoal.yaw - this.fpYaw) * Math.min(1, 2.6 * dt);
      this.fpPitch += (this.camGoal.pitch - this.fpPitch) * Math.min(1, 2.6 * dt);
      if (this.camera.position.distanceTo(this.camGoal.pos) < 0.5) this.camGoal = null;
    }
    const shiftBoost = this.fpKeys.has('ShiftLeft') || this.fpKeys.has('ShiftRight');
    const sprintBoost = this.sprintKeys.size > 0; // 双击移动键触发的疾跑
    const boost = shiftBoost ? 3.2 : sprintBoost ? 2.4 : 1;
    const speed = 10 * boost;
    const fwd = this.fpKeys.has('KeyW') || this.fpKeys.has('ArrowUp') ? 1 : this.fpKeys.has('KeyS') || this.fpKeys.has('ArrowDown') ? -1 : 0;
    const side = this.fpKeys.has('KeyD') || this.fpKeys.has('ArrowRight') ? 1 : this.fpKeys.has('KeyA') || this.fpKeys.has('ArrowLeft') ? -1 : 0;
    const vert = this.fpKeys.has('KeyE') || this.fpKeys.has('Space') ? 1 : this.fpKeys.has('KeyQ') ? -1 : 0;
    if (fwd || side || vert) {
      this.camGoal = null;
      this.camera.getWorldDirection(this.tmpDir);
      const right = new THREE.Vector3().crossVectors(this.tmpDir, this.camera.up).normalize();
      this.camera.position.addScaledVector(this.tmpDir, fwd * speed * dt);
      this.camera.position.addScaledVector(right, side * speed * dt);
      this.camera.position.y += vert * speed * dt;
    }
    // 视角约束: 水下不穿海床/不出水, 水面之上不穿水
    // 统一海洋: 相机可从高空(+30)到海床(floor+0.5)自由垂直移动
    const floor = this.underwater.getHeightAt(this.camera.position.x, this.camera.position.z) ?? -8;
    this.camera.position.y = THREE.MathUtils.clamp(this.camera.position.y, floor + 0.5, 30);
    const r = Math.hypot(this.camera.position.x, this.camera.position.z);
    this.globe?.dispose();
    if (r > 480) this.camera.position.multiplyScalar(480 / r);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.fpPitch, this.fpYaw, 0, 'YXZ'));
  }


  dispose(): void {
    this.globe?.dispose();
    cancelAnimationFrame(this.raf);
    this.env?.dispose();
    this.clearLiveTask();
    this.clearKnowledgePOIs();
    for (const fx of this.alertFx) {
      this.scene.remove(fx.mesh);
      fx.mesh.geometry.dispose();
      (fx.mesh.material as THREE.Material).dispose();
    }
    this.alertFx = [];
    this.stories.forEach((st) => st.story.dispose());
    this.stories = [];
    this.rov?.dispose();
    this.underwater.dispose();
    this.resizeOb.disconnect();
    const cvs0 = this.renderer.domElement;
    cvs0.removeEventListener('pointerdown', this.onFpDown);
    window.removeEventListener('pointermove', this.onFpMove);
    window.removeEventListener('pointerup', this.onFpUp);
    window.removeEventListener('keydown', this.onFpKeyDown);
    window.removeEventListener('keyup', this.onFpKeyUp);
    cvs0.removeEventListener('wheel', this.onFpWheel);
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
    this.waterNormals?.dispose();
    this.envRT?.dispose();
    this.composer?.dispose();
    this._onRemove();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
