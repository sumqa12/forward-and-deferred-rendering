import { Mesh } from '../core/mesh.js';
import * as geometry from '../core/geometry.js';

export const SCENE_HALF_SIZE = 20;
const GROUND_TILES = 8;

// インデックスから決定的に [0,1) の乱数を作る (設定を変えても同じ物体・ライトが同じ場所に出る)
function hash(i, salt) {
  let x = Math.imul(i + 1, 374761393) ^ Math.imul(salt + 1, 668265263);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function hsv(h, s, v) {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

export class Scene {
  constructor(gl) {
    this.gl = gl;
    this.meshes = {
      box: new Mesh(gl, geometry.box()),
      sphere: new Mesh(gl, geometry.sphere(24, 32)),
      torus: new Mesh(gl, geometry.torus()),
      tile: new Mesh(gl, geometry.plane()),
    };
    // ライトはインスタンスバッファ 1 本にまとめ、ボリューム描画とマーカー描画で共有する
    this.lightBuffer = gl.createBuffer();
    this.volumeMesh = new Mesh(gl, geometry.sphere(12, 16));
    this.volumeVao = this.volumeMesh.createVao(this.lightBuffer);
    this.markerMesh = new Mesh(gl, geometry.sphere(6, 8));
    this.markerVao = this.markerMesh.createVao(this.lightBuffer);

    this.ambient = [0.025, 0.028, 0.04];
    this.dirLightDir = [0.35, 0.8, 0.45]; // 光源へ向かう方向 (ワールド)
    this.dirLightColor = [0.07, 0.08, 0.11];
    this.background = [0.008, 0.01, 0.018];

    this.objects = [];
    this.lightCount = 0;
    this.lightWorld = new Float32Array(0); // xyz + 半径
    this.lightColor = new Float32Array(0); // rgb (強度込み) + 0
    this.lightGpu = new Float32Array(0); // インスタンスバッファ用にインターリーブ
    this.config = {};
  }

  configure({ grid, transparent, lightCount, lightRadius, lightIntensity }) {
    const c = this.config;
    if (c.grid !== grid || c.transparent !== transparent) this.buildObjects(grid, transparent);
    if (c.lightCount !== lightCount) {
      this.lightCount = lightCount;
      this.lightWorld = new Float32Array(lightCount * 4);
      this.lightColor = new Float32Array(lightCount * 4);
      this.lightGpu = new Float32Array(lightCount * 8);
    }
    this.config = { grid, transparent, lightCount, lightRadius, lightIntensity };
  }

  buildObjects(grid, transparent) {
    const objects = [];
    const H = SCENE_HALF_SIZE;
    // 地面は 1 枚ではなくタイルに分割する。
    // Forward のライトカリングはオブジェクト単位なので、巨大な 1 枚だと全ライトが当たってしまう。
    const tileSize = (2 * H) / GROUND_TILES;
    for (let tz = 0; tz < GROUND_TILES; tz++) {
      for (let tx = 0; tx < GROUND_TILES; tx++) {
        const shade = (tx + tz) % 2 ? 0.42 : 0.5;
        objects.push({
          mesh: this.meshes.tile,
          position: [-H + (tx + 0.5) * tileSize, 0, -H + (tz + 0.5) * tileSize],
          scale: tileSize,
          spin: 0,
          rotY: 0,
          material: { albedo: [shade, shade, shade * 1.04], specular: 0.25, shininess: 24, opacity: 1 },
          transparent: false,
        });
      }
    }

    const spacing = (2 * H) / grid;
    const baseScale = Math.min(1.1, spacing * 0.32);
    for (let gz = 0; gz < grid; gz++) {
      for (let gx = 0; gx < grid; gx++) {
        const id = gz * 64 + gx;
        const pick = hash(id, 1);
        const mesh = pick < 0.4 ? this.meshes.box : pick < 0.75 ? this.meshes.sphere : this.meshes.torus;
        const scale = baseScale * (0.75 + 0.5 * hash(id, 2));
        const hue = hash(id, 3);
        const glass = transparent && hash(id, 5) < 0.3;
        const material = glass
          ? { albedo: hsv(hue, 0.35, 0.95), specular: 1.0, shininess: 96, opacity: 0.35 }
          : {
              albedo: hsv(hue, 0.55, 0.8),
              specular: 0.2 + 0.8 * hash(id, 4),
              shininess: 8 + 120 * hash(id, 6),
              opacity: 1,
            };
        objects.push({
          mesh,
          position: [-H + (gx + 0.5) * spacing, scale * 1.02, -H + (gz + 0.5) * spacing],
          scale,
          spin: (hash(id, 7) - 0.5) * 1.2,
          rotY: hash(id, 8) * Math.PI * 2,
          material,
          transparent: glass,
        });
      }
    }
    for (const o of objects) {
      o.baseRotY = o.rotY;
      o.radius = o.mesh.radius * o.scale;
    }
    this.objects = objects;
  }

  update(time) {
    const H = SCENE_HALF_SIZE * 0.95;
    const { lightRadius, lightIntensity } = this.config;
    for (let i = 0; i < this.lightCount; i++) {
      const bx = (hash(i, 11) * 2 - 1) * H;
      const bz = (hash(i, 12) * 2 - 1) * H;
      const by = 0.4 + hash(i, 13) * 2.2;
      const orbit = 0.5 + hash(i, 14) * 2.5;
      const speed = (0.2 + hash(i, 15) * 0.8) * (hash(i, 19) < 0.5 ? -1 : 1);
      const phase = hash(i, 16) * Math.PI * 2;
      const a = time * speed + phase;
      const color = hsv(hash(i, 17), 0.45 + 0.55 * hash(i, 18), 1);

      const w = this.lightWorld, c = this.lightColor, g = this.lightGpu;
      const p = i * 4;
      w[p] = bx + Math.cos(a) * orbit;
      w[p + 1] = by + Math.sin(a * 1.7) * 0.3;
      w[p + 2] = bz + Math.sin(a) * orbit;
      w[p + 3] = lightRadius;
      c[p] = color[0] * lightIntensity;
      c[p + 1] = color[1] * lightIntensity;
      c[p + 2] = color[2] * lightIntensity;
      c[p + 3] = 0;
      g.set(w.subarray(p, p + 4), i * 8);
      g.set(c.subarray(p, p + 4), i * 8 + 4);
    }
    for (const o of this.objects) o.rotY = o.baseRotY + o.spin * time;
  }

  uploadLights() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lightBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lightGpu, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
}
