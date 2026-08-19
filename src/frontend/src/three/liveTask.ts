/**
 * 实时检测联动叠加层 —— 上传的检测任务实时驱动 3D 场景（检测模式的"数字孪生事件感"）。
 *
 *   任务ROV:  从站点出发, 绕站点样带巡航(探照灯 + 发光体), 检测期间持续作业
 *   检测屏:   悬浮于站点上方的信息屏(Canvas 纹理: 实时标注帧 + 检测框 + 进度 + 检出数)
 *   目标标记: 每个检出目标在作业水层弹出标签标记(类别+置信度), 逐个弹入并缓慢浮动
 *   扫描环:   站点水面扩散的声呐扫描环(任务进行中)
 *
 * 数据全部来自现有后端契约:
 *   /detect/status/{id}.preview_urls(标注帧) + /detect/result/{id}.results(类别/置信度),
 *   图片模式由页面把本地预览图 + 检测框画上屏幕, 不新增任何后端接口。
 */

import * as THREE from 'three';

export interface LiveProgress {
  progress: number; // 0-100
  totalObjects: number; // 累计检出目标数
  processedFrames?: number | null;
  totalFrames?: number | null;
}

export interface LiveTargetItem {
  name: string;
  confidence: number; // 0-1
}

/** 屏幕上叠加的检测框(归一化 0..1, 相对所画图像) */
export interface LiveFrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MARKER_MAX = 48;
const SCREEN_W = 640;
const SCREEN_H = 360;

/** 置信度 → 标记主色 */
function confColor(conf: number): string {
  if (conf >= 0.75) return '#54f1a9';
  if (conf >= 0.5) return '#ffbd66';
  return '#ff7a90';
}

function makeMarkerTexture(name: string, conf: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const color = confColor(conf);
    ctx.fillStyle = 'rgba(4,22,34,.88)';
    ctx.beginPath();
    ctx.roundRect(6, 6, 244, 68, 12);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(128, 74);
    ctx.lineTo(116, 90);
    ctx.lineTo(140, 90);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#eaffff';
    ctx.font = 'bold 26px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(name.slice(0, 8), 128, 38);
    ctx.fillStyle = color;
    ctx.font = '20px "Microsoft YaHei", sans-serif';
    ctx.fillText(`${Math.round(conf * 100)}%`, 128, 62);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class LiveTaskOverlay {
  private group = new THREE.Group();
  private rov = new THREE.Group();
  private screen: THREE.Mesh;
  private bezel: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private texture: THREE.CanvasTexture;
  private scanRing: THREE.Mesh;
  private markers = new THREE.Group();
  private markerQueue: LiveTargetItem[] = [];
  private markerItems: Array<{ sprite: THREE.Sprite; born: number; baseY: number; seed: number }> = [];
  private spawnClock = 0;
  private progress: LiveProgress = { progress: 0, totalObjects: 0 };
  private img: HTMLImageElement | null = null;
  private imgReady = false;
  private boxes: LiveFrameBox[] = [];
  private finished = false;
  private summaryText = '';
  private startedAt = 0;
  private lastDraw = -1;
  private disposed = false;
  private siteCenter = new THREE.Vector3();
  private patrolDepth: number;
  private floorY: number;

  constructor(scene: THREE.Scene, sitePos: THREE.Vector3, siteCode: string, getHeightAt: (x: number, z: number) => number | null) {
    this.siteCenter.copy(sitePos);
    const [cx, cz] = [sitePos.x, sitePos.z];
    this.floorY = Math.min(getHeightAt(cx, cz) ?? -8, -1.2);
    // 巡航深度: 海床上方 3.5m 与 -3.5m 之间取较浅者(保证可见)
    this.patrolDepth = Math.max(this.floorY + 3.5, -4.5);

    // ---------- 任务ROV(紧凑型AUV: 发光浮体 + 探照灯) ----------
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x35e0c8, roughness: 0.4, metalness: 0.5 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c2b36, roughness: 0.55, metalness: 0.4 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 1.7, 4, 10).rotateX(Math.PI / 2), hullMat);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.65, 0.6), darkMat);
    fin.position.set(0, 0.42, -0.7);
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x0b1520, emissive: 0x35e0c8, emissiveIntensity: 2.4 }),
    );
    beacon.position.set(0, 0.55, 0.2);
    this.rov.add(body, fin, beacon);
    const headlight = new THREE.SpotLight(0xcfeaff, 120, 36, 0.6, 0.5, 1.2);
    headlight.position.set(0, -0.1, 1.1);
    const target = new THREE.Object3D();
    target.position.set(0, -1.2, 9);
    this.rov.add(headlight, target);
    headlight.target = target;
    this.rov.position.set(cx + 16, this.patrolDepth, cz);
    this.group.add(this.rov);

    // ---------- 检测屏(Canvas 纹理) ----------
    this.canvas.width = SCREEN_W;
    this.canvas.height = SCREEN_H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.screen = new THREE.Mesh(
      new THREE.PlaneGeometry(7.2, 4.05),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, transparent: true }),
    );
    this.screen.position.set(cx, sitePos.y + 8.2, cz);
    this.bezel = new THREE.Mesh(
      new THREE.PlaneGeometry(7.7, 4.55),
      new THREE.MeshBasicMaterial({ color: 0x06141f, transparent: true, opacity: 0.92 }),
    );
    this.group.add(this.screen, this.bezel);
    this.siteCode = siteCode;

    // ---------- 扫描环 ----------
    const ringGeo = new THREE.RingGeometry(0.96, 1, 72);
    ringGeo.rotateX(-Math.PI / 2);
    this.scanRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0x35e0c8, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.scanRing.position.set(cx, 0.28, cz);
    this.group.add(this.scanRing);

    this.group.add(this.markers);
    scene.add(this.group);
    this.startedAt = performance.now();
    this.draw(performance.now());
  }

  private siteCode = '';

  // ---------- 页面驱动接口 ----------

  setProgress(p: LiveProgress): void {
    this.progress = {
      progress: THREE.MathUtils.clamp(p.progress, 0, 100),
      totalObjects: Math.max(0, Math.round(p.totalObjects)),
      processedFrames: p.processedFrames ?? null,
      totalFrames: p.totalFrames ?? null,
    };
    this.draw(performance.now());
  }

  /** 设置检测屏画面(视频模式传后端标注帧URL; 图片模式传本地预览图URL+归一化检测框) */
  setFrame(url: string, boxes?: LiveFrameBox[]): void {
    const img = new Image();
    img.onload = () => {
      if (this.disposed) return;
      this.img = img;
      this.imgReady = true;
      this.boxes = boxes ?? [];
      this.draw(performance.now());
    };
    img.onerror = () => undefined; // 保留上一帧
    img.src = url;
  }

  /** 喂入检出目标(内部排队, 每0.22s弹出一个制造"逐个标定"节奏) */
  feedTargets(items: LiveTargetItem[]): void {
    for (const it of items) this.markerQueue.push(it);
  }

  /** 任务完成: 屏幕显示总结, 标记与ROV保留展示 */
  finish(summary: string): void {
    this.finished = true;
    this.summaryText = summary;
    this.progress = { ...this.progress, progress: 100 };
    this.draw(performance.now());
  }

  private spawnMarker(item: LiveTargetItem, t: number): void {
    const i = this.markerItems.length;
    // 黄金角螺旋散布, 覆盖站点周围作业水层
    const angle = i * 2.39996;
    const radius = 5 + Math.sqrt(i) * 2.6;
    const x = this.siteCenter.x + Math.cos(angle) * radius;
    const z = this.siteCenter.z + Math.sin(angle) * radius * 0.8;
    const y = THREE.MathUtils.lerp(this.floorY + 1.4, -1.2, (i % 6) / 5);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeMarkerTexture(item.name, item.confidence),
      transparent: true,
      depthWrite: false,
    }));
    sprite.scale.set(0.0, 0.0, 1);
    sprite.position.set(x, y, z);
    this.markers.add(sprite);
    this.markerItems.push({ sprite, born: t, baseY: y, seed: Math.random() * Math.PI * 2 });
  }

  // ---------- 每帧更新(由 OceanWorld.animate 驱动) ----------

  update(dt: number, t: number, camera: THREE.Camera): void {
    // ROV 椭圆样带巡航, 切向朝向
    const a = t * 0.32;
    this.rov.position.set(
      this.siteCenter.x + Math.cos(a) * 15,
      this.patrolDepth + Math.sin(t * 0.6) * 0.5,
      this.siteCenter.z + Math.sin(a) * 10,
    );
    this.rov.rotation.y = -a + Math.PI;

    // 标记排队弹出
    this.spawnClock += dt;
    while (this.spawnClock > 0.22 && this.markerItems.length < MARKER_MAX && this.markerQueue.length > 0) {
      const item = this.markerQueue.shift();
      if (item) this.spawnMarker(item, t);
      this.spawnClock -= 0.22;
    }
    for (const m of this.markerItems) {
      const age = t - m.born;
      const pop = Math.min(1, age / 0.45);
      const ease = 1 - Math.pow(1 - pop, 3); // easeOutCubic
      const w = 4.6 * ease;
      m.sprite.scale.set(w, w * 0.375, 1);
      m.sprite.position.y = m.baseY + Math.sin(t * 1.4 + m.seed) * 0.22;
    }

    // 扫描环周期扩散(完成后停止)
    if (this.scanRing.visible) {
      const f = (t % 4) / 4;
      this.scanRing.scale.setScalar(1 + f * 26);
      (this.scanRing.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - f);
      if (this.finished && f < 0.02) this.scanRing.visible = false;
    }

    // 检测屏始终面向相机
    this.screen.lookAt(camera.position);
    this.bezel.position.copy(this.screen.position);
    this.bezel.quaternion.copy(this.screen.quaternion);
    this.bezel.translateZ(-0.06);

    // Canvas 以 ~8fps 重绘(扫描线动画/计时)
    const nowMs = performance.now();
    if (nowMs - this.lastDraw > 125) this.draw(nowMs);
  }

  // ---------- Canvas 检测屏绘制 ----------

  private draw(nowMs: number): void {
    this.lastDraw = nowMs;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const elapsed = Math.max(0, (nowMs - this.startedAt) / 1000);
    const t = nowMs / 1000;

    ctx.fillStyle = '#04121d';
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

    // 标题栏
    ctx.fillStyle = 'rgba(53,224,200,.12)';
    ctx.fillRect(0, 0, SCREEN_W, 44);
    if (!this.finished) {
      const pulse = 0.5 + Math.sin(t * 4) * 0.5;
      ctx.fillStyle = `rgba(84,241,169,${0.35 + pulse * 0.65})`;
      ctx.beginPath();
      ctx.arc(26, 22, 8, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#54f1a9';
      ctx.beginPath();
      ctx.arc(26, 22, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#eaffff';
    ctx.font = 'bold 22px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`实时检测联动 · ${this.siteCode}`, 44, 23);
    ctx.fillStyle = '#9fd0e8';
    ctx.font = '18px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(this.finished ? '任务完成' : `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`, SCREEN_W - 16, 23);

    // 画面区
    const areaX = 16, areaY = 56, areaW = SCREEN_W - 32, areaH = 244;
    ctx.save();
    ctx.beginPath();
    ctx.rect(areaX, areaY, areaW, areaH);
    ctx.clip();
    if (this.imgReady && this.img) {
      // cover 适配铺满画面区
      const scale = Math.max(areaW / this.img.width, areaH / this.img.height);
      const dw = this.img.width * scale, dh = this.img.height * scale;
      const dx = areaX + (areaW - dw) / 2, dy = areaY + (areaH - dh) / 2;
      ctx.drawImage(this.img, dx, dy, dw, dh);
      // 检测框(归一化坐标 → 画面区)
      for (const b of this.boxes) {
        ctx.strokeStyle = '#ff4d6d';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(dx + b.x * dw, dy + b.y * dh, b.w * dw, b.h * dh);
      }
    } else {
      // 等待画面: 扫描网格 + 移动扫描线
      ctx.strokeStyle = 'rgba(53,224,200,.16)';
      ctx.lineWidth = 1;
      for (let gx = areaX; gx <= areaX + areaW; gx += 40) {
        ctx.beginPath(); ctx.moveTo(gx, areaY); ctx.lineTo(gx, areaY + areaH); ctx.stroke();
      }
      for (let gy = areaY; gy <= areaY + areaH; gy += 40) {
        ctx.beginPath(); ctx.moveTo(areaX, gy); ctx.lineTo(areaX + areaW, gy); ctx.stroke();
      }
      const scanY = areaY + ((t * 90) % areaH);
      const grad = ctx.createLinearGradient(0, scanY - 26, 0, scanY);
      grad.addColorStop(0, 'rgba(53,224,200,0)');
      grad.addColorStop(1, 'rgba(53,224,200,.4)');
      ctx.fillStyle = grad;
      ctx.fillRect(areaX, scanY - 26, areaW, 26);
      ctx.fillStyle = '#9fd0e8';
      ctx.font = '18px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(this.finished ? '无预览画面' : '等待检测画面…', areaX + areaW / 2, areaY + areaH / 2);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(53,224,200,.4)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(areaX + 0.5, areaY + 0.5, areaW - 1, areaH - 1);

    // 进度条 + 统计
    const barY = 316;
    ctx.fillStyle = 'rgba(255,255,255,.1)';
    ctx.fillRect(16, barY, SCREEN_W - 32, 10);
    const barGrad = ctx.createLinearGradient(16, 0, SCREEN_W - 16, 0);
    barGrad.addColorStop(0, '#35e0c8');
    barGrad.addColorStop(1, '#54f1a9');
    ctx.fillStyle = barGrad;
    ctx.fillRect(16, barY, ((SCREEN_W - 32) * this.progress.progress) / 100, 10);
    ctx.fillStyle = '#dff6fa';
    ctx.font = '17px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    const frameText = this.progress.processedFrames != null
      ? `帧 ${this.progress.processedFrames}/${this.progress.totalFrames ?? '—'}`
      : '图片模式';
    ctx.fillText(this.finished ? this.summaryText.slice(0, 30) : frameText, 16, 348);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#54f1a9';
    ctx.fillText(`检出目标 ${this.progress.totalObjects}`, SCREEN_W - 16, 348);

    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.markerQueue.length = 0;
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      mat?.dispose();
      const sprite = obj as THREE.Sprite;
      if (sprite.material) {
        (sprite.material as THREE.SpriteMaterial).map?.dispose();
        (sprite.material as THREE.SpriteMaterial).dispose();
      }
    });
    this.texture.dispose();
    this.group.removeFromParent();
  }
}
