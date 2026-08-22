/**
 * 水下世界模块 —— 仿真级水下环境（真实测深海底 + 焦散 + 生态群落）。
 *
 * 地形: GEBCO 真实测深(33×33) 双线性细分 + fBm 细节噪声(沙纹/沙丘),
 *       顶点色沉积物渐变, 片元着色器实时焦散光斑(浅水强、深水衰减)。
 * 生态: 7 种 Quaternius 骨骼动画鱼群(CC0, GLB, SkeletonUtils 克隆 + boids 群体行为),
 *       巨藻林(实例化 + 顶点着色器摆动), 岩石/分支珊瑚/管海绵(实例化),
 *       水母(菲涅尔钟体 + 触手物理摆动, 喷射推进节律)。
 * 氛围: 体积光束(丁达尔效应), 海雪(着色器悬浮微粒), 气泡(海底冷泉+ROV尾流),
 *       水下仰视水面(焦散波纹 + 斯涅尔窗 + 太阳光晕)。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { normalizeModelSize } from './story';

/** 地形网格覆盖的场景范围(±), 与 OceanWorld 站点布局一致 */
export const TERRAIN_HALF = 120;

/** 垂直纵深: 真实测深米→场景Y倍率。6.5倍让 30m 水深→约-17、外海更深, 水体高耸不压抑 */
const DEPTH_SCALE = 6.5;
/** 保底水深(场景单位): 浅于18的近岸点抬到18, 深处保留真实值(不压平板) */
const MIN_DEPTH = -18;
export type HeightAtFn = (x: number, z: number) => number | null;

// ---------- 噪声(地形细节/散布抖动) ----------
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const tx = x - xi, tz = z - zi;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
function fbm(x: number, z: number, octaves = 4): number {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    v += valueNoise(x * f, z * f) * amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return v * 2 - 0.9; // ≈[-0.9,1.1]
}

/** 焦散干涉纹 GLSL(多频相位旋转干涉, 亮脊=焦散线), 地形与巨藻共用 */
const CAUSTIC_GLSL = /* glsl */ `
float causticWave(vec2 p, float t) {
  float acc = 0.0;
  float amp = 1.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float tt = t * (0.55 + fi * 0.28) + fi * 2.1;
    vec2 q = p * (1.0 + fi * 0.85);
    vec2 w = vec2(cos(tt + q.x * 1.9) + sin(tt * 1.27 + q.y * 1.6),
                  sin(tt + q.y * 2.1) + cos(tt * 0.83 + q.x * 1.7));
    acc += amp / (0.045 + dot(w, w) * 0.06);
    amp *= 0.6;
  }
  return pow(clamp(acc * 0.028, 0.0, 1.0), 4.2);
}
`;

interface SchoolSpec {
  file: string;
  count: number;
  size: number;
  /** 活动深度带(场景y), 会被地形自动抬升 */
  band: [number, number];
  speed: number;
  /** 群体游牧半径 */
  roam: number;
  /** 模型前向与 -Z 的偏航修正 */
  yawFix: number;
  /** 物种基色(银灰/蓝背等自然色, 浑浊水中呈剪影) */
  tint: number;
}

/** 鱼群群落表: 小型鱼三群 + 海豚小群 + 双髻鲨巡逻 + 蝠鲼滑翔 + 座头鲸深水巡航 */
const SCHOOLS: SchoolSpec[] = [
  { file: 'fish1', count: 24, size: 1.3, band: [-14.0, -8.0], speed: 5.2, roam: 40, yawFix: Math.PI, tint: 0x8fa6b4 },
  { file: 'fish2', count: 16, size: 1.6, band: [-16.0, -9.0], speed: 4.4, roam: 48, yawFix: Math.PI, tint: 0x9db1ba },
  { file: 'fish3', count: 20, size: 1.1, band: [-13.0, -7.5], speed: 6.0, roam: 34, yawFix: Math.PI, tint: 0x7e97a8 },
  { file: 'dolphin', count: 3, size: 3.0, band: [-12.0, -6.5], speed: 7.5, roam: 60, yawFix: Math.PI, tint: 0x8b9aa4 },
  { file: 'shark', count: 2, size: 3.4, band: [-15.0, -8.5], speed: 5.6, roam: 66, yawFix: Math.PI, tint: 0x6d7a85 },
  { file: 'manta', count: 2, size: 3.2, band: [-14.5, -8.0], speed: 3.8, roam: 56, yawFix: Math.PI, tint: 0x5b6772 },
  { file: 'whale', count: 1, size: 5.2, band: [-17.0, -10.0], speed: 2.6, roam: 72, yawFix: Math.PI, tint: 0x53606d },
];

interface FishAgent {
  obj: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  action: THREE.AnimationAction | null;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  offset: THREE.Vector3;
  phase: number;
}

interface JellyAgent {
  group: THREE.Group;
  bell: THREE.Mesh;
  tentacles: Array<{ line: THREE.Line; base: THREE.Vector3 }>;
  phase: number;
  drift: number;
}

interface Emitter {
  getPos: () => THREE.Vector3 | null;
  /** 发射速率(个/秒) */
  rate: number;
  acc: number;
}

/** 程序化巨藻叶片贴图: 中肋+纵向沟纹+基部深梢部浅(代替平面色) */
function makeKelpTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 256, 0, 0);
  grad.addColorStop(0, '#4a5230');
  grad.addColorStop(0.5, '#5d6b38');
  grad.addColorStop(1, '#7d8f4e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 7; i++) { // 纵向沟纹
    const x = 12 + i * 16 + Math.sin(i * 2.1) * 4;
    ctx.strokeStyle = `rgba(30,38,18,${0.22 + (i % 3) * 0.08})`;
    ctx.lineWidth = 3 + (i % 2) * 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let y = 0; y <= 256; y += 16) ctx.lineTo(x + Math.sin(y * 0.05 + i) * 3, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(52,60,30,0.75)'; // 中肋
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(64, 256);
  for (let y = 256; y >= 0; y -= 12) ctx.lineTo(64 + Math.sin(y * 0.03) * 3, y);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
export class UnderwaterWorld {
  readonly root = new THREE.Group();
  private terrain?: THREE.Mesh;
  private terrainUniforms = { uTime: { value: 0 }, uCaustics: { value: 0.45 } };
  private kelpUniforms = { uTime: { value: 0 } };
  private snowUniforms = { uTime: { value: 0 } };
  private bubbleUniforms = { uTime: { value: 0 } };
  private rayUniforms = { uTime: { value: 0 } };
  private undersideUniforms!: Record<string, THREE.IUniform>;
  private shafts: Array<{ mesh: THREE.Mesh; phase: number }> = [];
  private snow?: THREE.Points;
  private vents?: THREE.Points;
  private rovTrail!: THREE.Points;
  private trailPos!: Float32Array;
  private trailMeta!: Float32Array; // life per bubble
  private heightAt: HeightAtFn = () => null;
  private schools: Array<{ spec: SchoolSpec; agents: FishAgent[]; center: THREE.Vector3; phase: number }> = [];
  private jellies: JellyAgent[] = [];
  private emitters: Emitter[] = [];
  private gltf = new GLTFLoader();
  private readonly sunDir: THREE.Vector3;
  private tmpV = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, sunDir: THREE.Vector3, private onTerrainReady?: () => void) {
    this.sunDir = sunDir.clone().normalize();
    this.root.visible = false;
    scene.add(this.root);

    this.buildUnderside();
    this.buildShafts();
    this.buildSnow();
    this.buildVents();
    this.rovTrail = this.buildRovTrail();
    this.buildJellies();
    void this.loadTerrain();
    void this.loadScannedReef();
    void this.loadSchools();
  }

  /** 真实扫描礁石/海螺(Poly Haven CC0): 多层礁盘结构, 非散布 */
  private async loadScannedReef(): Promise<void> {
    const REEF_X = 38, REEF_Z = -28;
    const load = async (slug: string, size: number, x: number, y: number, z: number, rotY: number, rotZ = 0): Promise<void> => {
      try {
        const gltf = await this.gltf.loadAsync(`models/polyhaven/${slug}/${slug}_1k.gltf`);
        const model = normalizeModelSize(gltf.scene, size);
        model.position.set(x, y, z);
        model.rotation.set(0, rotY, rotZ);
        this.root.add(model);
      } catch { /* skip */ }
    };
    const base = this.heightAt(REEF_X, REEF_Z) ?? -4;
    // ── 第一层: 主礁基座(大扫描礁岩, 构成礁盘主体) ──
    await load('coast_rocks_01', 24, REEF_X, base, REEF_Z, 0.5);
    await load('namaqualand_boulders_01', 14, REEF_X - 18, base + 0.5, REEF_Z + 8, 2.1);
    // ── 第二层: 中型岩石叠在基座上(形成台阶/凸起) ──
    await load('namaqualand_stones_01', 10, REEF_X + 10, base + 2.5, REEF_Z - 6, 1.0);
    await load('boulder_01', 7, REEF_X + 5, base + 3.5, REEF_Z + 8, 0.4, 0.2);
    await load('boulder_01', 6, REEF_X - 8, base + 2.0, REEF_Z - 10, 3.5, -0.15);
    // ── 第三层: 独立巨石散布在礁盘周围(形成礁缘) ──
    const rimAngles = [0.4, 1.2, 2.0, 2.8, 3.6, 4.4, 5.2];
    for (const a of rimAngles) {
      const r = 22 + Math.random() * 8;
      const x = REEF_X + Math.cos(a) * r;
      const z = REEF_Z + Math.sin(a) * r;
      const h = this.heightAt(x, z) ?? base;
      await load('boulder_01', 3.5 + Math.random() * 3, x, h, z, a + Math.PI);
    }
    // ── 海螺点缀 ──
    try {
      const shell = await this.gltf.loadAsync('models/polyhaven/lambis_shell/lambis_shell_1k.gltf');
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 12 + Math.random() * 15;
        const x = REEF_X + Math.cos(a) * r;
        const z = REEF_Z + Math.sin(a) * r;
        const h = this.heightAt(x, z);
        if (h == null || h > -1.5) continue;
        const m = normalizeModelSize(shell.scene.clone(true), 1.0 + Math.random() * 0.8);
        m.position.set(x, h + 0.1, z);
        m.rotation.y = Math.random() * Math.PI * 2;
        this.root.add(m);
      }
    } catch { /* skip */ }
  }

  // ---------- 海底地形: 真实测深 + fBm 细节 + 沉积物配色 + 焦散 ----------
  private async loadTerrain(): Promise<void> {
    try {
      const res = await fetch('data/zhoushan_bathymetry.json');
      const json = await res.json();
      const nx: number = json.meta.nx, nz: number = json.meta.nz;
      const data: number[][] = json.depths;
      const bathyAt = (x: number, z: number): number => {
        const fx = ((x + TERRAIN_HALF) / (TERRAIN_HALF * 2)) * (nx - 1);
        const fz = ((z + TERRAIN_HALF) / (TERRAIN_HALF * 2)) * (nz - 1);
        const ix = Math.min(nx - 2, Math.max(0, Math.floor(fx)));
        const iz = Math.min(nz - 2, Math.max(0, Math.floor(fz)));
        const tx = fx - ix, tz = fz - iz;
        return data[iz][ix] * (1 - tx) * (1 - tz) + data[iz][ix + 1] * tx * (1 - tz)
          + data[iz + 1][ix] * (1 - tx) * tz + data[iz + 1][ix + 1] * tx * tz;
      };
      // 供鱼群/生态使用的最终高度: 测深基底 + 沙丘 + 脊状礁岩(rid ridged噪声造起伏)
      this.heightAt = (x, z) => {
        if (Math.abs(x) > TERRAIN_HALF || Math.abs(z) > TERRAIN_HALF) return null;
        const base = bathyAt(x, z) * 0.09 * DEPTH_SCALE;
        if (base > 1.6) return base; // 岛屿不叠加(阈值随纵深同步放大)
        const dunes = (fbm(x * 0.16, z * 0.16, 4) * 1.1 + fbm(x * 0.55, z * 0.55, 3) * 0.35) * DEPTH_SCALE;
        // 脊状礁岩: 1-|噪声| 产生尖锐山脊; 深水区全幅, 浅水区渐弱避免大面积填平水体
        const ridgeA = Math.pow(1 - Math.abs(fbm(x * 0.045 + 7.3, z * 0.045 - 2.1, 3)), 2.2);
        const ridgeB = Math.pow(1 - Math.abs(fbm(x * 0.11 - 4.7, z * 0.11 + 9.4, 3)), 2.6);
        const depthK = Math.max(0, Math.min(1, -base / 14.5));
        const crag = (ridgeA * 3.1 + ridgeB * 1.15) * depthK * DEPTH_SCALE;
        return Math.min(MIN_DEPTH, base + dunes + crag);
      };

      const VX = 200;
      const positions: number[] = [];
      const colors: number[] = [];
      const uvs: number[] = [];
      // 顶点色退化为"深度染色"(浅=原色, 深=蓝灰), 让 PBR 沙地贴图主导质感
      const cShallow = new THREE.Color(0xffffff);
      const cMid = new THREE.Color(0xd7dbd6);
      const cDeep = new THREE.Color(0xa4b6c2);
      const cAlgae = new THREE.Color(0xb9c9b4);
      const tmp = new THREE.Color();
      for (let iz = 0; iz < VX; iz++) {
        for (let ix = 0; ix < VX; ix++) {
          const x = -TERRAIN_HALF + (ix / (VX - 1)) * TERRAIN_HALF * 2;
          const z = -TERRAIN_HALF + (iz / (VX - 1)) * TERRAIN_HALF * 2;
          const h = this.heightAt(x, z) ?? -8;
          positions.push(x, h, z);
          uvs.push(ix / (VX - 1), iz / (VX - 1));
          if (h > 1.6) tmp.copy(cShallow).offsetHSL(0, 0, fbm(x * 0.3, z * 0.3, 2) * 0.04);
          else if (h > -7) tmp.lerpColors(cMid, cShallow, (h + 7) / 8.6);
          else if (h > -16) tmp.lerpColors(cDeep, cMid, (h + 16) / 9);
          else tmp.lerpColors(cDeep, cAlgae, Math.max(0, fbm(x * 0.12, z * 0.12, 3)) * 0.4);
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
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      // 真实海床 PBR 材质(ambientCG Ground109, CC0): 反照率+法线+粗糙度
      const texLoader = new THREE.TextureLoader();
      const [cMap, nMap, rMap] = await Promise.all([
        texLoader.loadAsync('textures/seabed_color.jpg').catch(() => null),
        texLoader.loadAsync('textures/seabed_normal.jpg').catch(() => null),
        texLoader.loadAsync('textures/seabed_rough.jpg').catch(() => null),
      ]);
      const TILE = 9;
      for (const t of [cMap, nMap, rMap]) {
        if (!t) continue;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(TILE, TILE);
        t.anisotropy = 8;
      }
      if (cMap) cMap.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 1.0, metalness: 0.0,
        map: cMap ?? undefined, normalMap: nMap ?? undefined, roughnessMap: rMap ?? undefined,
        normalScale: new THREE.Vector2(0.85, 0.85),
      });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.terrainUniforms.uTime;
        shader.uniforms.uCaustics = this.terrainUniforms.uCaustics;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\nuniform float uCaustics;\n${CAUSTIC_GLSL}`)
          .replace('#include <dithering_fragment>', /* glsl */`
            float cFade = smoothstep(-30.0, -2.5, vWPos.y) * clamp(vWPos.y * -0.2 + 1.0, 0.0, 1.0);
            float ca = causticWave(vWPos.xz * 0.55, uTime * 0.7);
            gl_FragColor.rgb += vec3(0.58, 0.82, 0.78) * ca * cFade * uCaustics;
            #include <dithering_fragment>`);
      };
      this.terrain = new THREE.Mesh(geo, mat);
      this.root.add(this.terrain);

      this.scatterKelp();
      await this.scatterReef();
      this.onTerrainReady?.();
    } catch {
      // 测深加载失败: 场景退化为平坦海底, 其余生态照常
      this.heightAt = () => -6;
      this.scatterKelp();
      void this.scatterReef();
      this.onTerrainReady?.();
    }
  }

  /** 场景坐标 → 海底高度(供外部: ROV巡航/站点贴地) */
  getHeightAt(x: number, z: number): number | null {
    return this.heightAt(x, z);
  }

  // ---------- 巨藻林(实例化 + 顶点摆动) ----------
  private makeKelpBlade(): THREE.BufferGeometry {
    const SEG = 7, H = 3.0, W = 0.35;
    const pos: number[] = [];
    const uv: number[] = [];
    const idxN: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const y = t * H;
      const w = W * (1 - 0.78 * t * t) + 0.04;
      const zCurve = Math.sin(t * 2.1) * 0.4 * t;
      pos.push(-w, y, zCurve, w, y, zCurve);
      uv.push(0, t, 1, t);
      if (i < SEG) {
        const a = i * 2;
        idxN.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idxN);
    geo.computeVertexNormals();
    return geo;
  }

  private scatterKelp(): void {
    const COUNT = 280;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide, map: makeKelpTexture() });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.kelpUniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          #ifdef USE_INSTANCING
            vec4 kW = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float kPh = kW.x * 0.7 + kW.z * 0.53;
            float kT = uv.y * uv.y;
            transformed.x += (sin(uTime * 0.85 + kPh) * 0.55 + sin(uTime * 1.9 + kPh * 1.3) * 0.2) * kT;
            transformed.z += cos(uTime * 0.62 + kPh) * 0.34 * kT;
          #endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\n${CAUSTIC_GLSL}`)
        .replace('#include <dithering_fragment>', /* glsl */`
          #ifdef USE_INSTANCING
            vec3 kWP = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            float kFade = smoothstep(-30.0, -2.5, kWP.y);
            float kCa = causticWave(kWP.xz * 0.55 + vUv * 2.0, uTime * 0.7);
            gl_FragColor.rgb += vec3(0.5, 0.8, 0.7) * kCa * kFade * 0.5;
          #endif
          #include <dithering_fragment>`);
    };
    const mesh = new THREE.InstancedMesh(this.makeKelpBlade(), mat, COUNT);
    const dummy = new THREE.Object3D();
    const kelpTint = new THREE.Color();
    let placed = 0, tries = 0;
    // 巨藻林以"丛"分布: 以礁盘(38,-28)为中心向外辐射, 形成礁盘背景藻墙
    const REEF_X = 38, REEF_Z = -28;
    const groves: Array<[number, number, number]> = [];
    groves.push([REEF_X - 30, REEF_Z + 15, 5]); // 礁盘左侧浓密藻墙
    groves.push([REEF_X + 25, REEF_Z + 20, 4]); // 右侧次藻墙
    while (groves.length < 26 && tries < 4000) {
      tries++;
      // 70% 在礁盘附近(20-50单位), 30% 全图随机
      let gx: number, gz: number;
      if (Math.random() < 0.7) {
        const a = Math.random() * Math.PI * 2;
        const r = 25 + Math.random() * 30;
        gx = REEF_X + Math.cos(a) * r;
        gz = REEF_Z + Math.sin(a) * r;
      } else {
        gx = (Math.random() - 0.5) * TERRAIN_HALF * 1.9;
        gz = (Math.random() - 0.5) * TERRAIN_HALF * 1.9;
      }
      const gh = this.heightAt(gx, gz);
      if (gh == null || gh < -15 || gh > -2) continue;
      groves.push([gx, gz, 3 + Math.random() * 6]);
    }
    let gi = 0;
    while (placed < COUNT && tries < COUNT * 40) {
      tries++;
      let x: number, z: number;
      if (groves.length > 0 && Math.random() < 0.85) {
        const g = groves[gi++ % groves.length];
        const a = Math.random() * Math.PI * 2;
        const r = Math.abs((Math.random() + Math.random() - 1)) * g[2]; // 近似高斯
        x = g[0] + Math.cos(a) * r;
        z = g[1] + Math.sin(a) * r;
      } else {
        x = (Math.random() - 0.5) * TERRAIN_HALF * 1.9;
        z = (Math.random() - 0.5) * TERRAIN_HALF * 1.9;
      }
      const h = this.heightAt(x, z);
      if (h == null || h < -15 || h > -2) continue;
      dummy.position.set(x, h - 0.15, z);
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.scale.set(0.8 + Math.random() * 0.8, 0.7 + Math.random() * 1.0, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);
      // 个体色差: 橄榄绿-褐之间的自然变化(通过 instanceColor 调制贴图)
      kelpTint.setHSL(0.22 + Math.random() * 0.09, 0.3 + Math.random() * 0.25, 0.32 + Math.random() * 0.22);
      mesh.setColorAt(placed, kelpTint);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.root.add(mesh);
  }

  // ---------- 礁盘生态系统: 珊瑚/海绵/海草密集生长在礁盘结构上 ----------
  private async scatterReef(): Promise<void> {
    const REEF_X = 38, REEF_Z = -28;
    const dummy = new THREE.Object3D();
    const texLoader = new THREE.TextureLoader();
    const [rc, rn, rr] = await Promise.all([
      texLoader.loadAsync('textures/rock_color.jpg').catch(() => null),
      texLoader.loadAsync('textures/rock_normal.jpg').catch(() => null),
      texLoader.loadAsync('textures/rock_rough.jpg').catch(() => null),
    ]);
    if (rc) rc.colorSpace = THREE.SRGBColorSpace;
    const causticMat = (opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial => {
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.02, ...opts });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.terrainUniforms.uTime;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nuniform float uTime;\n${CAUSTIC_GLSL}`)
          .replace('#include <dithering_fragment>', `
            #ifdef USE_INSTANCING
              vec3 cWP = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              float cFade = smoothstep(-30.0, -2.5, cWP.y);
              float cCa = causticWave(cWP.xz * 0.55, uTime * 0.7);
              gl_FragColor.rgb += vec3(0.5, 0.8, 0.75) * cCa * cFade * 0.5;
            #endif
            #include <dithering_fragment>`);
      };
      return mat;
    };
    /** 在礁盘范围内散布实例(高斯向心) */
    const scatterOnReef = (mesh: THREE.InstancedMesh, count: number, yOff: number, sMin: number, sMax: number, tint?: (c: THREE.Color, i: number) => void): void => {
      const c = new THREE.Color();
      let placed = 0, tries = 0;
      while (placed < count && tries < count * 50) {
        tries++;
        const a = Math.random() * Math.PI * 2;
        const r = Math.abs((Math.random() + Math.random() - 1)) * 24;
        const x = REEF_X + Math.cos(a) * r;
        const z = REEF_Z + Math.sin(a) * r;
        const h = this.heightAt(x, z);
        if (h == null || h > -1.0) continue;
        const s = sMin + Math.random() * (sMax - sMin);
        dummy.position.set(x, h + yOff * s, z);
        dummy.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.3);
        dummy.scale.set(s, s * (0.8 + Math.random() * 0.4), s);
        dummy.updateMatrix();
        mesh.setMatrixAt(placed, dummy.matrix);
        if (tint) { tint(c, placed); mesh.setColorAt(placed, c); }
        placed++;
      }
      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.root.add(mesh);
    };

    // ── 程序礁石(玄武岩 PBR): 密集堆叠在礁盘周围 ──
    const rockGeo = new THREE.IcosahedronGeometry(1, 2);
    const rp = rockGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < rp.count; i++) {
      const k = 0.78 + hash2(i * 3.7, i * 1.3) * 0.5;
      rp.setXYZ(i, rp.getX(i) * k, rp.getY(i) * k * 0.78, rp.getZ(i) * k);
    }
    rockGeo.computeVertexNormals();
    const rocks = new THREE.InstancedMesh(rockGeo, causticMat({
      color: 0xb8bcbd, map: rc ?? undefined, normalMap: rn ?? undefined, roughnessMap: rr ?? undefined,
      normalScale: new THREE.Vector2(1.4, 1.4),
    }), 200);
    scatterOnReef(rocks, 200, -0.3, 0.4, 3.5, (c, i) => c.setHSL(0.08 + Math.random() * 0.06, 0.08 + Math.random() * 0.1, 0.42 + Math.random() * 0.2));

    // ── 分支珊瑚 ×5 种颜色(橙/粉/紫/红/黄): 密集生长在礁石上 ──
    const branchGeos: THREE.CylinderGeometry[] = [];
    const growBranch = (m: THREE.Matrix4, len: number, radius: number, depth: number): void => {
      const cyl = new THREE.CylinderGeometry(radius * 0.55, radius, len, 6, 1);
      cyl.translate(0, len / 2, 0);
      cyl.applyMatrix4(m);
      branchGeos.push(cyl);
      if (depth <= 0) return;
      for (let i = 0; i < 2; i++) {
        const rot = new THREE.Matrix4().makeRotationY(i * 2.2 + depth)
          .multiply(new THREE.Matrix4().makeRotationZ(0.55 + Math.random() * 0.35));
        const trans = new THREE.Matrix4().makeTranslation(0, len * 0.92, 0);
        growBranch(m.clone().multiply(trans).multiply(rot), len * 0.62, radius * 0.6, depth - 1);
      }
    };
    growBranch(new THREE.Matrix4(), 1.0, 0.14, 3);
    const coralGeo = mergeGeometries(branchGeos)!;
    const branchCorals = new THREE.InstancedMesh(coralGeo, causticMat({ color: 0xffffff, flatShading: true }), 160);
    scatterOnReef(branchCorals, 160, 0.05, 0.4, 1.8, (c) => {
      const hue = [0.02, 0.05, 0.83, 0.95, 0.10][Math.floor(Math.random() * 5)];
      c.setHSL(hue, 0.55 + Math.random() * 0.25, 0.5 + Math.random() * 0.2);
    });

    // ── 台状珊瑚(圆盘+柄): 平顶珊瑚礁典型形态 ──
    const tableGeos: THREE.BufferGeometry[] = [];
    const stem = new THREE.CylinderGeometry(0.08, 0.12, 0.6, 6); stem.translate(0, 0.3, 0); tableGeos.push(stem);
    const disc = new THREE.CylinderGeometry(0.8, 0.9, 0.12, 16); disc.translate(0, 0.65, 0); tableGeos.push(disc);
    const tableGeo = mergeGeometries(tableGeos)!;
    const tableCorals = new THREE.InstancedMesh(tableGeo, causticMat({ color: 0xffffff }), 40);
    scatterOnReef(tableCorals, 40, 0, 0.6, 2.2, (c) => c.setHSL(0.07 + Math.random() * 0.05, 0.4 + Math.random() * 0.2, 0.55 + Math.random() * 0.15));

    // ── 脑珊瑚(球状+凹凸): 大型单体珊瑚 ──
    const brainGeo = new THREE.SphereGeometry(0.5, 12, 10);
    const bp = brainGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < bp.count; i++) {
      const k = 0.9 + hash2(i * 2.3, i * 5.1) * 0.2;
      bp.setXYZ(i, bp.getX(i) * k * 1.2, bp.getY(i) * k * 0.7, bp.getZ(i) * k * 1.2);
    }
    brainGeo.computeVertexNormals();
    const brainCorals = new THREE.InstancedMesh(brainGeo, causticMat({ color: 0xffffff }), 30);
    scatterOnReef(brainCorals, 30, 0.1, 0.5, 2.0, (c) => c.setHSL(0.12 + Math.random() * 0.04, 0.35 + Math.random() * 0.2, 0.5 + Math.random() * 0.15));

    // ── 管海绵群落 ×3 色 ──
    const spongeGeos: THREE.CylinderGeometry[] = [];
    for (let i = 0; i < 5; i++) {
      const r = 0.14 + Math.random() * 0.1;
      const hgt = 0.8 + Math.random() * 0.9;
      const cyl = new THREE.CylinderGeometry(r * 0.8, r, hgt, 7, 1);
      cyl.translate((Math.random() - 0.5) * 0.7, hgt / 2, (Math.random() - 0.5) * 0.7);
      spongeGeos.push(cyl);
    }
    const spongeGeo = mergeGeometries(spongeGeos)!;
    const sponges = new THREE.InstancedMesh(spongeGeo, causticMat({ color: 0xffffff }), 60);
    scatterOnReef(sponges, 60, 0, 0.5, 1.8, (c) => {
      const hue = [0.02, 0.85, 0.45][Math.floor(Math.random() * 3)];
      c.setHSL(hue, 0.4 + Math.random() * 0.2, 0.45 + Math.random() * 0.15);
    });

    // ── 海草甸: 礁盘外围沙地覆盖 ──
    const grassBlade = new THREE.PlaneGeometry(0.10, 0.5, 1, 2).translate(0, 0.5, 0);
    const grassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide });
    grassMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.kelpUniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec4 gW = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float gPh = gW.x * 1.3 + gW.z * 0.9;
            float gT = uv.y;
            transformed.x += sin(uTime * 1.3 + gPh) * 0.14 * gT;
          #endif`);
    };
    const grass = new THREE.InstancedMesh(grassBlade, grassMat, 400);
    {
      const c = new THREE.Color();
      let placed = 0; let tries = 0;
      while (placed < 800 && tries < 16000) {
        tries++;
        // 礁盘外围环形散布
        const a = Math.random() * Math.PI * 2;
        const r = 28 + Math.abs((Math.random() + Math.random() - 1)) * 30;
        const x = REEF_X + Math.cos(a) * r;
        const z = REEF_Z + Math.sin(a) * r;
        const h = this.heightAt(x, z);
        if (h == null || h < -7.0 || h > -1.5) continue;
        dummy.position.set(x, h - 0.05, z);
        dummy.rotation.y = Math.random() * Math.PI;
        dummy.scale.set(1, 0.5 + Math.random() * 0.9, 1);
        dummy.updateMatrix();
        grass.setMatrixAt(placed, dummy.matrix);
        c.setHSL(0.24 + Math.random() * 0.06, 0.35 + Math.random() * 0.2, 0.3 + Math.random() * 0.2);
        grass.setColorAt(placed, c);
        placed++;
      }
      grass.count = placed;
      grass.instanceMatrix.needsUpdate = true;
      if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    }
    this.root.add(grass);
  }

  // ---------- 水下仰视水面(焦散波纹 + 斯涅尔窗 + 太阳光晕) ----------
  private buildUnderside(): void {
    this.undersideUniforms = {
      uTime: { value: 0 },
      uSunDir: { value: this.sunDir.clone() },
      uDeep: { value: new THREE.Color(0x03141f) },
      uLite: { value: new THREE.Color(0x155470) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, this.undersideUniforms]),
      vertexShader: /* glsl */`
        #include <fog_pars_vertex>
        varying vec3 vWPos;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <fog_pars_fragment>
        varying vec3 vWPos;
        uniform float uTime;
        uniform vec3 uSunDir;
        uniform vec3 uDeep;
        uniform vec3 uLite;
        ${CAUSTIC_GLSL}
        void main() {
          vec3 V = normalize(vWPos - cameraPosition); // 从相机指向水面
          float win = pow(clamp(-V.y, 0.0, 1.0), 2.6); // 越接近正上方越亮(斯涅尔窗)
          float ca = causticWave(vWPos.xz * 0.10, uTime * 0.45);
          vec3 col = mix(uDeep, uLite, clamp(win * 0.45 + ca * 0.2 * win, 0.0, 1.0));
          float halo = pow(max(dot(-V, normalize(uSunDir)), 0.0), 90.0);
          col += vec3(0.9, 0.85, 0.7) * halo * 0.45 * clamp(win + 0.1, 0.0, 1.0);
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
      side: THREE.BackSide,
      fog: true,
    });
    // merge 会克隆 uniform 值 → 重新绑定引用, 保证 update() 生效
    this.undersideUniforms.uTime = mat.uniforms.uTime;
    const geo = new THREE.PlaneGeometry(2400, 2400);
    geo.rotateX(Math.PI / 2); // 法线朝下, 从下方可见
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = -0.06;
    this.root.add(mesh);
  }

  // ---------- 体积光束(丁达尔效应, 面向相机 Y 轴公告板) ----------
  private buildShafts(): void {
    const N = 16;
    for (let i = 0; i < N; i++) {
      const w = 2.2 + Math.random() * 4.5;
      const h = 30 + Math.random() * 12;
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: this.rayUniforms.uTime, uPhase: { value: Math.random() * Math.PI * 2 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: /* glsl */`
          varying vec2 vUv;
          uniform float uTime;
          uniform float uPhase;
          void main() {
            float lat = smoothstep(0.0, 0.32, vUv.x) * smoothstep(1.0, 0.68, vUv.x);
            float vert = smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.45, vUv.y);
            float flicker = 0.45 + 0.55 * sin(uTime * 0.42 + uPhase) * sin(uTime * 0.23 + uPhase * 1.7);
            float a = lat * vert * flicker;
            gl_FragColor = vec4(vec3(0.35, 0.6, 0.7), a * 0.09);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      const ang = Math.random() * Math.PI * 2;
      const r = 18 + Math.random() * 85;
      mesh.position.set(Math.cos(ang) * r, -h / 2 + 1.5, Math.sin(ang) * r);
      // 光束沿太阳方向倾斜
      const tilt = Math.asin(THREE.MathUtils.clamp(this.sunDir.y, 0.1, 0.9)) - Math.PI / 2;
      mesh.rotation.order = 'YXZ';
      mesh.rotation.y = Math.atan2(this.sunDir.x, this.sunDir.z);
      mesh.rotation.x = tilt * 0.6;
      this.root.add(mesh);
      this.shafts.push({ mesh, phase: i });
    }
  }

  // ---------- 海雪(着色器驱动的悬浮微粒) ----------
  private buildSnow(): void {
    const N = 2600;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 230;
      pos[i * 3 + 1] = Math.random() * 42 - 40;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 230;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.snowUniforms.uTime },
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime;
        varying float vA;
        void main() {
          vec3 p = position;
          p.y = mod(p.y - uTime * (0.10 + aSeed * 0.12) + 42.0, 42.0) - 40.5;
          p.x += sin(uTime * 0.22 + aSeed * 41.0) * 1.4;
          p.z += cos(uTime * 0.19 + aSeed * 37.0) * 1.4;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (0.9 + aSeed * 1.9) * (120.0 / max(1.0, -mv.z));
          vA = 0.28 + aSeed * 0.4;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.1, d) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(0.78, 0.9, 0.96, a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.snow = new THREE.Points(geo, mat);
    this.root.add(this.snow);
  }

  // ---------- 冷泉气泡(海底上升, 着色器循环) ----------
  private buildVents(): void {
    // 选 3 处冷泉点(较深、平坦)
    const vents: THREE.Vector3[] = [];
    let guard = 0;
    while (vents.length < 3 && guard++ < 200) {
      const x = (Math.random() - 0.5) * TERRAIN_HALF * 1.7;
      const z = (Math.random() - 0.5) * TERRAIN_HALF * 1.7;
      const h = this.heightAt(x, z);
      if (h != null && h < -4.5 && h > -8) vents.push(new THREE.Vector3(x, h, z));
    }
    if (vents.length === 0) vents.push(new THREE.Vector3(30, -6.5, -30), new THREE.Vector3(-40, -6, 20), new THREE.Vector3(55, -5.5, 55));

    const N = 190;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const speed = new Float32Array(N);
    const floorY = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const v = vents[i % vents.length];
      pos[i * 3] = v.x + (Math.random() - 0.5) * 1.6;
      pos[i * 3 + 1] = v.y;
      pos[i * 3 + 2] = v.z + (Math.random() - 0.5) * 1.6;
      seed[i] = Math.random();
      speed[i] = 0.55 + Math.random() * 0.8;
      floorY[i] = v.y;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    geo.setAttribute('aFloor', new THREE.BufferAttribute(floorY, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.bubbleUniforms.uTime },
      vertexShader: /* glsl */`
        attribute float aSeed;
        attribute float aSpeed;
        attribute float aFloor;
        uniform float uTime;
        varying float vA;
        void main() {
          vec3 p = position;
          float span = -0.25 - aFloor;
          p.y = aFloor + mod(uTime * aSpeed + aSeed * span, span);
          p.x += sin(uTime * (1.1 + aSeed * 1.6) + aSeed * 40.0) * (0.14 + aSeed * 0.3);
          p.z += cos(uTime * (0.9 + aSeed * 1.3) + aSeed * 34.0) * (0.14 + aSeed * 0.3);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (1.4 + aSeed * 3.4) * (110.0 / max(1.0, -mv.z));
          vA = clamp(p.y - aFloor, 0.0, 1.0) * 0.75;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float shell = smoothstep(0.5, 0.4, d) * smoothstep(0.16, 0.34, d);
          float a = (shell + smoothstep(0.36, 0.0, d) * 0.18) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(0.82, 0.94, 1.0, a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.vents = new THREE.Points(geo, mat);
    this.root.add(this.vents);
  }

  /** ROV 尾流气泡(CPU 循环复用), 由 OceanWorld 每帧喂入推进器位置 */
  private buildRovTrail(): THREE.Points {
    const N = 46;
    this.trailPos = new Float32Array(N * 3);
    this.trailMeta = new Float32Array(N); // 生命 0..1
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xbfe6f5, size: 0.32, transparent: true, opacity: 0.65,
      depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.root.add(pts);
    return pts;
  }

  addEmitter(getPos: () => THREE.Vector3 | null, rate: number): void {
    this.emitters.push({ getPos, rate, acc: 0 });
  }

  // ---------- 水母 ----------
  private buildJellies(): void {
    const bellMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.rayUniforms.uTime },
      vertexShader: /* glsl */`
        varying vec3 vNW;
        varying vec3 vW;
        void main() {
          vNW = normalize(mat3(modelMatrix) * normal);
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vNW;
        varying vec3 vW;
        uniform float uTime;
        void main() {
          vec3 V = normalize(cameraPosition - vW);
          float rim = pow(1.0 - abs(dot(normalize(vNW), V)), 2.4);
          float glow = 0.75 + 0.25 * sin(uTime * 2.1);
          vec3 col = mix(vec3(0.38, 0.55, 0.85), vec3(0.85, 0.92, 1.0), rim);
          gl_FragColor = vec4(col * glow, 0.10 + rim * 0.5);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    for (let j = 0; j < 18; j++) {
      const group = new THREE.Group();
      const bell = new THREE.Mesh(new THREE.SphereGeometry(0.55, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), bellMat);
      group.add(bell);
      const tentacles: Array<{ line: THREE.Line; base: THREE.Vector3 }> = [];
      const tMat = new THREE.LineBasicMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.32 });
      for (let t = 0; t < 7; t++) {
        const a = (t / 7) * Math.PI * 2;
        const base = new THREE.Vector3(Math.cos(a) * 0.34, -0.05, Math.sin(a) * 0.34);
        const pts: THREE.Vector3[] = [];
        for (let k = 0; k < 9; k++) pts.push(base.clone());
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), tMat);
        group.add(line);
        tentacles.push({ line, base });
      }
      const angle = Math.random() * Math.PI * 2;
      const r = 15 + Math.random() * 75;
      group.position.set(Math.cos(angle) * r, -6.5 - Math.random() * 8.5, Math.sin(angle) * r);
      const s = 0.55 + Math.random() * 0.5;
      group.scale.setScalar(s);
      this.root.add(group);
      this.jellies.push({ group, bell, tentacles, phase: Math.random() * Math.PI * 2, drift: 0.12 + Math.random() * 0.2 });
    }
  }

  private updateJellies(dt: number, t: number): void {
    for (const j of this.jellies) {
      const pulse = Math.sin(t * 2.1 + j.phase);
      const squeeze = 1 - pulse * 0.14;
      j.bell.scale.set(squeeze, 1 / squeeze, squeeze);
      // 喷射推进: 收缩后段获得推力
      const jet = Math.max(0, -Math.sin(t * 2.1 + j.phase - 0.7)) * 0.55 + 0.06;
      j.group.position.y += jet * dt * 0.6;
      j.group.position.x += Math.sin(t * 0.14 + j.phase) * j.drift * dt;
      j.group.position.z += Math.cos(t * 0.11 + j.phase * 1.3) * j.drift * dt;
      const floor = this.heightAt(j.group.position.x, j.group.position.z) ?? -7;
      if (j.group.position.y > -1.3) j.group.position.y -= dt * 0.5;
      if (j.group.position.y < floor + 1.2) j.group.position.y = floor + 1.2;
      // 触手拖尾摆动
      for (const { line, base } of j.tentacles) {
        const arr = (line.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        for (let k = 0; k < 9; k++) {
          const droop = k * 0.16;
          const sway = Math.sin(t * 1.25 + k * 0.55 + j.phase + base.x * 8) * 0.1 * k;
          arr[k * 3] = base.x + sway;
          arr[k * 3 + 1] = base.y - droop - pulse * 0.03 * k;
          arr[k * 3 + 2] = base.z + sway * 0.7;
        }
        (line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      }
    }
  }

  // ---------- 鱼群(骨骼动画 GLB + boids) ----------
  private async loadSchools(): Promise<void> {
    const centers: Array<[number, number]> = [[-78, -62], [-18, -82], [64, -70], [86, 8], [-72, 44], [8, 72], [70, 58]];
    for (let schoolIndex = 0; schoolIndex < SCHOOLS.length; schoolIndex += 1) {
      const spec = SCHOOLS[schoolIndex];
      try {
        const gltf = await this.gltf.loadAsync(`models/fish/${spec.file}.glb`);
        const source = gltf.scene;
        const agents: FishAgent[] = [];
        const schoolGroup = new THREE.Group();
        const [cx, cz] = centers[schoolIndex % centers.length];
        const centerY = (spec.band[0] + spec.band[1]) / 2;
        for (let i = 0; i < spec.count; i += 1) {
          const obj = cloneSkinned(source) as THREE.Group;
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * spec.roam * 0.55;
          const pos = new THREE.Vector3(cx + Math.cos(angle) * radius, centerY + (Math.random() - 0.5) * 1.5, cz + Math.sin(angle) * radius);
          obj.position.copy(pos);
          obj.scale.setScalar(spec.size * (0.88 + Math.random() * 0.24));
          obj.rotation.y = spec.yawFix;
          const mixer = obj.animations?.length ? new THREE.AnimationMixer(obj) : null;
          const action = mixer && obj.animations?.[0] ? mixer.clipAction(obj.animations[0]).play() : null;
          schoolGroup.add(obj);
          agents.push({ obj, mixer, action, pos, vel: new THREE.Vector3(Math.cos(angle) * spec.speed, 0, Math.sin(angle) * spec.speed), offset: new THREE.Vector3(Math.cos(angle) * radius, (Math.random() - 0.5) * 1.6, Math.sin(angle) * radius), phase: Math.random() * Math.PI * 2 });
        }
        this.root.add(schoolGroup);
        this.schools.push({ spec, agents, center: new THREE.Vector3(cx, centerY, cz), phase: Math.random() * Math.PI * 2 });
      } catch {
        // 单一物种加载失败仅跳过该群
      }
    }
  }

  private updateFish(dt: number, t: number, pollution: { center: THREE.Vector3; radius: number } | null): void {
    const look = this.tmpM;
    for (const school of this.schools) {
      const { spec, agents, center } = school;
      // 群体游牧中心: 利萨如轨迹
      // 小型鱼围绕礁盘游牧, 大型鱼全图巡游
      const cx = spec.size < 3 ? 38 : 0;
      const cz = spec.size < 3 ? -28 : 0;
      center.set(
        cx + Math.sin(t * 0.045 + school.phase) * spec.roam * 0.6,
        (spec.band[0] + spec.band[1]) / 2 + Math.sin(t * 0.09 + school.phase * 2) * 0.8,
        cz + Math.cos(t * 0.052 + school.phase * 0.7) * spec.roam * 0.6,
      );
      const n = agents.length;
      for (let i = 0; i < n; i++) {
        const f = agents[i];
        const goal = this.tmpV.copy(center).add(f.offset);
        // 聚向群中心(带个体占位)
        f.vel.addScaledVector(this.tmpV.copy(goal).sub(f.pos), 0.16 * dt);
        // 分离(抽样两个同伴)
        for (const j of [(i + 1) % n, (i + 3) % n]) {
          if (j === i) continue;
          this.tmpV.copy(f.pos).sub(agents[j].pos);
          const d2 = this.tmpV.lengthSq();
          if (d2 < spec.size * spec.size * 0.8 && d2 > 1e-4) {
            f.vel.addScaledVector(this.tmpV.normalize(), 1.6 * dt);
          }
        }
        // 游动起伏
        f.vel.y += Math.sin(t * 1.3 + f.phase) * 0.28 * dt;
        // 污染云规避
        if (pollution) {
          this.tmpV.copy(f.pos).sub(pollution.center);
          const d = this.tmpV.length();
          if (d < pollution.radius + spec.size) {
            f.vel.addScaledVector(this.tmpV.normalize(), (pollution.radius + spec.size - d) * 0.8 * dt);
          }
        }
        // 地形规避: 前方采样
        const ahead = this.tmpV.copy(f.pos).addScaledVector(f.vel, 0.5);
        const hAhead = this.heightAt(ahead.x, ahead.z);
        if (hAhead != null && f.pos.y < hAhead + spec.size * 0.5 + 0.35) f.vel.y += 2.4 * dt;
        // 深度带约束
        if (f.pos.y > spec.band[1]) f.vel.y -= 0.9 * dt;
        if (f.pos.y < spec.band[0]) f.vel.y += 0.9 * dt;
        // 场界回拉
        if (f.pos.length() > TERRAIN_HALF * 1.05) {
          this.tmpV.set(0, f.pos.y, 0).sub(f.pos);
          f.vel.addScaledVector(this.tmpV.normalize(), 2.2 * dt);
        }
        // 速度限制
        const sp = f.vel.length();
        const k = THREE.MathUtils.clamp(sp, spec.speed * 0.55, spec.speed * 1.35) / (sp || 1);
        f.vel.multiplyScalar(k);
        f.pos.addScaledVector(f.vel, dt);
        // 硬约束在水面与海底之间
        const hHere = this.heightAt(f.pos.x, f.pos.z) ?? -7;
        const minY = Math.min(hHere + spec.size * 0.45 + 0.3, -0.9 - spec.size * 0.2);
        if (f.pos.y < minY) { f.pos.y = minY; f.vel.y = Math.abs(f.vel.y) * 0.5; }
        if (f.pos.y > -0.8) { f.pos.y = -0.8; f.vel.y = -Math.abs(f.vel.y); }

        f.obj.position.copy(f.pos);
        // 朝向速度方向(模型经 yawFix 预旋转)
        this.tmpV.copy(f.pos).add(f.vel);
        look.lookAt(f.pos, this.tmpV, this.up);
        this.tmpQ.setFromRotationMatrix(look);
        f.obj.quaternion.slerp(this.tmpQ, Math.min(1, 5 * dt));
        if (f.action) f.action.timeScale = 0.6 + (f.vel.length() / spec.speed) * 0.7;
        f.mixer?.update(dt);
      }
    }
  }

  // ---------- 总更新 ----------
  /** 物种群首个个体位置(跟随相机等外部用途), 不存在返回 null */
  getSpeciesAnchor(file: string, target: THREE.Vector3): THREE.Vector3 | null {
    const f = this.schools.find((s) => s.spec.file === file)?.agents[0];
    return f ? target.copy(f.pos) : null;
  }

  // ---------- 总更新 ----------
  update(dt: number, t: number, pollution: { center: THREE.Vector3; radius: number } | null): void {
    this.terrainUniforms.uTime.value = t;
    this.kelpUniforms.uTime.value = t;
    this.snowUniforms.uTime.value = t;
    this.bubbleUniforms.uTime.value = t;
    this.rayUniforms.uTime.value = t;
    this.undersideUniforms.uTime.value = t;
    this.updateJellies(dt, t);
    this.updateFish(dt, t, pollution);
    this.updateTrail(dt);
    this.updatePlankton(dt, t);
  }

  // ---------- 夜晚彩蛋: 生物荧光浮游(发光浮游生物随泳者缓慢聚拢, 蓝绿辉光) ----------
  private plankton?: THREE.Points;
  private planktonBase?: Float32Array;
  private planktonGlow = 0; // 0=白天关闭, 1=夜晚全亮(渐变)

  /** 夜晚荧光强度(0..1), 由环境控制器随昼夜渐变驱动 */
  setPlanktonGlow(k: number): void {
    this.planktonGlow = THREE.MathUtils.clamp(k, 0, 1);
    if (!this.plankton && this.planktonGlow > 0.01) this.buildPlankton();
    if (this.plankton) this.plankton.visible = this.planktonGlow > 0.01;
  }

  private buildPlankton(): void {
    const N = 420;
    const pos = new Float32Array(N * 3);
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 46;
      pos[i * 3 + 1] = -3 - Math.random() * 26;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 46;
      seeds[i * 3] = Math.random() * Math.PI * 2;
      seeds[i * 3 + 1] = 0.4 + Math.random() * 0.9;
      seeds[i * 3 + 2] = 0.5 + Math.random() * 1.4;
    }
    this.planktonBase = pos.slice();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // 每点辉光尺寸写入attribute, 顶点着色器风格用PointsMaterial+尺寸差近似: 直接两种尺寸层
    const mat = new THREE.PointsMaterial({
      color: 0x53f2d3, size: 0.85, map: this.makeGlowDotTexture(), transparent: true,
      opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.plankton = new THREE.Points(geo, mat);
    this.plankton.visible = false;
    this.root.add(this.plankton);
    this.plankton.userData.seeds = seeds;
  }

  private makeGlowDotTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
      grad.addColorStop(0, 'rgba(180,255,240,1)');
      grad.addColorStop(0.35, 'rgba(83,242,211,.55)');
      grad.addColorStop(1, 'rgba(83,242,211,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 64);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private updatePlankton(dt: number, t: number): void {
    if (!this.plankton || this.planktonGlow <= 0.01) return;
    const mat = this.plankton.material as THREE.PointsMaterial;
    mat.opacity = this.planktonGlow * (0.55 + Math.sin(t * 1.7) * 0.18); // 整体呼吸
    const attr = this.plankton.geometry.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const base = this.planktonBase as Float32Array;
    const seeds = this.plankton.userData.seeds as Float32Array;
    for (let i = 0; i < arr.length / 3; i++) {
      const s = i * 3;
      arr[s] = base[s] + Math.sin(t * seeds[s + 1] + seeds[s]) * seeds[s + 2] * 2.2;
      arr[s + 1] = base[s + 1] + Math.cos(t * seeds[s + 1] * 0.7 + seeds[s] * 2) * 1.1;
      arr[s + 2] = base[s + 2] + Math.sin(t * 0.6 * seeds[s + 1] + seeds[s] * 3) * seeds[s + 2] * 2.2;
    }
    attr.needsUpdate = true;
  }

  /** 由 OceanWorld 每帧调用: 光束绕Y朝向相机 */
  faceShaftsTo(camera: THREE.Camera): void {
    const camPos = camera.position;
    for (const { mesh } of this.shafts) {
      const wp = this.tmpV.setFromMatrixPosition(mesh.matrixWorld);
      mesh.rotation.y = Math.atan2(camPos.x - wp.x, camPos.z - wp.z);
    }
  }

  private updateTrail(dt: number): void {
    for (const em of this.emitters) {
      const src = em.getPos();
      if (!src) continue;
      em.acc += em.rate * dt;
      while (em.acc >= 1) {
        em.acc -= 1;
        // 找一个死气泡复活
        for (let i = 0; i < this.trailMeta.length; i++) {
          if (this.trailMeta[i] <= 0) {
            this.trailMeta[i] = 1;
            this.trailPos[i * 3] = src.x + (Math.random() - 0.5) * 0.5;
            this.trailPos[i * 3 + 1] = src.y + (Math.random() - 0.5) * 0.3;
            this.trailPos[i * 3 + 2] = src.z + (Math.random() - 0.5) * 0.5;
            break;
          }
        }
      }
    }
    let alive = false;
    for (let i = 0; i < this.trailMeta.length; i++) {
      if (this.trailMeta[i] > 0) {
        alive = true;
        this.trailMeta[i] -= dt * 0.5;
        this.trailPos[i * 3 + 1] += dt * 1.4;
        this.trailPos[i * 3] += Math.sin(i * 3.1 + this.trailPos[i * 3 + 1] * 2) * dt * 0.3;
      } else {
        this.trailPos[i * 3 + 1] = -999; // 藏起来
      }
    }
    this.rovTrail.visible = alive;
    if (alive) (this.rovTrail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    for (const s of this.schools) for (const a of s.agents) a.mixer?.stopAllAction();
    this.root.removeFromParent();
  }
}
