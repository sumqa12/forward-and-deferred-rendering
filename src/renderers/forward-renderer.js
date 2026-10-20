import { RenderTargetSet } from '../core/gl-utils.js';
import { drawLightMarkers } from './light-markers.js';

// フォワードレンダリング:
//   [Zプリパス] → 不透明 (メッシュごとにライティング) → ライトマーカー → 半透明 (奥から順にブレンド) → [MSAA 解決]
export class ForwardRenderer {
  constructor(gl, objectPass, markerProgram) {
    this.gl = gl;
    this.name = 'Forward';
    this.objectPass = objectPass;
    this.markerProgram = markerProgram;
    this.targets = new RenderTargetSet(gl);
    this.key = '';
  }

  resize(width, height, samples) {
    const key = `${width}x${height}x${samples}`;
    if (key === this.key) return;
    this.key = key;
    const gl = this.gl;
    const t = this.targets;
    t.dispose();
    // MSAA はマルチサンプルのレンダーバッファにそのまま描くだけで使える (Forward の利点)
    this.colorTexture = t.texture(width, height, gl.RGBA16F, gl.LINEAR);
    if (samples > 0) {
      const color = t.renderbuffer(width, height, gl.RGBA16F, samples);
      const depth = t.renderbuffer(width, height, gl.DEPTH_COMPONENT24, samples);
      this.sceneFbo = t.framebuffer([color], depth);
      this.resolveFbo = t.framebuffer([this.colorTexture], null);
    } else {
      const depth = t.renderbuffer(width, height, gl.DEPTH_COMPONENT24);
      this.sceneFbo = t.framebuffer([this.colorTexture], depth);
      this.resolveFbo = null;
    }
  }

  render(frame, opts, timer, stats) {
    const gl = this.gl;
    const { width, height, scene } = frame;
    const heatmap = opts.view === 'heatmap';
    const samples = opts.msaa ? Math.min(4, gl.getParameter(gl.MAX_SAMPLES)) : 0;
    this.resize(width, height, samples);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, width, height);
    const bg = heatmap ? [0, 0, 0] : scene.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    if (opts.prepass) {
      timer.begin('forward:Zプリパス');
      this.objectPass.drawDepth(frame, frame.opaque, stats);
      timer.end();
    }

    timer.begin('forward:不透明+ライティング');
    this.objectPass.drawLit(frame, frame.opaque, {
      maxLights: opts.maxLightsPerPass, heatmap, transparent: false, depthEqual: opts.prepass,
    }, stats);
    timer.end();

    if (opts.markers && !heatmap) {
      drawLightMarkers(gl, this.markerProgram, frame, stats);
    }

    if (opts.transparent) {
      timer.begin('forward:半透明');
      this.objectPass.drawLit(frame, frame.transparent, {
        maxLights: opts.maxLightsPerPass, heatmap, transparent: true, depthEqual: false,
      }, stats);
      timer.end();
    }

    if (this.resolveFbo) {
      timer.begin('forward:MSAA解決');
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolveFbo);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      timer.end();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    stats.targetBytes = this.targets.bytes;
    stats.samples = samples;
    return { color: this.colorTexture, gbuffer: null };
  }
}
