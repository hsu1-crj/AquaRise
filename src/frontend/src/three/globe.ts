/**
 * 3D 地球入口：程序化海陆材质、昼夜边缘、云层、星空和全球监测站标记。
 * 不依赖远程贴图或第三方模型，保证演示环境离线可用。
 */
import * as THREE from 'three';

export interface GlobeStation {
  id: number;
  code: string;
  name: string;
  lat: number;
  lng: number;
  region?: string;
  country?: string;
  risk?: number | null;
}

type Phase = 'idle' | 'rotating' | 'zooming' | 'transitioning';

type Marker = {
  station: GlobeStation;
  sprite: THREE.Sprite;
  glow: THREE.Sprite;
  beam: THREE.Mesh;
  latLng: THREE.Vector3;
};

export class EarthGlobe {
  private group = new THREE.Group();
  private sphere: THREE.Mesh;
  private clouds: THREE.Mesh;
  private stars: THREE.Points;
  private rim: THREE.Mesh;
  private markers: Marker[] = [];
  private phase: Phase = 'idle';
  private phaseT = 0;
  private targetQuat = new THREE.Quaternion();
  private onSelect: (station: GlobeStation) => void;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private canvas: HTMLCanvasElement;
  private disposed = false;
  private autoSpin = true;
  private spinVelocity = 0.035;
  private spinResumeTimer = 0;
  private tmpDir = new THREE.Vector3();
  private tmpNormal = new THREE.Vector3();
  private tmpPole = new THREE.Vector3();

  constructor(scene: THREE.Scene, stations: GlobeStation[], onSelect: (s: GlobeStation) => void) {
    this.onSelect = onSelect;
    this.canvas = document.createElement('canvas');

    const fallbackTexture = this.makeEarthTexture();
    const earthMaterial = new THREE.MeshStandardMaterial({ map: fallbackTexture, roughness: 0.78, metalness: 0.03 });
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(100, 128, 88), earthMaterial);
    this.group.add(this.sphere);
    const earthLoader = new THREE.TextureLoader();
    earthLoader.load('/textures/earth_blue_marble.jpg', (texture) => {
      if (this.disposed) { texture.dispose(); return; }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      const previous = earthMaterial.map;
      earthMaterial.map = texture;
      earthMaterial.needsUpdate = true;
      if (previous) previous.dispose();
    }, undefined, () => undefined);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(104, 64, 40),
      new THREE.MeshBasicMaterial({
        color: 0x3bc7ff,
        transparent: true,
        opacity: 0.13,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.group.add(atmosphere);

    this.rim = new THREE.Mesh(
      new THREE.SphereGeometry(102.2, 64, 40),
      new THREE.MeshBasicMaterial({
        color: 0x74e6ff,
        transparent: true,
        opacity: 0.1,
        wireframe: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.group.add(this.rim);

    const cloudTexture = this.makeCloudTexture();
    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(101.6, 72, 48),
      new THREE.MeshStandardMaterial({
        map: cloudTexture,
        transparent: true,
        opacity: 0.2,
        roughness: 1,
        depthWrite: false,
      }),
    );
    this.group.add(this.clouds);

    for (const station of stations) this.addMarker(station);

    const sun = new THREE.DirectionalLight(0xfff3d2, 2.6);
    sun.position.set(180, 100, 180);
    this.group.add(sun);
    this.group.add(new THREE.AmbientLight(0x203d63, 0.7));

    this.stars = this.makeStars();
    this.stars.position.z = -80;
    this.group.add(this.stars);
    this.group.visible = false;
    scene.add(this.group);
  }

  private addMarker(station: GlobeStation): void {
    const position = this.latLngToVec3(station.lat, station.lng, 101.5);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0x53f2ce,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    glow.scale.setScalar(5.5);
    glow.position.copy(position);
    this.group.add(glow);

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.8, 7, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x54f1a9,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    beam.position.copy(position).multiplyScalar(1.035);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), position.clone().normalize());
    this.group.add(beam);

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.makeStationLabel(station.code, station.name),
      transparent: true,
      depthWrite: false,
    }));
    sprite.scale.set(21, 6.7, 1);
    sprite.position.copy(position).multiplyScalar(1.11);
    sprite.userData.stationId = station.id;
    this.group.add(sprite);
    this.markers.push({ station, sprite, glow, beam, latLng: position });
  }

  setStations(stations: GlobeStation[]): void {
    for (const marker of this.markers) {
      this.group.remove(marker.sprite, marker.glow, marker.beam);
      marker.sprite.material.map?.dispose();
      (marker.sprite.material as THREE.SpriteMaterial).dispose();
      (marker.glow.material as THREE.SpriteMaterial).dispose();
      marker.beam.geometry.dispose();
      (marker.beam.material as THREE.Material).dispose();
    }
    this.markers = [];
    for (const station of stations) this.addMarker(station);
  }

  /** 显示地球并将东亚监测区域放在初始正面。 */
  show(camera: THREE.PerspectiveCamera): void {
    if (this.disposed) return;
    this.group.visible = true;
    this.phase = 'idle';
    this.phaseT = 0;
    this.autoSpin = true;
    this.sphere.scale.setScalar(1);
    this.clouds.scale.setScalar(1);
    this.rim.scale.setScalar(1);
    const material = this.sphere.material as THREE.MeshStandardMaterial;
    material.opacity = 1;
    material.transparent = false;
    const cloudMaterial = this.clouds.material as THREE.MeshStandardMaterial;
    cloudMaterial.opacity = 0.2;
    cloudMaterial.transparent = true;
    camera.position.set(0, 18, 285);
    camera.lookAt(0, 0, 0);
    const focus = this.latLngToVec3(30, 122.4, 1).normalize();
    this.group.quaternion.setFromUnitVectors(focus, new THREE.Vector3(0, 0, 1));
  }

  hide(): void {
    this.group.visible = false;
    this.phase = 'idle';
    this.autoSpin = true;
  }

  get isVisible(): boolean {
    return this.group.visible;
  }

  handleClick(clientX: number, clientY: number, camera: THREE.Camera, canvasRect: DOMRect): GlobeStation | null {
    if (this.disposed || !this.group.visible || this.phase !== 'idle') return null;
    this.pointer.set(
      ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1,
      -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, camera);
    const visibleSprites = this.markers.filter((marker) => marker.sprite.visible).map((marker) => marker.sprite);
    const hits = this.raycaster.intersectObjects(visibleSprites, false);
    if (hits.length === 0) return null;
    const station = this.markers.find((marker) => marker.station.id === hits[0].object.userData.stationId)?.station;
    if (!station) return null;
    this.beginTravel(station);
    return station;
  }

  travelTo(stationId: number): GlobeStation | null {
    if (!this.group.visible || this.phase !== 'idle') return null;
    const station = this.markers.find((marker) => marker.station.id === stationId)?.station;
    if (!station) return null;
    this.beginTravel(station);
    return station;
  }

  private beginTravel(station: GlobeStation): void {
    this.phase = 'rotating';
    this.phaseT = 0;
    this.autoSpin = false;
    const focus = this.latLngToVec3(station.lat, station.lng, 1).normalize();
    this.targetQuat.setFromUnitVectors(focus, new THREE.Vector3(0, 0, 1));
    this.onSelect(station);
  }

  update(dt: number, t: number, camera: THREE.PerspectiveCamera): boolean {
    if (!this.group.visible) return false;
    if (this.phase === 'idle' && this.autoSpin) this.group.rotation.y += dt * this.spinVelocity;
    this.clouds.rotation.y -= dt * 0.008;
    this.rim.rotation.y += dt * 0.004;

    const cameraDirection = this.tmpDir.copy(camera.position).normalize();
    for (const marker of this.markers) {
      const pulse = 0.65 + Math.sin(t * 2.5 + marker.station.id) * 0.2;
      (marker.glow.material as THREE.SpriteMaterial).opacity = pulse;
      const normal = this.tmpNormal.copy(marker.latLng).normalize().applyQuaternion(this.group.quaternion);
      const front = normal.dot(cameraDirection) > 0.04;
      marker.sprite.visible = front;
      marker.glow.visible = front;
      marker.beam.visible = front;
    }

    if (this.phase === 'rotating') {
      this.phaseT += dt;
      this.group.quaternion.slerp(this.targetQuat, Math.min(1, dt * 3.2));
      if (this.phaseT >= 1.15) {
        this.phase = 'zooming';
        this.phaseT = 0;
      }
    } else if (this.phase === 'zooming') {
      this.phaseT += dt;
      const progress = Math.min(1, this.phaseT / 1.15);
      const ease = 1 - Math.pow(1 - progress, 4);
      camera.position.z = 285 - ease * 225;
      camera.position.y = 18 - ease * 8;
      this.sphere.scale.setScalar(1 + ease * 0.12);
      this.clouds.scale.setScalar(1 + ease * 0.16);
      this.rim.scale.setScalar(1 + ease * 0.2);
      if (progress >= 1) {
        this.phase = 'transitioning';
        this.phaseT = 0;
      }
    } else if (this.phase === 'transitioning') {
      this.phaseT += dt;
      const progress = Math.min(1, this.phaseT / 0.62);
      const ease = 1 - Math.pow(1 - progress, 3);
      camera.position.z = 60 - ease * 28;
      const material = this.sphere.material as THREE.MeshStandardMaterial;
      material.opacity = 1 - ease;
      material.transparent = true;
      (this.clouds.material as THREE.MeshStandardMaterial).opacity = 0.2 * (1 - ease);
      if (progress >= 1) {
        this.phase = 'idle';
        this.group.visible = false;
        return true;
      }
    }
    return false;
  }

  rotate(dx: number, dy: number): void {
    if (this.phase !== 'idle' || !this.group.visible) return;
    this.autoSpin = false;
    const rotationY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * 0.004);
    const rotationX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * 0.004);
    this.group.quaternion.premultiply(rotationY).premultiply(rotationX);
    // 俯仰钳制: 倾角不超过±85°, 拖过头时回退本次X旋转(防止地极翻转)
    const pole = this.tmpPole.set(0, 1, 0).applyQuaternion(this.group.quaternion);
    if (pole.y < Math.cos(THREE.MathUtils.degToRad(85))) {
      this.group.quaternion.premultiply(rotationX.invert());
    }
    window.clearTimeout(this.spinResumeTimer);
    this.spinResumeTimer = window.setTimeout(() => {
      this.autoSpin = true;
    }, 1800);
  }
  private latLngToVec3(lat: number, lng: number, radius: number): THREE.Vector3 {
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lng);
    return new THREE.Vector3(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta),
    );
  }

  private makeEarthTexture(): THREE.Texture {
    const canvas = this.canvas;
    canvas.width = 2048;
    canvas.height = 1024;
    const context = canvas.getContext('2d')!;
    const ocean = context.createLinearGradient(0, 0, 0, 1024);
    ocean.addColorStop(0, '#0a304f');
    ocean.addColorStop(0.5, '#082544');
    ocean.addColorStop(1, '#031a35');
    context.fillStyle = ocean;
    context.fillRect(0, 0, 2048, 1024);

    const land = (points: number[][], offsetX: number, offsetY: number, scale: number): void => {
      context.beginPath();
      points.forEach(([pointX, pointY], index) => {
        const x = offsetX + pointX * scale;
        const y = offsetY + pointY * scale;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.closePath();
      context.fill();
      context.stroke();
    };
    context.fillStyle = '#397b58';
    context.strokeStyle = 'rgba(126,221,158,.58)';
    context.lineWidth = 2;
    land([[400, 200], [500, 180], [550, 250], [515, 335], [470, 385], [420, 340], [390, 260]], 700, 250, 1.5);
    land([[530, 260], [565, 245], [555, 290], [535, 300]], 700, 250, 1.5);
    land([[590, 270], [625, 250], [635, 300], [605, 330], [585, 290]], 700, 250, 1.5);
    land([[548, 335], [560, 330], [555, 365], [542, 350]], 700, 250, 1.5);
    land([[650, 550], [730, 540], [750, 595], [665, 610]], 700, 250, 1.5);
    land([[100, 150], [210, 135], [195, 230], [120, 260], [75, 200]], 700, 250, 1.5);
    land([[180, 400], [250, 390], [230, 510], [165, 490]], 700, 250, 1.5);
    land([[900, 180], [980, 175], [965, 240], [910, 245]], 700, 250, 1.5);
    land([[950, 300], [1030, 290], [1020, 410], [960, 395]], 700, 250, 1.5);

    context.fillStyle = 'rgba(101,204,255,.2)';
    for (let index = 0; index < 80; index += 1) {
      const x = 720 + Math.random() * 240;
      const y = 510 + Math.random() * 150;
      context.fillRect(x, y, 2 + Math.random() * 8, 2 + Math.random() * 8);
    }
    context.strokeStyle = 'rgba(97,193,255,.1)';
    context.lineWidth = 1;
    for (let x = 0; x <= 2048; x += 2048 / 24) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 1024); context.stroke(); }
    for (let y = 0; y <= 1024; y += 1024 / 12) { context.beginPath(); context.moveTo(0, y); context.lineTo(2048, y); context.stroke(); }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private makeCloudTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const context = canvas.getContext('2d')!;
    for (let index = 0; index < 65; index += 1) {
      const x = Math.random() * 1024;
      const y = 35 + Math.random() * 440;
      const width = 45 + Math.random() * 150;
      const height = 7 + Math.random() * 24;
      context.fillStyle = `rgba(205,239,255,${0.08 + Math.random() * 0.18})`;
      context.beginPath();
      context.ellipse(x, y, width / 2, height / 2, Math.random() * Math.PI, 0, Math.PI * 2);
      context.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private makeStars(): THREE.Points {
    const positions = new Float32Array(360 * 3);
    for (let index = 0; index < positions.length; index += 3) {
      const radius = 380 + Math.random() * 240;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[index] = radius * Math.sin(phi) * Math.cos(theta);
      positions[index + 1] = radius * Math.cos(phi);
      positions[index + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color: 0x9bdcff, size: 1.8, transparent: true, opacity: 0.8, sizeAttenuation: true });
    return new THREE.Points(geometry, material);
  }

  private makeStationLabel(code: string, name: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 76;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgba(3,25,42,.88)';
    context.beginPath();
    context.roundRect(4, 4, 232, 68, 12);
    context.fill();
    context.strokeStyle = '#53f2ce';
    context.lineWidth = 2;
    context.stroke();
    context.textAlign = 'center';
    context.fillStyle = '#eaffff';
    context.font = 'bold 22px Microsoft YaHei, sans-serif';
    context.fillText(code, 120, 31);
    context.fillStyle = '#9fd0e8';
    context.font = '14px Microsoft YaHei, sans-serif';
    context.fillText(name.replace('监测点', ''), 120, 56);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.spinResumeTimer);
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      // 地球/云层/站点标签的 CanvasTexture 与外部贴图需显式释放
      const each = (m: THREE.Material & { map?: THREE.Texture | null }) => {
        m.map?.dispose?.();
        m.dispose();
      };
      if (Array.isArray(material)) material.forEach(each);
      else if (material) each(material);
    });
    this.group.removeFromParent();
  }
}
