import * as m4 from '../core/math.js';

// 1 フレーム分の、カメラに依存する共通データ。
// 比較モードでは Forward / Deferred の両方が同じ FrameData を使う。
export class FrameData {
  constructor() {
    this.view = m4.create();
    this.projection = m4.create();
    this.invProjection = m4.create();
    this.viewProjection = m4.create();
    this.viewLights = new Float32Array(0); // ビュー空間の xyz + 半径
    this.dirLightView = [0, 1, 0];
    this.opaque = [];
    this.transparent = [];
    this.model = m4.create();
  }

  build(scene, camera, width, height) {
    this.scene = scene;
    this.width = width;
    this.height = height;
    this.near = camera.near;
    this.far = camera.far;
    this.view.set(camera.view);
    this.projection.set(camera.projection);
    m4.invert(this.invProjection, this.projection);
    m4.multiply(this.viewProjection, this.projection, this.view);

    const n = scene.lightCount;
    if (this.viewLights.length !== n * 4) this.viewLights = new Float32Array(n * 4);
    const w = scene.lightWorld;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      m4.transformPoint(this.view, w[p], w[p + 1], w[p + 2], this.viewLights, p);
      this.viewLights[p + 3] = w[p + 3];
    }
    const d = scene.dirLightDir;
    m4.transformDirection(this.view, d[0], d[1], d[2], this.dirLightView);

    this.opaque.length = 0;
    this.transparent.length = 0;
    for (const o of scene.objects) {
      o.modelView ??= m4.create();
      m4.fromTRS(this.model, o.position[0], o.position[1], o.position[2], o.rotY, o.scale);
      m4.multiply(o.modelView, this.view, this.model);
      o.viewDepth = -o.modelView[14];
      (o.transparent ? this.transparent : this.opaque).push(o);
    }
    // 不透明は手前から (早期 Z で無駄を減らす)、半透明は奥から (正しいブレンドのため)
    this.opaque.sort((a, b) => a.viewDepth - b.viewDepth);
    this.transparent.sort((a, b) => b.viewDepth - a.viewDepth);
  }
}
