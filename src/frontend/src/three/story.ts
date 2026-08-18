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
import { impactByKey } from './impactData';

export interface GarbageStoryState {
  active: boolean;
  year: number;
  stage: number; // 0漂浮 1碎裂 2微塑料扩散 3长期滞留
  stageLabel: string;
  degradationYears: number;
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
  private degradationYears: number;

  constructor(scene: THREE.Scene, center: THREE.Vector3, key: string) {
    this.center = center.clone();
    this.degradationYears = impactByKey(key)?.degradeYears ?? 100;
    scene.add(this.group);

    // 碎片(碎裂后的塑料残块)
    const fragGeo = new THREE.TetrahedronGeometry(0.32);
    const fragMat = new THREE.MeshStandardMaterial({ color: 0xd8e6ee, roughness: 0.5, transparent: true, opacity: 0 });
    this.fragments = new THREE.InstancedMesh(fragGeo, fragMat, 26);
    this.fragments.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.fragments);

    // 微塑料云
    const N = 240;
    this.microPos = new Float32Array(N * 3);
    this.microDir = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry();
    for (let i = 0; i < N; i++) {
      this.microPos[i * 3] = center.x + (Math.random() - 0.5) * 2;
      this.microPos[i * 3 + 1] = -0.6 - Math.random() * 2.2;
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

    // 水面污染扩散盘 + 水下浑浊带
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
    this.murky.position.set(center.x, -1.4, center.z);
    this.group.add(this.murky);

    // 受害鱼(翻肚上浮)
    this.deadFish = new THREE.Group();
    const fishGeo = new THREE.ConeGeometry(0.3, 1.3, 6);
    const fishMat = new THREE.MeshStandardMaterial({ color: 0xd9e2e8, roughness: 0.6 });
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(fishGeo, fishMat);
      f.rotation.z = Math.PI; // 翻肚
      f.position.set(center.x + (i - 1) * 2.4, -2.4 - i * 0.5, center.z + (i % 2) * 2 - 1);
      f.visible = false;
      this.deadFish.add(f);
    }
    this.group.add(this.deadFish);
  }

  update(dt: number): void {
    this.age += dt;
    const stage = this.stage();
    const fragMat = this.fragments.material as THREE.MeshStandardMaterial;
    const microMat = this.micro.material as THREE.PointsMaterial;
    const discMat = this.disc.material as THREE.MeshBasicMaterial;
    const murkyMat = this.murky.material as THREE.MeshBasicMaterial;

    if (stage >= 1) {
      // 碎片出现并散落
      const k = Math.min(1, (this.age - 2.5) / 2);
      fragMat.opacity = 0.95 * k;
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2 + this.age * 0.4;
        const r = 1 + k * (2 + (i % 5) * 0.6) + (this.age - 2.5) * 0.12;
        this.dummy.position.set(this.center.x + Math.cos(a) * r, -0.4 - (i % 4) * 0.3, this.center.z + Math.sin(a) * r);
        this.dummy.rotation.set(this.age + i, i * 1.3, 0);
        this.dummy.scale.setScalar(1 - k * 0.25);
        this.dummy.updateMatrix();
        this.fragments.setMatrixAt(i, this.dummy.matrix);
      }
      this.fragments.instanceMatrix.needsUpdate = true;
    }
    if (stage >= 2) {
      // 微塑料云扩散 + 污染盘/浑浊带生长 + 死鱼上浮
      const k = Math.min(1, (this.age - 5) / 4);
      microMat.opacity = 0.85 * Math.min(1, k * 1.6);
      for (let i = 0; i < this.microPos.length / 3; i++) {
        this.microPos[i * 3] += this.microDir[i * 3] * dt * (0.6 + k);
        this.microPos[i * 3 + 1] += this.microDir[i * 3 + 1] * dt;
        this.microPos[i * 3 + 2] += this.microDir[i * 3 + 2] * dt * (0.6 + k);
      }
      (this.micro.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      discMat.opacity = 0.4 * k;
      this.disc.scale.setScalar(1 + k * 15 + (this.age - 5) * 0.15);
      murkyMat.opacity = 0.22 * k;
      this.murky.scale.setScalar(1 + k * 9);
      for (const f of this.deadFish.children) {
        f.visible = k > 0.25;
        if (f.visible && f.position.y < -0.4) f.position.y += dt * 0.55;
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
      stageLabel: STAGE_LABELS[stage],
      degradationYears: this.degradationYears,
    };
  }

  /** 鱼群规避的污染区（阶段≥2起效） */
  getPollution(): { center: THREE.Vector3; radius: number } | null {
    if (this.stage() < 2) return null;
    const k = Math.min(1, (this.age - 5) / 4);
    return { center: this.center, radius: 4 + k * 12 };
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
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
    if (v && this.video.paused) void this.video.play().catch(() => undefined);
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

export async function loadCoastline(scene: THREE.Scene, url: string): Promise<void> {
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
  } catch {
    // 岸线加载失败不影响主场景
  }
}
