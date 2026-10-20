import { Program, RenderTargetSet, drawFullscreen } from '../core/gl-utils.js';
import {
  MESH_VS, GBUFFER_FS, FULLSCREEN_VS, DEFERRED_AMBIENT_FS, LIGHT_VOLUME_VS, LIGHT_VOLUME_FS,
} from './shaders.js';
import { drawLightMarkers } from './light-markers.js';

// ディファードレンダリング:
//   G-buffer パス (表面情報だけ書く) → 深度コピー → ライティング (全画面の環境光 + 点光源ボリューム)
//   → ライトマーカー → 半透明 (Forward で追加描画 = ハイブリッド)
export class DeferredRenderer {
  constructor(gl, objectPass, markerProgram) {
    this.gl = gl;
    this.name = 'Deferred';
    this.objectPass = objectPass;
    this.markerProgram = markerProgram;
    this.gbufferProgram = new Program(gl, MESH_VS, GBUFFER_FS);
    this.ambientProgram = new Program(gl, FULLSCREEN_VS, DEFERRED_AMBIENT_FS);
    this.volumeProgram = new Program(gl, LIGHT_VOLUME_VS, LIGHT_VOLUME_FS);
    this.volumeHeatProgram = new Program(gl, LIGHT_VOLUME_VS, LIGHT_VOLUME_FS, { HEATMAP: 1 });
    this.targets = new RenderTargetSet(gl);
    this.key = '';
  }

  resize(width, height) {
    const key = `${width}x${height}`;
    if (key === this.key) return;
    this.key = key;
    const gl = this.gl;
    const t = this.targets;
    t.dispose();
    // G-buffer: 解像度に比例してメモリと帯域を消費する (Deferred の欠点)
    this.gAlbedo = t.texture(width, height, gl.RGBA8);
    this.gNormal = t.texture(width, height, gl.RGBA16F);
    this.gDepth = t.texture(width, height, gl.DEPTH_COMPONENT24);
    this.gbufferFbo = t.framebuffer([this.gAlbedo, this.gNormal], this.gDepth);
    // ライティング結果 (HDR)。深度は G-buffer からコピーし、ボリュームの深度テストと半透明の遮蔽に使う。
    // G-buffer の深度テクスチャを直接アタッチすると、サンプリングと同時に使えない (フィードバックループ)。
    this.colorTexture = t.texture(width, height, gl.RGBA16F, gl.LINEAR);
    const depth = t.renderbuffer(width, height, gl.DEPTH_COMPONENT24);
    this.lightFbo = t.framebuffer([this.colorTexture], depth);
  }

  render(frame, opts, timer, stats) {
    const gl = this.gl;
    const { width, height, scene } = frame;
    const heatmap = opts.view === 'heatmap';
    this.resize(width, height);

    // ---- 1. G-buffer パス
    timer.begin('deferred:G-buffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbufferFbo);
    gl.viewport(0, 0, width, height);
    gl.depthMask(true);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);

    const gp = this.gbufferProgram;
    gl.useProgram(gp.program);
    gl.uniformMatrix4fv(gp.u.uProjection, false, frame.projection);
    const drawToGBuffer = (objects) => {
      for (const o of objects) {
        const m = o.material;
        gl.uniformMatrix4fv(gp.u.uModelView, false, o.modelView);
        gl.uniform3fv(gp.u.uAlbedo, m.albedo);
        gl.uniform1f(gp.u.uSpecular, m.specular);
        gl.uniform1f(gp.u.uShininess, m.shininess);
        gl.bindVertexArray(o.mesh.vao);
        o.mesh.draw(stats);
      }
    };
    drawToGBuffer(frame.opaque);
    // 「G-buffer に書く」を選ぶと半透明も不透明として書かれてしまう (1 ピクセルに 1 面しか持てない)
    if (opts.transparent && opts.deferredTransparency === 'gbuffer') drawToGBuffer(frame.transparent);
    timer.end();

    // ---- 2. 深度をライティング用 FBO へコピー
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.gbufferFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.lightFbo);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lightFbo);

    // ---- 3. ライティングパス
    timer.begin('deferred:ライティング');
    this.bindGBuffer();
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    if (heatmap) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      const ap = this.ambientProgram;
      gl.useProgram(ap.program);
      this.setGBufferUniforms(ap, frame);
      gl.uniform3fv(ap.u.uAmbient, scene.ambient);
      gl.uniform3fv(ap.u.uDirLightDir, frame.dirLightView);
      gl.uniform3fv(ap.u.uDirLightColor, scene.dirLightColor);
      gl.uniform3fv(ap.u.uBackground, scene.background);
      drawFullscreen(gl, stats);
    }

    if (scene.lightCount > 0) {
      const vp = heatmap ? this.volumeHeatProgram : this.volumeProgram;
      gl.useProgram(vp.program);
      this.setGBufferUniforms(vp, frame);
      gl.uniformMatrix4fv(vp.u.uView, false, frame.view);
      gl.uniformMatrix4fv(vp.u.uViewProjection, false, frame.viewProjection);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      // 裏面を描くとカメラがボリューム内にあっても欠けない
      gl.cullFace(gl.FRONT);
      if (opts.volumeDepthTest) {
        // 裏面より奥にある表面はライトの範囲外 → ピクセルシェーダーを起動しない
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.GEQUAL);
      }
      gl.bindVertexArray(scene.volumeVao);
      scene.volumeMesh.drawInstanced(scene.lightCount, stats);
      gl.cullFace(gl.BACK);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    timer.end();

    if (opts.markers && !heatmap) {
      drawLightMarkers(gl, this.markerProgram, frame, stats);
    }

    // ---- 4. 半透明はフォワードで追加描画 (ハイブリッド)
    if (opts.transparent && opts.deferredTransparency === 'hybrid') {
      timer.begin('deferred:半透明(Forward)');
      this.objectPass.drawLit(frame, frame.transparent, {
        maxLights: opts.maxLightsPerPass, heatmap, transparent: true, depthEqual: false,
      }, stats);
      timer.end();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    stats.targetBytes = this.targets.bytes;
    stats.samples = 0;
    return {
      color: this.colorTexture,
      gbuffer: { albedo: this.gAlbedo, normal: this.gNormal, depth: this.gDepth },
    };
  }

  bindGBuffer() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gAlbedo);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gNormal);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.gDepth);
    gl.activeTexture(gl.TEXTURE0);
  }

  setGBufferUniforms(program, frame) {
    const gl = this.gl;
    gl.uniform1i(program.u.uGAlbedo, 0);
    gl.uniform1i(program.u.uGNormal, 1);
    gl.uniform1i(program.u.uGDepth, 2);
    gl.uniformMatrix4fv(program.u.uInvProjection, false, frame.invProjection);
    gl.uniform2f(program.u.uInvSize, 1 / frame.width, 1 / frame.height);
  }
}
