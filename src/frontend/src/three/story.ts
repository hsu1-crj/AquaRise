/**
 * Ocean3D 叙事模块 —— 时间加速危害演示 + 虚拟ROV数字孪生 + 真实岸线。
 *
 * GarbageStory: 科普模式"时间加速器"。投放垃圾后时间以年计快进,
 *   四阶段可视化真实破坏过程: 漂浮迁移 → 破碎解体 → 微塑料扩散(污染云/浑浊带/死鱼) → 长期滞留。
 * RovUnit: 虚拟水下机器人 + 监视屏(播放本系统真实标注检测视频 media/rov_feed.mp4),
 *   数字孪生的"作业载体": 3D世界与真实检测产物的桥。
 * loadCoastline: 舟山市真实行政岸线(阿里云DataV官方地理边界) → 发光岸线,
 *   与GEBCO测深同一地理坐标窗口对齐。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { impactByKey } from './impactData';

export interface GarbageStoryState {
  active: boolean;
  year: number;
  stage: number; // 0漂浮 1碎裂 2微塑料扩散 3长期滞留
  stageLabel: string;
  degradationYears: number;
}

/** 外部GLB模型归一化: 包围盒缩放到目标尺寸并居中(模型来源各异, 统一比例) */
export function normalizeModelSize(model: THREE.Object3D, targetSize: number): THREE.Group {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const k = targetSize / maxDim;
  model.scale.setScalar(k);
  const center = new THREE.Vector3();
  box.getCenter(center);
  model.position.sub(center.multiplyScalar(k));
  const wrap = new THREE.Group();
  wrap.add(model);
  return wrap;
}

const STAGE_LABELS = [
  '第1阶段 · 漂浮迁移：随流漂散，威胁沿线生物',
  '第2阶段 · 破理解体：紫外线与波浪作用下碎裂',
  '第3阶段 · 微塑料扩散：进入水体与食物链，鱼类受害',
  '长期滞留 · 数十年尺度存续，持续释放污染',
];

export function formatStoryYear(year: number): string {
  if (year < 0.083) return `第 ${Math.max(1, Math.round(year * 365))} 天`;
  if (year < 1) return `第 ${(year * 12).toFixed(1)} 个月`;
  return `第 ${year.toFixed(1)} 年`;
}

export class GarbageStory {
  private group = new THREE.Group();
  private fragments: THREE.InstancedMesh;
  private micro: THREE.Points;
  private disc: THREE.Mesh;
  private murky: THREE.Mesh;
  private deadFish: THREE.Group;
  private dummy = new THREE.Object3D();
  private microPos: Float32Array;
  private microDir: Float32Array;
  private age = 0;
  private center: THREE.Vector3;
  private floorY: number;
  private degradationYears: number;
  /** 污染扩散进度 0..1(到1后持续存在, 不再消失) */
  private spreadK = 0;

  constructor(scene: THREE.Scene, center: THREE.Vector3, key: string, floorY: number) {
    this.center = center.clone();
    this.floorY = floorY;
    this.degradationYears = impactByKey(key)?.degradeYears ?? 100;
    scene.add(this.group);

    // 海底碎片(碎裂后的塑料残块, 静态散布在海底)
    const fragGeo = new THREE.TetrahedronGeometry(0.32);
    const fragMat = new THREE.MeshStandardMaterial({ color: 0xd8e6ee, roughness: 0.5, transparent: true, opacity: 0 });
    this.fragments = new THREE.InstancedMesh(fragGeo, fragMat, 26);
    this.fragments.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.fragments);

    // 微塑料云(从海底持续缓漫扩散)
    const N = 240;
    this.microPos = new Float32Array(N * 3);
    this.microDir = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry();
    for (let i = 0; i < N; i++) {
      this.microPos[i * 3] = center.x + (Math.random() - 0.5) * 2;
      this.microPos[i * 3 + 1] = floorY + 0.3 + Math.random() * 2.2;
      this.microPos[i * 3 + 2] = center.z + (Math.random() - 0.5) * 2;
      const a = Math.random() * Math.PI * 2;
      this.microDir[i * 3] = Math.cos(a) * (0.3 + Math.random() * 0.5);
      this.microDir[i * 3 + 1] = (Math.random() - 0.5) * 0.15;
      this.microDir[i * 3 + 2] = Math.sin(a) * (0.3 + Math.random() * 0.5);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.microPos, 3));
    this.micro = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xbfffe0, size: 0.32, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.group.add(this.micro);

    // 水面油污盘(初期短暂出现后消退) + 海底浑浊带(持续存在)
    const discGeo = new THREE.CircleGeometry(1, 40);
    discGeo.rotateX(-Math.PI / 2);
    this.disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
      color: 0x5a6b2f, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.disc.position.set(center.x, 0.12, center.z);
    this.group.add(this.disc);

    this.murky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x465c2c, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.murky.position.set(center.x, floorY + 1.4, center.z);
    this.group.add(this.murky);

    // 受害鱼(周期性翻肚上浮, 持续提示污染致死效应)
    this.deadFish = new THREE.Group();
    const fishGeo = new THREE.ConeGeometry(0.28, 1.2, 6);
    const fishMat = new THREE.MeshStandardMaterial({ color: 0xd9e2e8, roughness: 0.6, transparent: true });
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(fishGeo, fishMat.clone());
      f.rotation.z = Math.PI; // 翻肚
      const a = (i / 3) * Math.PI * 2;
      f.position.set(center.x + Math.cos(a) * 3, floorY + 0.4, center.z + Math.sin(a) * 3);
      f.visible = false;
      f.userData.cycleOffset = i * 2.5;
      f.userData.rising = 0;
      this.deadFish.add(f);
    }
    this.group.add(this.deadFish);
  }

  /** 碎片静态落点(碎裂后撒在海底) */
  private layoutFragments(): void {
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const r = 1.2 + (i % 5) * 0.7;
      this.dummy.position.set(
        this.center.x + Math.cos(a) * r,
        this.floorY + 0.12 + (i % 4) * 0.12,
        this.center.z + Math.sin(a) * r,
      );
      this.dummy.rotation.set(i * 1.7, i * 1.3, i * 0.9);
      this.dummy.scale.setScalar(0.75 + (i % 3) * 0.15);
      this.dummy.updateMatrix();
      this.fragments.setMatrixAt(i, this.dummy.matrix);
    }
    this.fragments.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    this.age += dt;
    const stage = this.stage();
    const fragMat = this.fragments.material as THREE.MeshStandardMaterial;
    const microMat = this.micro.material as THREE.PointsMaterial;
    const discMat = this.disc.material as THREE.MeshBasicMaterial;
    const murkyMat = this.murky.material as THREE.MeshBasicMaterial;
    this.spreadK = Math.min(1, Math.max(this.age - 5, 0) / 9);

    if (stage >= 1) {
      // 碎片散落海底并停留
      const k = Math.min(1, (this.age - 2.5) / 2);
      fragMat.opacity = 0.95 * k;
      if (!this.fragments.userData.laid) {
        this.layoutFragments();
        this.fragments.userData.laid = true;
      }
    }
    if (stage >= 2) {
      // 微塑料缓漫扩散(到上限后停留) + 浑浊带持续脉动
      microMat.opacity = 0.8;
      const move = this.spreadK < 1 ? dt * (0.5 + this.spreadK) : dt * 0.05;
      for (let i = 0; i < this.microPos.length / 3; i++) {
        this.microPos[i * 3] += this.microDir[i * 3] * move;
        this.microPos[i * 3 + 1] += this.microDir[i * 3 + 1] * move;
        this.microPos[i * 3 + 2] += this.microDir[i * 3 + 2] * move;
      }
      (this.micro.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      // 油污盘: 阶段2出现, 8s后消退(漂浮期污染痕迹)
      discMat.opacity = this.age < 8 ? Math.min(0.35, (this.age - 5) * 0.3) : Math.max(0, 0.35 - (this.age - 8) * 0.2);
      this.disc.scale.setScalar(1 + this.spreadK * 10);
      // 浑浊带: 生长到上限后持续存在并轻微脉动
      const pulse = 1 + Math.sin(this.age * 0.8) * 0.06;
      murkyMat.opacity = Math.min(0.24, 0.08 + this.spreadK * 0.2);
      this.murky.scale.setScalar((1 + this.spreadK * 8) * pulse);
      // 死鱼: 每 ~8s 一轮, 从污染云翻肚浮起再沉底消失
      for (const f of this.deadFish.children) {
        const m = f as THREE.Mesh;
        const mat = m.material as THREE.MeshStandardMaterial;
        m.userData.cycleOffset += dt;
        if (!m.userData.rising && m.userData.cycleOffset > 8) {
          m.userData.cycleOffset = 0;
          m.userData.rising = 1;
          const a = Math.random() * Math.PI * 2;
          m.position.set(this.center.x + Math.cos(a) * 3, this.floorY + 0.4, this.center.z + Math.sin(a) * 3);
          m.visible = true;
          mat.opacity = 0.95;
        }
        if (m.userData.rising) {
          m.position.y += dt * 0.5;
          m.rotation.y += dt * 0.3;
          if (m.position.y > -1.2) {
            mat.opacity -= dt * 0.5;
            if (mat.opacity <= 0) { m.visible = false; m.userData.rising = 0; }
          }
        }
      }
    }
  }

  private stage(): number {
    if (this.age < 2.5) return 0;
    if (this.age < 5) return 1;
    if (this.age < 9) return 2;
    return 3;
  }

  /** 年份映射: 0-2.5s→0~1月, 2.5-5s→~2年, 5-9s→2~10年, >9s→10年封顶 */
  private yearNow(): number {
    if (this.age < 2.5) return (this.age / 2.5) * (1 / 12);
    if (this.age < 5) return 1 / 12 + ((this.age - 2.5) / 2.5) * (2 - 1 / 12);
    if (this.age < 9) return 2 + ((this.age - 5) / 4) * 8;
    return 10;
  }

  getState(): GarbageStoryState {
    const stage = this.stage();
    return {
      active: true,
      year: this.yearNow(),
      stage,
      stageLabel: stage >= 3 ? STAGE_LABELS[3] : STAGE_LABELS[stage],
      degradationYears: this.degradationYears,
    };
  }

  get key(): string {
    return this.center.x.toFixed(2) + '/' + this.center.z.toFixed(2);
  }

  /** 鱼群规避的污染区（阶段≥2起效, 持续存在） */
  getPollution(): { center: THREE.Vector3; radius: number } | null {
    if (this.stage() < 2) return null;
    return { center: this.center, radius: 4 + this.spreadK * 12 };
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose();
    });
    this.group.removeFromParent();
  }
}

// ---------- 虚拟 ROV(数字孪生作业载体): 本体 + 真实检测视频监视屏 ----------
export class RovUnit {
  private group = new THREE.Group();
  private screen: THREE.Mesh;
  private video: HTMLVideoElement;
  private texture: THREE.VideoTexture;
  private glow: THREE.PointLight;

  constructor(scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    const hull = new THREE.MeshStandardMaterial({ color: 0xf5b324, roughness: 0.45, metalness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6, metalness: 0.4 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 3.2), hull);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.18, 3.5), dark);
    frame.position.y = -0.7;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 14, 10),
      new THREE.MeshPhysicalMaterial({ color: 0xcfefff, transmission: 0.9, roughness: 0.08, transparent: true }),
    );
    dome.position.set(0, -0.15, 1.75);
    this.group.add(body, frame, dome);
    for (const [x, z] of [[-1.0, 1.2], [1.0, 1.2], [-1.0, -1.2], [1.0, -1.2]] as const) {
      const thruster = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.7, 10), dark);
      thruster.rotation.x = Math.PI / 2;
      thruster.position.set(x, 0.45, z);
      this.group.add(thruster);
    }
    this.glow = new THREE.PointLight(0x9fdcff, 6, 26);
    this.glow.position.set(0, 0, 2.2);
    this.group.add(this.glow);
    // 前照探照灯: 水下浑浊环境中照亮前方海底(数字孪生作业感)
    this.headlight = new THREE.SpotLight(0xcfeaff, 260, 70, 0.62, 0.45, 1.1);
    this.headlight.position.set(0, -0.2, 1.8);
    this.headlightTarget = new THREE.Object3D();
    this.headlightTarget.position.set(0, -1.6, 14);
    this.group.add(this.headlight, this.headlightTarget);
    this.headlight.target = this.headlightTarget;

    // 监视屏: 播放本系统真实标注检测视频
    this.video = document.createElement('video');
    this.video.src = 'media/rov_feed.mp4';
    this.video.muted = true;
    this.video.loop = true;
    this.video.playsInline = true;
    void this.video.play().catch(() => { /* 自动播放被拒时静默, 屏幕显示首帧 */ });
    this.texture = new THREE.VideoTexture(this.video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const screenGeo = new THREE.PlaneGeometry(5.2, 2.9);
    this.screen = new THREE.Mesh(screenGeo, new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    this.screen.position.set(0, 2.6, 0);
    this.group.add(this.screen);
    const bezel = new THREE.Mesh(
      new THREE.PlaneGeometry(5.6, 3.3),
      new THREE.MeshBasicMaterial({ color: 0x08222f }),
    );
    bezel.position.set(0, 2.6, -0.05);
    this.group.add(bezel);

    this.group.position.set(14, -2.2, 10);
    this.group.visible = false;
    scene.add(this.group);

    // 真实ROV模型热插拔: models/rov.glb 存在时替换程序化本体(保留监视屏/探照灯)
    new GLTFLoader().load('models/rov.glb', (gltf) => {
      const real = normalizeModelSize(gltf.scene, 4.6);
      for (const part of this.proceduralParts) part.visible = false;
      this.group.add(real);
    }, undefined, () => undefined);
  }
  private proceduralParts: THREE.Object3D[] = [];
  private headlight!: THREE.SpotLight;
  private headlightTarget!: THREE.Object3D;

  setVisible(v: boolean): void {
    this.group.visible = v;
    if (v && this.video.paused) void this.video.play().catch(() => undefined);
  }

  /** ROV 当前世界坐标(供尾流气泡发射源取位) */
  getWorldPosition(target: THREE.Vector3): THREE.Vector3 {
    return this.group.getWorldPosition(target);
  }

  update(dt: number, t: number): void {
    // 缓慢巡航(椭圆轨迹) + 屏幕始终面向相机
    const a = t * 0.08;
    this.group.position.set(Math.cos(a) * 16, -2.2 + Math.sin(t * 0.5) * 0.35, Math.sin(a) * 12);
    this.group.rotation.y = -a + Math.PI;
    this.screen.lookAt(this.camera.position);
  }

  dispose(): void {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.texture.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat && (mat as THREE.MeshBasicMaterial).map !== (this.texture as unknown as THREE.Texture)) mat.dispose();
    });
    this.group.removeFromParent();
  }
}

// ---------- 真实岸线(舟山市行政边界, 阿里云DataV) ----------
const LNG_MIN = 121.90, LNG_SPAN = 1.25;
const LAT_MIN = 29.70, LAT_SPAN = 1.25;
const GEO_HALF = 120;

function lngLatToScene(lng: number, lat: number): [number, number] {
  return [((lng - LNG_MIN) / LNG_SPAN) * GEO_HALF * 2 - GEO_HALF, ((lat - LAT_MIN) / LAT_SPAN) * GEO_HALF * 2 - GEO_HALF];
}

export async function loadCoastline(scene: THREE.Scene, url: string): Promise<THREE.Group | null> {
  try {
    const res = await fetch(url);
    const json = await res.json();
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x39d7ff, transparent: true, opacity: 0.75 });
    for (const feature of json.features ?? []) {
      const geom = feature.geometry;
      const rings: number[][][] = geom.type === 'Polygon' ? geom.coordinates
        : geom.type === 'MultiPolygon' ? geom.coordinates.flat() : [];
      for (const ring of rings) {
        if (ring.length < 8) continue;
        const pts: THREE.Vector3[] = [];
        for (const [lng, lat] of ring) {
          const [x, z] = lngLatToScene(lng, lat);
          if (Math.abs(x) > GEO_HALF + 60 || Math.abs(z) > GEO_HALF + 60) continue; // 窗口外裁剪
          pts.push(new THREE.Vector3(x, 0.18, z));
        }
        if (pts.length < 8) continue;
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        group.add(new THREE.Line(geo, mat));
      }
    }
    scene.add(group);
    return group;
  } catch {
    // 岸线加载失败不影响主场景
    return null;
  }
}
