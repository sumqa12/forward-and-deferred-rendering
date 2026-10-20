import { Program, RenderTargetSet, drawFullscreen } from '../core/gl-utils.js';
import { FULLSCREEN_VS, PRESENT_FS, FXAA_FS } from './shaders.js';

export const VIEW_MODES = {
  lit: 0,
  heatmap: 1,
  albedo: 2,
  normal: 3,
  depth: 4,
  specular: 5,
};

// レンダラーの出力 (HDR / G-buffer) を画面へ。トーンマップ・FXAA・デバッグ表示を担当する。
export class PostProcess {
  constructor(gl) {
    this.gl = gl;
    this.presentProgram = new Program(gl, FULLSCREEN_VS, PRESENT_FS);
    this.fxaaProgram = new Program(gl, FULLSCREEN_VS, FXAA_FS);
    this.targets = new RenderTargetSet(gl);
    this.key = '';
  }

  ensureLdr(width, height) {
    const key = `${width}x${height}`;
    if (key === this.key) return;
    this.key = key;
    this.targets.dispose();
    this.ldrTexture = this.targets.texture(width, height, this.gl.RGBA8, this.gl.LINEAR);
    this.ldrFbo = this.targets.framebuffer([this.ldrTexture], null);
  }

  // source: { texture, aux?, mode }, rect: キャンバス上の描画範囲 [x, y, w, h] (分割表示用)
  present(source, frame, canvasSize, rect, opts, stats) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    const useFxaa = opts.fxaa && source.mode === VIEW_MODES.lit;

    if (useFxaa) {
      // FXAA は輝度で判定するのでトーンマップ後の LDR 画像に掛ける
      this.ensureLdr(frame.width, frame.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.ldrFbo);
      gl.viewport(0, 0, frame.width, frame.height);
      this.drawPresent(source, frame, opts, stats);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasSize[0], canvasSize[1]);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect[0], rect[1], rect[2], rect[3]);
    if (useFxaa) {
      const p = this.fxaaProgram;
      gl.useProgram(p.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.ldrTexture);
      gl.uniform1i(p.u.uTex, 0);
      gl.uniform2f(p.u.uTexelSize, 1 / frame.width, 1 / frame.height);
      drawFullscreen(gl, stats);
    } else {
      this.drawPresent(source, frame, opts, stats);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  drawPresent(source, frame, opts, stats) {
    const gl = this.gl;
    const p = this.presentProgram;
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, source.aux ?? source.texture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform1i(p.u.uAux, 1);
    gl.uniform1i(p.u.uMode, source.mode);
    gl.uniform1f(p.u.uExposure, opts.exposure);
    gl.uniform1f(p.u.uHeatMax, opts.heatMax);
    gl.uniform1f(p.u.uNear, frame.near);
    gl.uniform1f(p.u.uFar, frame.far);
    drawFullscreen(gl, stats);
  }

  // 分割表示の境界線
  drawDivider(x, canvasHeight, width) {
    const gl = this.gl;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.round(x - width / 2), 0, width, canvasHeight);
    gl.clearColor(0.95, 0.95, 1.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }
}
