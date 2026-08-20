/**
 * 环境系统 —— 昼夜/天气模式的光照-天空-水体-雾全场景渐变控制。
 *
 * 时间模式: day(晴白昼) / sunset(黄昏) / night(夜晚: 星空+月光+水下生物荧光) / auto(慢速循环)
 * 天气模式: clear / cloudy / rain(雨幕+更暗+浪更乱)
 * 所有参数按关键帧插值, 每帧向目标平滑过渡(切换无跳变);
 * 夜晚彩蛋: 星空缓旋、月光、水下荧光浮游(UnderwaterWorld.setPlanktonGlow)。
 */

import * as THREE from 'three';
import type { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { Water } from 'three/examples/jsm/objects/Water.js';

export type TimeMode = 'day' | 'sunset' | 'night' | 'auto';
export type WeatherMode = 'clear' | 'cloudy' | 'rain';

interface EnvParams {
  sunElevDeg: number;      // 太阳仰角(负=地平线下→夜晚)
  sunIntensity: number;
  sunColor: number;
  hemiIntensity: number;
  turbidity: number;       // Sky 浑浊度
  rayleigh: number;
  mie: number;
  exposure: number;
  fogColor: number;        // 水面雾
  fogDensity: number;
  waterColor: number;
  distortion: number;      // 水面波浪扰动
  starOpacity: number;
  moonOpacity: number;
  nightGlow: number;       // 水下荧光强度
  rain: number;            // 雨量(0=无雨)
}

const DAY_SUN_AZIMUTH = 128; // 与原场景太阳方位一致

function presets(): Record<'day' | 'sunset' | 'night', EnvParams> {
  return {
    day: {
      sunElevDeg: 32, sunIntensity: 2.6, sunColor: 0xfff1dc, hemiIntensity: 0.55,
      turbidity: 3.2, rayleigh: 2.6, mie: 0.004, exposure: 0.56,
      fogColor: 0xd7e9f0, fogDensity: 0.00045, waterColor: 0x0e4a56, distortion: 2.6,
      starOpacity: 0, moonOpacity: 0, nightGlow: 0, rain: 0,
    },
    sunset: {
      sunElevDeg: 6, sunIntensity: 2.1, sunColor: 0xffb37a, hemiIntensity: 0.34,
      turbidity: 6.5, rayleigh: 3.4, mie: 0.0075, exposure: 0.5,
      fogColor: 0xe8c9b0, fogDensity: 0.0007, waterColor: 0x33305a, distortion: 2.9,
      starOpacity: 0.25, moonOpacity: 0.1, nightGlow: 0.15, rain: 0,
    },
    night: {
      sunElevDeg: -14, sunIntensity: 0.22, sunColor: 0x9db8e8, hemiIntensity: 0.1,
      turbidity: 1.4, rayleigh: 0.16, mie: 0.002, exposure: 0.3,
      fogColor: 0x0a1626, fogDensity: 0.0009, waterColor: 0x071827, distortion: 2.2,
      starOpacity: 1, moonOpacity: 1, nightGlow: 1, rain: 0,
    },
  };
}

/** 天气叠加修正(与时间模式正交相乘/相加) */
function weatherMods(mode: WeatherMode): Partial<EnvParams> {
  if (mode === 'cloudy') {
    return { sunIntensity: 0.62, turbidity: 9, rayleigh: 1.1, mie: 0.009, exposure: -0.06, fogDensity: 1.9, waterColor: 0x1c3a45, distortion: 3.5 };
  }
  if (mode === 'rain') {
    return { sunIntensity: 0.42, turbidity: 12, rayleigh: 0.8, mie: 0.012, exposure: -0.13, fogDensity: 2.8, waterColor: 0x16303a, distortion: 4.4, rain: 1 };
  }
  return {};
}

function cloneParams(p: EnvParams): EnvParams {
  return { ...p };
}

/** auto 模式全周期秒数: 白天≈95s → 黄昏≈25s → 夜晚≈70s → 黎明≈20s */
const AUTO_PERIOD = 210;
function lerpParams(a: EnvParams, b: EnvParams, k: number, out: EnvParams): void {
  const ka = 1 - k;
  for (const key of Object.keys(a) as Array<keyof EnvParams>) {
    if (key === 'sunColor' || key === 'fogColor' || key === 'waterColor') continue; // 颜色由调用方单独插值
    (out[key] as number) = (a[key] as number) * ka + (b[key] as number) * k;
  }
}
export class EnvironmentController {
  private group = new THREE.Group();
  private stars?: THREE.Points;
  private moon?: THREE.Mesh;
  private rainMesh?: THREE.LineSegments;
  private rainBase?: Float32Array;
  private sunDir = new THREE.Vector3();
  private tmpColorA = new THREE.Color();
  private tmpColorB = new THREE.Color();
  private current: EnvParams;
  private target: EnvParams;
  private timeMode: TimeMode = 'day';
  private weather: WeatherMode = 'clear';
  private autoStart = 0;
  private underwater = false;
  private lastAutoKey = '';

  constructor(
    private scene: THREE.Scene,
    private sunLight: THREE.DirectionalLight,
    private hemi: THREE.HemisphereLight,
    private sky: Sky,
    private water: Water,
    private renderer: THREE.WebGLRenderer,
    private applyPlanktonGlow: (k: number) => void,
  ) {
    this.current = cloneParams(presets().day);
    this.target = cloneParams(presets().day);
    this.buildStars();
    this.buildMoon();
    this.buildRain();
    this.scene.add(this.group);
    this.applyCurrent();
  }

  setTime(mode: TimeMode): void {
    this.timeMode = mode;
    if (mode === 'auto') this.autoStart = performance.now();
    this.retarget();
  }

  setWeather(mode: WeatherMode): void {
    this.weather = mode;
    this.retarget();
  }

  getTimeMode(): TimeMode { return this.timeMode; }
  getWeatherMode(): WeatherMode { return this.weather; }

  /** auto 模式下当前所处时段标签(HUD展示) */
  get autoPhaseLabel(): string {
    if (this.timeMode !== 'auto') return '';
    const k = this.autoKey();
    if (k < 0.45) return '白天';
    if (k < 0.58) return '黄昏';
    if (k < 0.9) return '夜晚';
    return '黎明';
  }

  private autoKey(): number {
    return ((performance.now() - this.autoStart) / 1000 / AUTO_PERIOD) % 1;
  }

  private retarget(): void {
    const base = presets();
    const mods = weatherMods(this.weather);
    const applyMods = (p: EnvParams): EnvParams => {
      const out = cloneParams(p);
      for (const [k, v] of Object.entries(mods)) {
        if (k === 'exposure' || k === 'fogDensity' || k === 'distortion') {
          // 乘性/增量修正
          if (k === 'exposure') out.exposure = p.exposure + (v as number);
          else out[k] = (p[k] as number) * (v as number);
        } else {
          (out[k as keyof EnvParams] as number) = v as number;
        }
      }
      return out;
    };
    if (this.timeMode === 'auto') {
      this.target = applyMods(this.autoBlend(base)); // auto 每帧重定目标
    } else {
      this.target = applyMods(base[this.timeMode]);
    }
  }

  /** auto 循环关键帧: 白天(0~0.45) → 黄昏(0.45~0.58) → 夜晚(0.58~0.9) → 黎明回白天 */
  private autoBlend(base: Record<'day' | 'sunset' | 'night', EnvParams>): EnvParams {
    const k = this.autoKey();
    const out = cloneParams(base.day);
    const blend = (a: EnvParams, b: EnvParams, f: number) => {
      lerpParams(a, b, f, out);
      this.tmpColorA.setHex(a.sunColor); this.tmpColorB.setHex(b.sunColor);
      out.sunColor = this.tmpColorA.lerp(this.tmpColorB, f).getHex();
      this.tmpColorA.setHex(a.fogColor); this.tmpColorB.setHex(b.fogColor);
      out.fogColor = this.tmpColorA.lerp(this.tmpColorB, f).getHex();
      this.tmpColorA.setHex(a.waterColor); this.tmpColorB.setHex(b.waterColor);
      out.waterColor = this.tmpColorA.lerp(this.tmpColorB, f).getHex();
    };
    if (k < 0.45) Object.assign(out, base.day);
    else if (k < 0.58) blend(base.day, base.sunset, (k - 0.45) / 0.13);
    else if (k < 0.9) blend(base.sunset, base.night, (k - 0.58) / 0.32);
    else blend(base.night, base.day, (k - 0.9) / 0.1);
    return out;
  }

  /** 每帧: 向目标插值并下发到场景对象 */
  update(dt: number, t: number, camera: THREE.Camera, underwater: boolean): void {
    this.underwater = underwater;
    if (this.timeMode === 'auto') this.retarget();
    const k = 1 - Math.exp(-dt * 1.6); // 平滑追赶
    lerpParams(this.current, this.target, k, this.current);
    // 颜色通道插值(lerpParams跳过了颜色)
    for (const key of ['sunColor', 'fogColor', 'waterColor'] as const) {
      const from = this.tmpColorA.setHex(this.current[key]);
      const to = this.tmpColorB.setHex(this.target[key]);
      this.current[key] = from.lerp(to, k).getHex();
    }
    this.applyCurrent();

    // 星空缓旋 + 雨幕跟随相机 + 雨滴下落
    if (this.stars) this.stars.rotation.y = t * 0.004;
    if (this.rainMesh && this.rainMesh.visible) this.updateRain(dt, camera);
  }

  private applyCurrent(): void {
    const c = this.current;
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - c.sunElevDeg), THREE.MathUtils.degToRad(DAY_SUN_AZIMUTH));
    this.sunLight.position.copy(this.sunDir).multiplyScalar(600);
    this.sunLight.intensity = c.sunIntensity;
    this.sunLight.color.setHex(c.sunColor);
    this.hemi.intensity = this.underwater ? Math.min(c.hemiIntensity, 0.35) : c.hemiIntensity;
    const skyU = this.sky.material.uniforms;
    skyU.turbidity.value = c.turbidity;
    skyU.rayleigh.value = c.rayleigh;
    skyU.mieCoefficient.value = c.mie;
    skyU.sunPosition.value.copy(this.sunDir);
    // 水下视觉由后处理着色主导, 曝光比水面略抬但不超过白天水下亮度
    this.renderer.toneMappingExposure = this.underwater ? Math.min(0.6, c.exposure + 0.14) : c.exposure;
    const waterMat = this.water.material as THREE.ShaderMaterial;
    waterMat.uniforms.sunDirection.value.copy(this.sunDir);
    waterMat.uniforms.waterColor.value.setHex(c.waterColor);
    waterMat.uniforms.distortionScale.value = c.distortion;
    // 雾由 OceanWorld.applyDepthVisuals 管理: 暴露目标色供其取用
  }

  /** 当前环境的水面雾参数(OceanWorld.applyDepthVisuals 渐变时读取) */
  get surfaceFog(): { color: number; density: number } {
    return { color: this.current.fogColor, density: this.current.fogDensity };
  }

  get nightGlow(): number { return this.current.nightGlow; }
  get isNight(): boolean { return this.current.starOpacity > 0.5; }

  // ---------- 星空 / 月亮 / 雨 ----------
  private buildStars(): void {
    const N = 1400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      // 均匀半球(仰角>8°), 半径略小于天空盒
      const theta = Math.random() * Math.PI * 2;
      const elev = Math.acos(Math.random() * 0.92 + 0.06); // 偏向天顶
      const r = 8600;
      pos[i * 3] = Math.sin(elev) * Math.cos(theta) * r;
      pos[i * 3 + 1] = Math.cos(elev) * r;
      pos[i * 3 + 2] = Math.sin(elev) * Math.sin(theta) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xcfe6ff, size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0,
      depthWrite: false,
    });
    this.stars = new THREE.Points(geo, mat);
    this.group.add(this.stars);
  }

  private buildMoon(): void {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(64, 64, 20, 64, 64, 62);
      grad.addColorStop(0, 'rgba(255,252,240,1)');
      grad.addColorStop(0.82, 'rgba(240,240,225,.95)');
      grad.addColorStop(1, 'rgba(240,240,225,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(64, 64, 62, 0, Math.PI * 2);
      ctx.fill();
      // 月海阴影
      ctx.fillStyle = 'rgba(180,185,180,.5)';
      ctx.beginPath(); ctx.arc(48, 52, 13, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(70, 74, 9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(80, 46, 6, 0, Math.PI * 2); ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.moon = new THREE.Mesh(
      new THREE.PlaneGeometry(190, 190),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
    );
    this.moon.position.set(-2600, 1900, -3300);
    this.moon.lookAt(0, 0, 0);
    this.group.add(this.moon);
  }

  private buildRain(): void {
    const N = 850;
    const pos = new Float32Array(N * 2 * 3); // 每滴两点成线
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 90;
      const y = Math.random() * 60;
      const z = (Math.random() - 0.5) * 90;
      pos.set([x, y, z, x + 0.25, y + 2.6, z], i * 6);
    }
    this.rainBase = pos.slice();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rainMesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0xb8d4e8, transparent: true, opacity: 0.34, depthWrite: false,
    }));
    this.rainMesh.visible = false;
    this.group.add(this.rainMesh);
  }

  private updateRain(dt: number, camera: THREE.Camera): void {
    const mesh = this.rainMesh;
    if (!mesh || !this.rainBase) return;
    mesh.position.set(camera.position.x, 0, camera.position.z); // 雨幕跟随泳者
    const attr = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const speed = 46 * dt;
    for (let i = 0; i < arr.length / 6; i++) {
      const k = i * 6;
      arr[k + 1] -= speed;
      arr[k + 4] -= speed;
      if (arr[k + 1] < -2) {
        const y = 55 + Math.random() * 8;
        arr[k + 1] = y;
        arr[k + 4] = y + 2.6;
      }
    }
    attr.needsUpdate = true;
  }

  /** 每帧末由 OceanWorld 调用: 星空/月亮/雨/荧光的可见性与强度(受水下状态抑制) */
  applyVisibility(t: number, underwater: boolean): void {
    const c = this.current;
    if (this.stars) {
      const stars = this.stars as THREE.Points;
      (stars.material as THREE.PointsMaterial).opacity = underwater ? 0 : c.starOpacity * (0.85 + Math.sin(t * 2.2) * 0.08);
      stars.visible = !underwater && c.starOpacity > 0.02;
    }
    if (this.moon) {
      (this.moon.material as THREE.MeshBasicMaterial).opacity = underwater ? 0 : c.moonOpacity;
      this.moon.visible = !underwater && c.moonOpacity > 0.02;
    }
    if (this.rainMesh) {
      this.rainMesh.visible = !underwater && c.rain > 0.05;
      (this.rainMesh.material as THREE.LineBasicMaterial).opacity = 0.2 + c.rain * 0.22;
    }
    this.applyPlanktonGlow(underwater ? c.nightGlow : c.nightGlow * 0.4);
  }

  dispose(): void {
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      mat?.dispose();
      const pts = obj as THREE.Points;
      if (pts.material) (pts.material as THREE.Material).dispose();
    });
    this.group.removeFromParent();
  }
}
